// T-0685 (REQ-LED-001, REQ-ADM-002): a ledger correction is proposed by finance, approved by two other finance users, and
// executes as ONE reversing journal. Driven over the HTTP dispatcher and PGlite with staff tokens.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { staffPartyId, STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { createApp, type App } from '../app.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-01T09:00:00Z');
const acct = { usd: uuidv7(), usd2: uuidv7(), ils: uuidv7(), ils2: uuidv7() };

const token = (sub: string, roles: string[]) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (method: string, url: string, body: unknown, who: string, roles: string[] = ['finance'], headers: Record<string, string> = {}) =>
  dispatch(app, { method, url, headers: { authorization: `Bearer ${await token(who, roles)}`, ...headers }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const propose = (journalId: string, key: string, who = 'fin-1', reason = 'posted to the wrong wallet') => call('POST', '/v1/admin/ledger-corrections', { journalId, reason }, who, ['finance'], { 'idempotency-key': key });
const body = (r: { body?: unknown }) => r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A two-currency journal: USD and ILS legs, each balanced. */
async function journal(key: string): Promise<string> {
  const j = await app.services.ledger.post({
    idempotencyKey: key,
    kind: 'adjustment',
    postings: [
      { accountId: acct.usd, currency: 'USD', amountMinor: 12_345n },
      { accountId: acct.usd2, currency: 'USD', amountMinor: -12_345n },
      { accountId: acct.ils, currency: 'ILS', amountMinor: -4_000n },
      { accountId: acct.ils2, currency: 'ILS', amountMinor: 4_000n },
    ],
  });
  return j.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
  for (const [id, cur] of [[acct.usd, 'USD'], [acct.usd2, 'USD'], [acct.ils, 'ILS'], [acct.ils2, 'ILS']] as const) {
    await db.query(`insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ($1, null, 'partner_settlement', $2, 'D')`, [id, cur]);
  }
}, 60_000);
afterAll(async () => db.close());

describe('POST /v1/admin/ledger-corrections (T-0685)', () => {
  it('proposes with finance and an Idempotency-Key; others and a bad key are refused; a replay returns the same request', async () => {
    const jid = await journal('orig-propose');
    expect((await call('POST', '/v1/admin/ledger-corrections', { journalId: jid, reason: 'x' }, 'ops-1', ['ops'], { 'idempotency-key': 'key-propose-1' })).status).toBe(403);
    expect((await call('POST', '/v1/admin/ledger-corrections', { journalId: jid, reason: 'x' }, 'fin-1', ['finance'], { 'idempotency-key': 'short' })).status).toBe(422);
    expect((await call('POST', '/v1/admin/ledger-corrections', { journalId: jid, reason: '  ' }, 'fin-1', ['finance'], { 'idempotency-key': 'key-propose-1' })).status).toBe(422);
    expect((await propose(uuidv7(), 'key-propose-missing')).status).toBe(404);

    const r = await propose(jid, 'key-propose-1');
    expect(r.status).toBe(201);
    expect(body(r)).toMatchObject({ journalId: jid, reason: 'posted to the wrong wallet', status: 'awaiting_second_approval', required: 2, approvals: 0, requestedBy: staffPartyId('fin-1') });
    expect(body(r)['reversal']).toBeUndefined();
    const again = await propose(jid, 'key-propose-1');
    expect(body(again)['id']).toBe(body(r)['id']);
    expect((await propose(await journal('orig-other'), 'key-propose-1')).status).toBe(409); // the key belongs to another correction
  });

  it('the proposer cannot approve; the second distinct approval posts ONE balanced reversing journal and an audit entry', async () => {
    const jid = await journal('orig-exec');
    const id = body(await propose(jid, 'key-exec-0001'))['id'] as string;
    const before = await app.services.ledger.balance(acct.usd, 'USD');

    expect((await call('POST', `/v1/admin/ledger-corrections/${id}/approve`, undefined, 'fin-1')).status).toBe(403); // proposer
    expect((await call('POST', `/v1/admin/ledger-corrections/${id}/approve`, undefined, 'ops-9', ['ops'])).status).toBe(403); // not finance
    expect((await db.query('select 1 from ledger.journal where reverses_id = $1', [jid])).rowCount).toBe(0);

    const first = await call('POST', `/v1/admin/ledger-corrections/${id}/approve`, undefined, 'fin-2');
    expect(first.status).toBe(200);
    expect(body(first)).toMatchObject({ status: 'awaiting_second_approval', approvals: 1 });
    expect((await db.query('select 1 from ledger.journal where reverses_id = $1', [jid])).rowCount).toBe(0);
    expect((await call('POST', `/v1/admin/ledger-corrections/${id}/approve`, undefined, 'fin-2')).status).toBe(409); // one person decides once

    const second = await call('POST', `/v1/admin/ledger-corrections/${id}/approve`, undefined, 'fin-3');
    expect(second.status).toBe(200);
    expect(body(second)).toMatchObject({ status: 'approved', approvals: 2 });
    const rev = body(second)['reversal'] as { journalId: string; totals: { currency: string; minor: string }[] };
    expect(rev.totals).toEqual(expect.arrayContaining([{ currency: 'ILS', minor: '0' }, { currency: 'USD', minor: '0' }]));

    const row = await db.query<{ id: string; idempotency_key: string; reverses_id: string; kind: string }>('select id, idempotency_key, reverses_id, kind from ledger.journal where reverses_id = $1', [jid]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ id: rev.journalId, idempotency_key: `${id}:reverse`, reverses_id: jid });
    const postings = await db.query<{ account_id: string; amount_minor: string }>('select account_id, amount_minor::text from ledger.posting where journal_id = $1', [rev.journalId]);
    expect(Object.fromEntries(postings.rows.map((p) => [p.account_id, BigInt(p.amount_minor)]))).toEqual({ [acct.usd]: -12_345n, [acct.usd2]: 12_345n, [acct.ils]: 4_000n, [acct.ils2]: -4_000n });
    expect(await app.services.ledger.balance(acct.usd, 'USD')).toBe(before - 12_345n);
    // the original journal's rows were not touched
    expect((await db.query('select 1 from ledger.posting where journal_id = $1', [jid])).rowCount).toBe(4);

    const audit = (await app.services.audit.list(`journal:${jid}`)).filter((e) => e.action === 'ledger_correction.execute');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: staffPartyId('fin-3'), actorRole: 'finance', reason: 'posted to the wrong wallet', payload: { approvalId: id, reversalJournalId: rev.journalId } });

    // replay: no second journal, no second audit entry, the same reversal
    const replay = await call('POST', `/v1/admin/ledger-corrections/${id}/approve`, undefined, 'fin-4');
    expect(replay.status).toBe(200);
    expect((body(replay)['reversal'] as { journalId: string }).journalId).toBe(rev.journalId);
    expect((await app.services.audit.list(`journal:${jid}`)).filter((e) => e.action === 'ledger_correction.execute')).toHaveLength(1);
    expect((await call('POST', `/v1/admin/ledger-corrections/${id}/approve`, undefined, 'fin-1')).status).toBe(403); // the proposer still cannot
    expect(await app.services.ledger.reverse(jid, `${id}:reverse`)).toMatchObject({ id: rev.journalId }); // ledger-level replay of the same key
  });

  it('a journal already reversed answers IDEMPOTENCY_CONFLICT at the proposal and at the execution', async () => {
    const jid = await journal('orig-twice');
    const a = body(await propose(jid, 'key-twice-0001'))['id'] as string; // proposed before either executes
    const b = body(await propose(jid, 'key-twice-0002'))['id'] as string;
    for (const who of ['fin-2', 'fin-3']) await call('POST', `/v1/admin/ledger-corrections/${a}/approve`, undefined, who);
    const late = await propose(jid, 'key-twice-0003');
    expect(late.status).toBe(409);
    expect(body(late)['code']).toBe('IDEMPOTENCY_CONFLICT');
    await call('POST', `/v1/admin/ledger-corrections/${b}/approve`, undefined, 'fin-2');
    const second = await call('POST', `/v1/admin/ledger-corrections/${b}/approve`, undefined, 'fin-3');
    expect(second.status).toBe(409);
    expect(body(second)['code']).toBe('IDEMPOTENCY_CONFLICT');
    expect((await db.query('select 1 from ledger.journal where reverses_id = $1', [jid])).rowCount).toBe(1);
  });

  it('rejecting executes nothing and closes the request; the proposer may withdraw', async () => {
    const jid = await journal('orig-reject');
    const id = body(await propose(jid, 'key-reject-001'))['id'] as string;
    expect((await call('POST', `/v1/admin/ledger-corrections/${id}/reject`, {}, 'fin-2')).status).toBe(422); // a reason is required
    const rej = await call('POST', `/v1/admin/ledger-corrections/${id}/reject`, { reason: 'not needed' }, 'fin-2');
    expect(rej.status).toBe(200);
    expect(body(rej)).toMatchObject({ status: 'rejected' });
    expect((await call('POST', `/v1/admin/ledger-corrections/${id}/approve`, undefined, 'fin-3')).status).toBe(409);
    expect((await db.query('select 1 from ledger.journal where reverses_id = $1', [jid])).rowCount).toBe(0);

    const w = body(await propose(jid, 'key-reject-002'))['id'] as string;
    expect((await call('POST', `/v1/admin/ledger-corrections/${w}/reject`, { reason: 'withdrawn' }, 'fin-1')).status).toBe(200);
    expect((await db.query('select 1 from ledger.journal where reverses_id = $1', [jid])).rowCount).toBe(0);
  });

  it('an approval id of another kind is not a correction', async () => {
    const r = await call('POST', `/v1/admin/ledger-corrections/${uuidv7()}/approve`, undefined, 'fin-2');
    expect(r.status).toBe(404);
  });
});
