// T-0614 institution deposits over the HTTP dispatcher and PGlite (TST-INS-007, REQ-INS-007): finance A
// records a bank transfer in and nothing moves; A cannot approve it; finance B approves and the institution's
// own account rises by exactly the amount, through a settled `deposit` transfer and its journal, and
// approving again is a no-op; the same
// rail and bank reference cannot post twice, for any institution; a rejected one posts nothing and frees
// its reference; Masav is shekels and ACH dollars; the monthly export reads the deposit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { paymentReference, type InstitutionDeposit } from './deposits.ts';
import { monthlyExport } from './export.ts';

let db: TestDatabase;
let app: App;
let off: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
const INST = uuidv7(NOW);
const OTHER = uuidv7(NOW);

const token = (sub: string, roles: string[]) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (a: App, who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(a, { method, url, headers: { authorization: `Bearer ${await token(who.sub, who.roles)}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const A = { sub: 'finance-a', roles: ['finance'] };
const B = { sub: 'finance-b', roles: ['finance'] };
const SUPPORT = { sub: 'support-1', roles: ['support'] };
const record = (who: typeof A, inst: string, body: Record<string, unknown>, key: string) => call(app, who, 'POST', `/v1/admin/institutions/${inst}/deposits`, { amount: { minor: '2000000', currency: 'ILS' }, rail: 'masav', bankReference: 'ft 2611-abc', valueDate: '2026-11-09', ...body }, key);
const balance = async (inst = INST, currency: 'ILS' | 'USD' = 'ILS') => (await app.services.accounts.institutionBalance(inst, currency)).minor;

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  const opts = { db, registry: new SimulatorHost().registry, market: 'IL' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'institutions.deposits': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags() });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL'), ($2, 'Day School', 'US')`, [INST, OTHER]);
}, 60_000);
afterAll(async () => db.close());

describe('institution deposits (T-0614, TST-INS-007)', () => {
  let first: InstitutionDeposit;

  it('A records ₪20,000 and nothing moves; A cannot approve; support cannot record; B approves and the account rises by exactly 2,000,000 agorot', async () => {
    const r = await record(A, INST, {}, 'dep-record-1');
    expect(r.status).toBe(201);
    first = r.body as InstitutionDeposit;
    expect(first).toMatchObject({ institutionId: INST, amount: { minor: '2000000', currency: 'ILS' }, rail: 'masav', bankReference: 'FT2611-ABC', valueDate: '2026-11-09', status: 'pending', approvals: 1, recordedByMe: true });
    expect(await balance()).toBe(0n);

    const self = await call(app, A, 'POST', `/v1/admin/deposits/${first.id}/approve`);
    expect([self.status, (self.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await record(SUPPORT, INST, { bankReference: 'other-1' }, 'dep-support-1')).status).toBe(403);
    expect(await balance()).toBe(0n);

    const approved = await call(app, B, 'POST', `/v1/admin/deposits/${first.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'posted', approvals: 2, recordedByMe: false, journalId: expect.any(String) });
    expect(await balance()).toBe(2_000_000n);

    // A money movement like any other: a settled `deposit` transfer carrying the journal, Dr partner_settlement, Cr the institution.
    const transfer = (await app.services.transfers.byKey(`deposit:${first.id}`))!;
    expect(transfer).toMatchObject({ kind: 'deposit', state: 'settled', toPartyId: INST, amount: money(2_000_000n, 'ILS'), journalId: (approved.body as InstitutionDeposit).journalId });
    const sides = (await db.query<{ type: string; owner: string; amount_minor: string }>(`select a.type::text, a.owner_party_id as owner, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id where p.journal_id = $1 order by a.type::text`, [transfer.journalId])).rows;
    expect(sides).toEqual([
      { type: 'institution_master', owner: INST, amount_minor: '-2000000' },
      { type: 'partner_settlement', owner: expect.any(String), amount_minor: '2000000' },
    ]);
    // Approving again is a no-op.
    expect((await call(app, B, 'POST', `/v1/admin/deposits/${first.id}/approve`)).body).toMatchObject({ status: 'posted', approvals: 2 });
    expect(await balance()).toBe(2_000_000n);
  });

  it('one statement line posts once: the same rail and reference, spelled differently or for another institution, answers 409; a replayed key answers the same deposit', async () => {
    const again = await record(A, OTHER, { bankReference: 'FT2611-ABC', amount: { minor: '2000000', currency: 'ILS' } }, 'dep-record-2');
    expect([again.status, (again.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await record(A, INST, {}, 'dep-record-1')).body).toMatchObject({ id: first.id, status: 'posted' });
    expect((await record(A, INST, { amount: { minor: '1', currency: 'ILS' } }, 'dep-record-1')).status).toBe(409);
    // The same reference on another rail is another line.
    expect((await record(A, INST, { rail: 'wire', amount: { minor: '100000', currency: 'ILS' } }, 'dep-record-3')).status).toBe(201);
  });

  it('a rejected deposit posts nothing, needs a reason, and frees its reference for the corrected record', async () => {
    const r = (await record(A, INST, { bankReference: 'W-777', rail: 'wire', amount: { minor: '50000', currency: 'ILS' } }, 'dep-wrong-1')).body as InstitutionDeposit;
    const before = await balance();
    expect((await call(app, B, 'POST', `/v1/admin/deposits/${r.id}/reject`, { reason: ' ' })).status).toBe(422);
    const rejected = await call(app, B, 'POST', `/v1/admin/deposits/${r.id}/reject`, { reason: 'Wrong amount: the statement says ₪5,000' });
    expect(rejected.body).toMatchObject({ status: 'rejected' });
    expect(await app.services.transfers.byKey(`deposit:${r.id}`)).toBeUndefined();
    expect(await balance()).toBe(before);
    expect((await call(app, B, 'POST', `/v1/admin/deposits/${r.id}/approve`)).status).toBe(409);
    const corrected = await record(A, INST, { bankReference: 'W-777', rail: 'wire', amount: { minor: '500000', currency: 'ILS' } }, 'dep-right-1');
    expect(corrected.body).toMatchObject({ status: 'pending', amount: { minor: '500000' } });
  });

  it('Masav carries shekels and ACH dollars; a future value date, a missing reference and an unknown institution are refused before anything is stored', async () => {
    expect((await record(A, OTHER, { rail: 'masav', amount: { minor: '100', currency: 'USD' }, bankReference: 'm-usd' }, 'dep-bad-1')).status).toBe(422);
    expect((await record(A, OTHER, { rail: 'ach', amount: { minor: '100', currency: 'ILS' }, bankReference: 'a-ils' }, 'dep-bad-2')).status).toBe(422);
    expect((await record(A, OTHER, { valueDate: '2026-11-11', bankReference: 'future' }, 'dep-bad-3')).status).toBe(422);
    expect((await record(A, OTHER, { bankReference: '  ' }, 'dep-bad-4')).status).toBe(422);
    expect((await record(A, uuidv7(NOW), { bankReference: 'nobody' }, 'dep-bad-5')).status).toBe(404);
    // A US school's ACH credit lands in its dollar account once B approves.
    const ach = (await record(A, OTHER, { rail: 'ach', amount: { minor: '1000000', currency: 'USD' }, bankReference: 'ACH-0042' }, 'dep-ach-1')).body as InstitutionDeposit;
    await call(app, B, 'POST', `/v1/admin/deposits/${ach.id}/approve`);
    expect(await balance(OTHER, 'USD')).toBe(1_000_000n);
    expect(await balance(OTHER, 'ILS')).toBe(0n);
  });

  it('approved but not yet posted (a crash between the two) posts on the next approve, once', async () => {
    const r = (await record(A, INST, { bankReference: 'CRASH-1', amount: { minor: '30000', currency: 'ILS' } }, 'dep-crash-1')).body as InstitutionDeposit;
    const approvalId = (await db.query<{ approval_id: string }>('select approval_id from ops.institution_deposit where id = $1', [r.id])).rows[0]!.approval_id;
    await app.services.approvals.decide(approvalId, { partyId: '00000000-0000-7000-8000-00000000b0b0', role: 'finance' }, 'approve', NOW);
    const before = await balance();
    expect((await call(app, B, 'POST', `/v1/admin/deposits/${r.id}/approve`)).body).toMatchObject({ status: 'posted' });
    expect((await call(app, B, 'POST', `/v1/admin/deposits/${r.id}/approve`)).body).toMatchObject({ status: 'posted' });
    expect(await balance()).toBe(before + 30_000n);
  });

  it('lists the deposits with the institution\'s payment reference and balances; the export reads the deposit; the flag off answers FEATURE_OFF', async () => {
    const list = (await call(app, SUPPORT, 'GET', `/v1/admin/institutions/${INST}/deposits`)).body as { paymentReference: string; balances: { minor: string; currency: string }[]; items: InstitutionDeposit[] };
    expect(list.paymentReference).toBe(paymentReference(INST));
    expect(list.paymentReference).toMatch(/^KC-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(paymentReference(OTHER)).not.toBe(list.paymentReference);
    expect(list.balances).toContainEqual({ minor: (await balance()).toString(), currency: 'ILS' });
    expect(list.items.map((i) => i.status)).toContain('rejected');

    const e = await monthlyExport(db, INST, '2026-11', 'ILS');
    expect(e.rows.find((x) => x.kind === 'deposit' && x.description === 'Deposit by masav: FT2611-ABC')).toMatchObject({ amount: money(2_000_000n, 'ILS') });
    expect(e.totals.depositsIn).toEqual(money(2_000_000n + 30_000n, 'ILS'));

    expect((await call(off, A, 'GET', `/v1/admin/institutions/${INST}/deposits`)).body).toMatchObject({ code: 'FEATURE_OFF' });
  });
});
