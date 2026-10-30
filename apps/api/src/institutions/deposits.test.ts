// T-0614 institution deposits over the HTTP dispatcher and PGlite (TST-INS-007, REQ-INS-007): finance A
// records a bank transfer in and nothing moves; A cannot approve it; finance B approves and the institution's
// own account rises by exactly the amount, through a settled `deposit` transfer and its journal, and
// approving again is a no-op; the same
// rail and bank reference cannot post twice, for any institution; a rejected one posts nothing and frees
// its reference; Masav is shekels and ACH dollars; the monthly export reads the deposit.
// T-0618, the bank feed: a credit quoting one institution's payment reference posts at once, once, however often
// the bank says so; a line already recorded by hand does not post twice; a credit naming no institution, an unknown
// or a second one, in the wrong currency for its rail, or for an institution KYB blocks opens a suspense case and
// posts nothing; a forged notification is refused; with the feed off nothing happens.
// T-0631 (TST-INS-015, REQ-INS-015): a suspense credit is recorded against the institution from its case, nothing
// retyped; it posts on the second approval and the case resolves naming the deposit; the same credit cannot be
// recorded twice; the next reconciliation finds it recorded; only an open suspense case can be recorded this way.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import type { BankRail } from '@kesher/ports';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { decideKyb } from '../test-institution.ts';
import { normalizeReference, paymentReference, type InstitutionDeposit } from './deposits.ts';
import { monthlyExport } from './export.ts';

let db: TestDatabase;
let app: App;
let off: App;
let feed: App;
let host: SimulatorHost;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
const INST = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const BLOCKED = uuidv7(NOW);

const token = (sub: string, roles: string[]) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (a: App, who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(a, { method, url, headers: { authorization: `Bearer ${await token(who.sub, who.roles)}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const A = { sub: 'finance-a', roles: ['finance'] };
const B = { sub: 'finance-b', roles: ['finance'] };
const SUPPORT = { sub: 'support-1', roles: ['support'] };
const record = (who: typeof A, inst: string, body: Record<string, unknown>, key: string) => call(app, who, 'POST', `/v1/admin/institutions/${inst}/deposits`, { amount: { minor: '2000000', currency: 'ILS' }, rail: 'masav', bankReference: 'ft 2611-abc', valueDate: '2026-11-09', ...body }, key);
const balance = async (inst = INST, currency: 'ILS' | 'USD' = 'ILS') => (await app.services.accounts.institutionBalance(inst, currency)).minor;
type Hook = { headers: Record<string, string>; rawBody: string };
const deliver = (a: App, n: Hook) => dispatch(a, { method: 'POST', url: '/v1/hooks/bank', headers: n.headers, rawBody: n.rawBody, now: NOW });
const credit = (minor: bigint, remitterReference: string, over: { rail?: BankRail; currency?: 'ILS' | 'USD'; bankReference?: string } = {}) =>
  host.simulators.bank.credit({ rail: over.rail ?? 'masav', amount: money(minor, over.currency ?? 'ILS'), remitterReference, valueDate: '2026-11-09', ...(over.bankReference ? { bankReference: over.bankReference } : {}) });
const journals = async (inst: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where kind = 'deposit' and metadata->>'institutionId' = $1`, [inst])).rows[0]!.n;
const caseFor = async (creditId: string) => (await db.query<{ kind: string; payload: { reason: string } }>(`select kind, payload from ops.case where dedupe_key = $1`, [`bank-credit:bank:${creditId}`])).rows[0];

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  host = new SimulatorHost();
  const opts = { db, registry: host.registry, market: 'IL' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'institutions.deposits': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags() });
  feed = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags(undefined, { 'institutions.deposits': true, 'institutions.bankFeed': true }) });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL'), ($2, 'Day School', 'US')`, [INST, OTHER]);
  for (const i of [INST, OTHER]) await decideKyb(db, i);
  // No KYB decision yet: deposits are not open to it (T-0621).
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Not Yet Verified', 'IL')`, [BLOCKED]);
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

