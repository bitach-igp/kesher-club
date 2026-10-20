// T-0616 institution credit limits (TST-INS-008, REQ-INS-008): a limit is ₪0 until one admin proposes one and a
// second approves it, audited; ₪1,000 held with a ₪5,000 limit refuses a ₪7,000 run, preview included, saying
// what the account holds, the limit and what the run needs, and pays a ₪6,000 one, leaving −₪5,000; without a
// limit a run larger than the balance is refused; two runs started together on the last headroom pay once;
// payouts never use the credit line.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { DomainError, money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER, staffPartyId } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { decideKyb, verifiedPayoutAccount } from '../test-institution.ts';
import { PostgresAllowanceActivities } from './allowance/activities.ts';
import { run, workflowId } from './allowance/workflow.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
let activities: PostgresAllowanceActivities;
let financeToken: string;
const NOW = new Date('2026-11-10T09:00:00Z');
const FINANCE = uuidv7(NOW);

const staff = (sub: string) =>
  new SignJWT({ roles: ['admin'] }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (method: string, url: string, token: string, body?: unknown, key?: string) =>
  dispatch(app, { method, url, headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const balance = async (inst: string) => (await app.services.accounts.institutionBalance(inst, 'ILS')).minor;

async function institution(heldMinor: bigint): Promise<string> {
  const id = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [id]);
  await decideKyb(db, id);
  if (heldMinor > 0n) {
    const s = app.services;
    await s.ledger.post({ idempotencyKey: `fund:${id}:settle`, kind: 'deposit', effectiveAt: NOW, postings: [{ accountId: await s.accounts.systemAccount('partner_settlement', 'ILS'), currency: 'ILS', amountMinor: heldMinor }, { accountId: await s.accounts.institutionAccount(id, 'ILS'), currency: 'ILS', amountMinor: -heldMinor }], metadata: { institutionId: id } });
  }
  return id;
}

/** A schedule paying `amountMinor` to `count` new members of `inst`. */
async function schedule(inst: string, amountMinor: bigint, count: number): Promise<string> {
  const id = uuidv7();
  const members: string[] = [];
  for (let i = 0; i < count; i++) {
    const party = uuidv7();
    members.push(party);
    await app.services.accounts.provisionMember(party);
    await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, $3, $4, 'active')`, [uuidv7(), inst, `Student ${i}`, party]);
  }
  await db.query(`insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, member_filter, created_by) values ($1, $2, 'Weekly', $3, 'ILS', 'weekly', $4, $5)`, [id, inst, amountMinor.toString(), JSON.stringify(members), FINANCE]);
  return id;
}

/** Two admins set the limit over HTTP, as the console will. */
async function setLimit(inst: string, minor: bigint): Promise<void> {
  const proposed = await call('POST', `/v1/admin/institutions/${inst}/credit-limits`, await staff('admin-a'), { limit: { minor: minor.toString(), currency: 'ILS' }, reason: 'Board approved a term credit line' }, `limit-${inst}`);
  await call('POST', `/v1/admin/credit-limits/${(proposed.body as { request: { id: string } }).request.id}/approve`, await staff('admin-b'));
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(DomainError);
  return e as DomainError;
};

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW, flags: new StaticFlags(undefined, { 'institutions.money': true, 'payouts.nium': true }) });
  const s = app.services;
  activities = new PostgresAllowanceActivities(db, s.ledger, s.accounts, s.approvals, s.transfers, s.institutionCredit, () => NOW);
  financeToken = (await s.tokens.issue({ partyId: FINANCE, deviceId: 'web', roles: ['org_finance'] })).accessToken;
}, 60_000);
afterAll(async () => db.close());

describe('institution credit limits (T-0616, TST-INS-008)', () => {
  it('is ₪0 until a second admin approves: one proposal changes nothing, the proposer cannot approve it, and the change is audited', async () => {
    const inst = await institution(0n);
    const a = await staff('admin-a');
    const proposed = await call('POST', `/v1/admin/institutions/${inst}/credit-limits`, a, { limit: { minor: '500000', currency: 'ILS' }, reason: 'Pilot credit line' }, 'limit-pilot-1');
    expect(proposed.status).toBe(201);
    const req = (proposed.body as { request: { id: string; kind: string; status: string; approvals: number } }).request;
    expect(req).toMatchObject({ kind: 'credit_limit', status: 'awaiting_second_approval', approvals: 1 });
    expect((await app.services.institutionCredit.limit(inst, 'ILS')).minor).toBe(0n);
    const listed = (await call('GET', `/v1/admin/institutions/${inst}/credit-limits`, a)).body as { items: { currency: string; limit: { minor: string } }[]; pending: { id: string }[] };
    expect(listed.items.find((i) => i.currency === 'ILS')!.limit.minor).toBe('0');
    expect(listed.pending.map((p) => p.id)).toEqual([req.id]);
    // A retry answers the same proposal; the same key for another amount is a conflict.
    expect(((await call('POST', `/v1/admin/institutions/${inst}/credit-limits`, a, { limit: { minor: '500000', currency: 'ILS' }, reason: 'Pilot credit line' }, 'limit-pilot-1')).body as { request: { id: string } }).request.id).toBe(req.id);
    expect((await call('POST', `/v1/admin/institutions/${inst}/credit-limits`, a, { limit: { minor: '900000', currency: 'ILS' }, reason: 'Pilot credit line' }, 'limit-pilot-1')).status).toBe(409);
    expect((await call('POST', `/v1/admin/institutions/${inst}/credit-limits`, a, { limit: { minor: '-1', currency: 'ILS' }, reason: 'x' }, 'limit-pilot-2')).status).toBe(422);
    expect((await call('POST', `/v1/admin/institutions/${inst}/credit-limits`, a, { limit: { minor: '1', currency: 'ILS' }, reason: ' ' }, 'limit-pilot-3')).status).toBe(422);

    const self = await call('POST', `/v1/admin/credit-limits/${req.id}/approve`, a);
    expect([self.status, (self.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    const approved = await call('POST', `/v1/admin/credit-limits/${req.id}/approve`, await staff('admin-b'));
    expect(approved.body).toMatchObject({ request: { status: 'approved', approvals: 2 }, limit: { currency: 'ILS', limit: { minor: '500000', currency: 'ILS' } } });
    expect(await app.services.institutionCredit.limit(inst, 'ILS')).toEqual(money(500_000n, 'ILS'));
    expect((await app.services.institutionCredit.limit(inst, 'USD')).minor).toBe(0n);
    const trail = await app.services.audit.list(inst, 10);
    expect(trail.find((e) => e.action === 'institution.credit.set')).toMatchObject({ actorId: staffPartyId('admin-b'), payload: { currency: 'ILS', fromMinor: '0', toMinor: '500000', proposedBy: staffPartyId('admin-a'), approvedBy: staffPartyId('admin-b') } });
    expect(trail.map((e) => e.action)).toContain('institution.credit.propose');
    // A member token is refused.
    expect((await call('GET', `/v1/admin/institutions/${inst}/credit-limits`, financeToken)).status).toBe(403);
  });

  it('₪1,000 held with a ₪5,000 limit: a ₪7,000 run is refused, preview included, in words with the numbers; a ₪6,000 run pays and leaves −₪5,000', async () => {
    const inst = await institution(100_000n);
    await setLimit(inst, 500_000n);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'finance')`, [FINANCE, inst]);

    const big = await schedule(inst, 100_000n, 7);
    const preview = await dispatch(app, { method: 'POST', url: `/v1/institutions/${inst}/allowance-runs`, headers: { authorization: `Bearer ${financeToken}`, 'idempotency-key': `preview-${big}` }, rawBody: JSON.stringify({ scheduleId: big, date: '2026-11-10', dryRun: true }), now: NOW });
    expect(preview).toMatchObject({ status: 422, body: { code: 'INSUFFICIENT_FUNDS', balance: { minor: '100000', currency: 'ILS' }, creditLimit: { minor: '500000', currency: 'ILS' }, needed: { minor: '700000', currency: 'ILS' } } });
    expect((preview.body as { detail: string }).detail).toBe('The run needs ₪7,000.00; the account holds ₪1,000.00 with a credit limit of ₪5,000.00');
    // Over ₪5,000, so a second finance member asks too; the check that counts runs once both have approved.
    await expect(run(activities, big, '2026-11-10', FINANCE)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await refusal(run(activities, big, '2026-11-10', uuidv7()))).code).toBe('INSUFFICIENT_FUNDS');
    expect((await db.query(`select 1 from ops.transfer where kind = 'allowance' and idempotency_key like $1`, [`${workflowId(big, '2026-11-10')}:%`])).rowCount).toBe(0);
    expect(await balance(inst)).toBe(100_000n);
    await db.query('delete from org.staff where party_id = $1', [FINANCE]);

    const fits = await schedule(inst, 100_000n, 6);
    // ₪6,000 is over ₪5,000: a second finance member's request is the second approval (REQ-INS-004).
    await expect(run(activities, fits, '2026-11-10', FINANCE)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await run(activities, fits, '2026-11-10', uuidv7())).toMatchObject({ status: 'completed', paid: 6 });
    expect(await balance(inst)).toBe(-500_000n);
    // At the floor, nothing more goes out.
    const one = await schedule(inst, 100n, 1);
    expect((await refusal(run(activities, one, '2026-11-10', FINANCE))).code).toBe('INSUFFICIENT_FUNDS');
  });

  it('payouts never use the credit line: with ₪5,000 of credit and ₪0 held, a ₪1 payout is refused', async () => {
    const inst = await institution(0n);
    await setLimit(inst, 500_000n);
    await verifiedPayoutAccount(db, inst);
    const e = await refusal(app.services.payouts.request(inst, { payee: { iban: 'IL620108000000099999999', name: 'Building Supplies Ltd' }, amount: { minor: '100', currency: 'ILS' }, reference: 'roof' }, `payout-${inst}`, NOW, { kind: 'institution', requestedBy: FINANCE, requesterRole: 'finance' }));
    expect(e.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('without an approved limit, a run larger than the balance is refused and one within it pays', async () => {
    const inst = await institution(50_000n);
    const over = await schedule(inst, 20_000n, 3);
    const e = await refusal(run(activities, over, '2026-11-10', FINANCE));
    expect(e).toMatchObject({ code: 'INSUFFICIENT_FUNDS', extra: { creditLimit: { minor: '0', currency: 'ILS' }, needed: { minor: '60000', currency: 'ILS' } } });
    const within = await schedule(inst, 25_000n, 2);
    expect(await run(activities, within, '2026-11-10', FINANCE)).toMatchObject({ status: 'completed', paid: 2 });
    expect(await balance(inst)).toBe(0n);
  });

  it('two runs started together on the last headroom: one pays in full, the other is refused and pays nobody', async () => {
    const inst = await institution(400_000n);
    const [a, b] = [await schedule(inst, 100_000n, 3), await schedule(inst, 100_000n, 3)];
    const results = await Promise.allSettled([run(activities, a, '2026-11-10', FINANCE), run(activities, b, '2026-11-10', FINANCE)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect((lost.reason as DomainError).code).toBe('INSUFFICIENT_FUNDS');
    expect((await db.query(`select count(*)::int as n from ops.transfer where kind = 'allowance' and (idempotency_key like $1 or idempotency_key like $2)`, [`${workflowId(a, '2026-11-10')}:%`, `${workflowId(b, '2026-11-10')}:%`])).rows[0]).toEqual({ n: 3 });
    expect(await balance(inst)).toBe(100_000n);
  });

  it('a rerun of a run that stopped part-way needs only what it still owes', async () => {
    const inst = await institution(30_000n);
    const s = await schedule(inst, 10_000n, 3);
    // Two of three members already paid, as a run cut short would leave it: ₪100 left, and ₪100 owed.
    const wf = workflowId(s, '2026-11-10');
    const members = (await db.query<{ member_party_id: string }>('select member_party_id from org.member where institution_id = $1 order by member_party_id', [inst])).rows.map((r) => r.member_party_id);
    await activities.recordRun({ workflowId: wf, scheduleId: s, runDate: '2026-11-10', memberCount: 3, total: money(30_000n, 'ILS'), members: [], requiresSecondApproval: false }, 'running');
    for (const m of members.slice(0, 2)) {
      const key = `${wf}:${m}`;
      const { journalId } = await activities.payMember(wf, key, m, money(10_000n, 'ILS'));
      await activities.recordPayment(wf, m, key, 'paid', 1, journalId);
    }
    expect(await balance(inst)).toBe(10_000n);
    expect(await run(activities, s, '2026-11-10', FINANCE)).toMatchObject({ status: 'completed', paid: 3 });
    expect(await balance(inst)).toBe(0n);
  });
});