describe('the bank feed (T-0618, TST-INS-007)', () => {

  it('a ₪1,200.00 credit quoting the yeshiva\'s reference posts at once, once, however often the bank says so', async () => {
    const before = await balance();
    const journalsBefore = await journals(INST);
    const n = credit(120_000n, `Tuition Nov ${paymentReference(INST).toLowerCase()} thanks`);
    expect((await deliver(feed, n)).status).toBe(200);
    expect(await balance()).toBe(before + 120_000n);
    // The bank's retry of the same event, and a second notification for the same credit, change nothing.
    await deliver(feed, n);
    await deliver(feed, host.simulators.bank.notificationFor(n.credit.creditId));
    expect(await balance()).toBe(before + 120_000n);
    expect(await journals(INST)).toBe(journalsBefore + 1);
    const items = ((await call(app, A, 'GET', `/v1/admin/institutions/${INST}/deposits`)).body as { items: InstitutionDeposit[] }).items;
    expect(items.find((d) => d.bankReference === n.credit.bankReference)).toMatchObject({ status: 'posted', note: 'Bank feed', amount: { minor: '120000', currency: 'ILS' }, valueDate: '2026-11-09' });
    // The same statement line recorded by hand afterwards is refused: it is already the institution's.
    expect((await record(A, INST, { amount: { minor: '120000', currency: 'ILS' }, bankReference: n.credit.bankReference }, 'dep-after-feed-1')).status).toBe(409);
  });

  it('a line already recorded by hand does not post twice; the same line for another amount is suspense', async () => {
    const before = await balance();
    const journalsBefore = await journals(INST);
    expect((await deliver(feed, credit(2_000_000n, paymentReference(INST), { bankReference: 'FT2611-ABC' }))).status).toBe(200);
    expect([await balance(), await journals(INST)]).toEqual([before, journalsBefore]);
    const differs = credit(1_999_999n, paymentReference(INST), { bankReference: 'FT2611-ABC' });
    await deliver(feed, differs);
    expect(await caseFor(differs.credit.creditId)).toMatchObject({ kind: 'suspense', payload: { reason: 'amount_differs' } });
    expect(await balance()).toBe(before);
  });

  it('no reference, an unknown one, two, the wrong currency for the rail, or a KYB block: a suspense case and no journal, never a guess', async () => {
    const before = { inst: await balance(), other: await balance(OTHER, 'USD') };
    const cases: [ReturnType<typeof credit>, string][] = [
      [credit(5_000n, 'tuition, see email'), 'no_reference'],
      [credit(5_000n, 'KC-ZZZZZZZZ'), 'unknown_reference'],
      [credit(5_000n, `${paymentReference(INST)} ${paymentReference(OTHER)}`), 'ambiguous_reference'],
      [credit(5_000n, paymentReference(INST), { currency: 'USD' }), 'rail_currency'],
      [credit(5_000n, paymentReference(BLOCKED)), 'kyb_blocked'],
    ];
    for (const [n, reason] of cases) {
      expect((await deliver(feed, n)).status).toBe(200);
      expect(await caseFor(n.credit.creditId), reason).toMatchObject({ kind: 'suspense', payload: { reason, remitterReference: n.credit.remitterReference } });
    }
    expect({ inst: await balance(), other: await balance(OTHER, 'USD') }).toEqual(before);
    expect(await journals(BLOCKED)).toBe(0);
  });

  it('a forged notification is refused; with the feed off a credit moves nothing and opens nothing', async () => {
    const n = credit(7_000n, paymentReference(INST));
    expect((await deliver(feed, { ...n, headers: { 'x-sim-signature': 'forged' } })).status).toBe(401);
    const before = await balance();
    // The same notification the forger copied: a refused delivery claims nothing (T-0207).
    expect((await deliver(app, n)).status).toBe(200);
    expect(await balance()).toBe(before);
    expect(await caseFor(n.credit.creditId)).toBeUndefined();
  });
});

describe('a suspense credit recorded from its case (T-0631, TST-INS-015)', () => {
  const fromCase = (who: typeof A, inst: string, body: Record<string, unknown>, key: string) => call(app, who, 'POST', `/v1/admin/institutions/${inst}/deposits`, body, key);
  const caseRow = async (id: string) => (await db.query<{ status: string; resolution: string | null; payload: Record<string, unknown> }>('select status, resolution, payload from ops.case where id = $1', [id])).rows[0]!;
  const openCase = async (minor: bigint, remitter: string) => {
    const n = credit(minor, remitter);
    expect((await deliver(feed, n)).status).toBe(200);
    const id = (await db.query<{ id: string }>('select id from ops.case where dedupe_key = $1', [`bank-credit:bank:${n.credit.creditId}`])).rows[0]!.id;
    return { n, id };
  };

  it('a ₪5,000.00 Masav credit with no reference: A records it from the case, B approves, the account rises by 500,000 agorot and the case resolves naming the deposit; it cannot be recorded twice and the next reconciliation finds it recorded', async () => {
    const { n, id } = await openCase(500_000n, 'Tuition, see email');
    const before = await balance();
    const r = await fromCase(A, INST, { caseId: id, note: 'The parent emailed: Yeshivat Example tuition' }, 'dep-case-1');
    expect(r.status).toBe(201);
    const dep = r.body as InstitutionDeposit;
    expect(dep).toMatchObject({ institutionId: INST, amount: { minor: '500000', currency: 'ILS' }, rail: 'masav', bankReference: normalizeReference(n.credit.bankReference), valueDate: '2026-11-09', status: 'pending', approvals: 1 });
    expect(await caseRow(id)).toMatchObject({ status: 'investigating', payload: { depositId: dep.id, reason: 'no_reference' } });
    expect((await db.query<{ entity_id: string }>(`select entity_id from ops.external_ref where provider = 'bank' and external_id = $1`, [n.credit.creditId])).rows).toEqual([{ entity_id: dep.id }]);
    expect(await balance()).toBe(before);

    // The same credit again, from the case or typed by hand, for this institution or another: one statement line, one deposit.
    expect((await fromCase(A, OTHER, { caseId: id }, 'dep-case-2')).status).toBe(409);
    expect((await record(B, INST, { amount: { minor: '500000', currency: 'ILS' }, bankReference: n.credit.bankReference }, 'dep-case-3')).status).toBe(409);

    expect((await call(app, B, 'POST', `/v1/admin/deposits/${dep.id}/approve`)).body).toMatchObject({ status: 'posted', approvals: 2 });
    expect(await balance()).toBe(before + 500_000n);
    expect(await caseRow(id)).toMatchObject({ status: 'resolved', resolution: `Recorded as deposit ${dep.id}` });
    expect((await fromCase(A, INST, { caseId: id }, 'dep-case-4')).status).toBe(422);

    // The daily statement still carries the credit: it is the deposit already recorded, and opens nothing new.
    expect(await feed.services.deposits.applyBankCredit(n.credit, 'bank', NOW)).toEqual({ kind: 'already_recorded', depositId: dep.id });
    expect(await balance()).toBe(before + 500_000n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.case where payload->>'creditId' = $1`, [n.credit.creditId])).rows[0]!.n).toBe(1);
  });

  it('only an open suspense case can be recorded this way, and only as the credit it holds; a rejected recording frees the case', async () => {
    const other = uuidv7(NOW);
    await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'balance_break', $2, 'high', 'open', '{}', $3)`, [other, `t-0631:${other}`, NOW]);
    for (const caseId of [other, uuidv7(NOW), 'not-a-case']) {
      const r = await fromCase(A, INST, { caseId }, `dep-case-bad-${caseId}`);
      expect([r.status, (r.body as { code: string }).code], caseId).toEqual([422, 'VALIDATION_FAILED']);
    }
    const { id } = await openCase(30_000n, 'no reference here');
    expect((await fromCase(A, INST, { caseId: id, amount: { minor: '3000', currency: 'ILS' } }, 'dep-case-typo')).status).toBe(422);
    const dep = (await fromCase(A, INST, { caseId: id }, 'dep-case-5')).body as InstitutionDeposit;
    expect((await call(app, B, 'POST', `/v1/admin/deposits/${dep.id}/reject`, { reason: 'Wrong institution' })).body).toMatchObject({ status: 'rejected' });
    expect((await caseRow(id)).payload).not.toHaveProperty('depositId');
    const right = (await fromCase(A, OTHER, { caseId: id }, 'dep-case-6')).body as InstitutionDeposit;
    expect(right).toMatchObject({ institutionId: OTHER, status: 'pending' });
    expect(await caseRow(id)).toMatchObject({ status: 'investigating', payload: { depositId: right.id } });
  });
});
