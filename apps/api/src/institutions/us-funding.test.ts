// TST-INS-024 fund the master account from the US account (T-0653, REQ-INS-024). A finance user asks for a quote and requests the funding; the
// person who asked cannot approve it, a second finance user can, with a step-up. The institution's own entity sends one ACH to Kesher's collection
// account with its KC- reference (a retried approval sends once), a platform sub-account books a transfer, a pooled one moves nothing; nothing is
// posted until the money arrives and the deposit path posts it, and then the request is received. A quote that lapsed is 409; a quote is spent once.
// A provider that is unavailable leaves the request for the sweep; a refusal opens a case; a return is shown. Cancel works until the bank sends.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { InstitutionBankingError, SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { decideKyb } from '../test-institution.ts';
import { paymentReference } from './deposits.ts';

let db: TestDatabase;
let main: App;
let pooled: App;
let host: SimulatorHost;
let pooledHost: SimulatorHost;
let collectionAccount = '';
const NOW = new Date('2026-11-03T09:00:00Z');
const LATER = new Date('2026-11-03T09:30:00Z');
const OWN = uuidv7(NOW);
const SUB = uuidv7(NOW);
const POOL = uuidv7(NOW);
const FRESH = uuidv7(NOW);
const IP = '198.51.100.4';
type Who = { app: App; partyId: string; access: string; stepUp: string };
const people: Record<string, Who> = {};
const sim = (h: SimulatorHost) => h.simulators['institution-banking'];
const usd = (minor: bigint) => ({ minor: minor.toString(), currency: 'USD' });

const call = (who: string, method: string, url: string, body?: unknown, opts: { key?: string; stepUp?: boolean; at?: Date } = {}) =>
  dispatch(people[who]!.app, {
    method,
    url: `/v1${url}`,
    headers: { authorization: `Bearer ${people[who]!.access}`, ...(opts.key ? { 'idempotency-key': opts.key } : {}), ...(opts.stepUp === false ? {} : { 'x-step-up': people[who]!.stepUp }) },
    rawBody: body === undefined ? '' : JSON.stringify(body),
    now: opts.at ?? NOW,
  });
const quote = (who: string, inst: string, minor: bigint, at?: Date) => call(who, 'POST', `/institutions/${inst}/us-funding/quote`, { amount: usd(minor) }, { stepUp: false, ...(at ? { at } : {}) });
const request = (who: string, inst: string, quoteId: string, key: string, at?: Date) => call(who, 'POST', `/institutions/${inst}/us-funding`, { quoteId }, { key, ...(at ? { at } : {}) });
const approve = (who: string, inst: string, id: string) => call(who, 'POST', `/institutions/${inst}/us-funding/${id}/approve`);
type View = { id: string; status: string; reference: string; achStatus?: string; depositId?: string; failure?: string; amount: { minor: string } };
const asked = async (who: string, inst: string, minor: bigint, key: string): Promise<View> => {
  const q = (await quote(who, inst, minor)).body as { quoteId: string };
  const r = await request(who, inst, q.quoteId, key);
  expect(r.status).toBe(201);
  return r.body as View;
};
const view = async (who: string, inst: string, id: string) => ((await call(who, 'GET', `/institutions/${inst}/us-funding`)).body as { items: View[] }).items.find((x) => x.id === id)!;

async function person(app: App, name: string, phone: string, roles: string[]): Promise<void> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  const access = (await s.tokens.issue({ partyId, deviceId: `web-${phone}`, roles })).accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  people[name] = { app, partyId, access, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}

async function platformEntity(h: SimulatorHost, legalName: string): Promise<string> {
  const { entityRef } = await sim(h).createEntity({ holder: 'platform', institutionId: uuidv7(NOW), legalName, ein: '98-7654321', idempotencyKey: 'platform-setup-0001' });
  sim(h).decide(entityRef);
  return entityRef;
}

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  pooledHost = new SimulatorHost();
  const flags = new StaticFlags(undefined, { 'institutions.usBanking': true, 'institutions.deposits': true, 'institutions.bankFeed': true });
  const base = { db, market: 'IL' as const, issuer: 'https://api.kesher.example', clock: () => NOW, flags };
  const platform = await platformEntity(host, 'holder_platform_subaccounts Israel Global Pay, LLC');
  collectionAccount = (await sim(host).createSubAccount({ entityRef: platform, institutionId: uuidv7(NOW), idempotencyKey: 'collection-acct-0001' })).subAccountRef;
  main = createApp({ ...base, registry: host.registry, signingKey: await generateSigningKey(), usBankingPlatformEntityRef: platform, usCollectionCounterpartyRef: 'cp_kesher', usCollectionAccountRef: collectionAccount });
  const pooledPlatform = await platformEntity(pooledHost, 'holder_platform_pooled Israel Global Pay, LLC');
  // Two simulator hosts in one database would mint the same ids, which the provider-id ownership check refuses: the pooled host starts later.
  for (let i = 0; i < 8; i++) await sim(pooledHost).createSubAccount({ entityRef: pooledPlatform, institutionId: uuidv7(NOW), idempotencyKey: `pad-${i}-0000` });
  pooled = createApp({ ...base, registry: pooledHost.registry, signingKey: await generateSigningKey(), usBankingPlatformEntityRef: pooledPlatform, usCollectionCounterpartyRef: 'cp_kesher', usCollectionAccountRef: collectionAccount });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Own Entity School', 'IL'), ($2, 'Sub Account School', 'IL'), ($3, 'Pooled School', 'IL'), ($4, 'Unlinked School', 'IL')`, [OWN, SUB, POOL, FRESH]);
  const staff = async (app: App, name: string, phone: string, inst: string, role: 'admin' | 'finance' | 'staff') => {
    await person(app, name, phone, ['member', `org_${role}`]);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)`, [people[name]!.partyId, inst, role]);
  };
  await staff(main, 'ownFin1', '+972501250001', OWN, 'finance');
  await staff(main, 'ownFin2', '+972501250002', OWN, 'finance');
  await staff(main, 'ownStaff', '+972501250003', OWN, 'staff');
  await staff(main, 'subFin1', '+972501250004', SUB, 'finance');
  await staff(main, 'subFin2', '+972501250005', SUB, 'finance');
  await staff(pooled, 'poolFin1', '+972501250006', POOL, 'finance');
  await staff(pooled, 'poolFin2', '+972501250007', POOL, 'finance');
  await staff(main, 'freshFin', '+972501250008', FRESH, 'finance');
  for (const inst of [OWN, SUB, POOL, FRESH]) await decideKyb(db, inst);
  // Own entity: linked and approved by the bank, holding money. Sub-account: linked under the platform, holding money. Pooled: shares the platform account.
  await main.services.usBanking.link(OWN, people['ownFin1']!.partyId, { holder: 'institution', usEntity: { legalName: 'American Friends of Own Entity School', ein: '12-3456789' } }, 'own-link-0001', IP, NOW);
  const ownRef = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_banking' and entity_id = $1`, [OWN])).rows[0]!.external_id;
  sim(host).decide(ownRef);
  sim(host).post(ownRef, 'credit', money(10_000_000n, 'USD'), 'Wire in');
  await main.services.usBanking.read(OWN, NOW);
  await main.services.usBanking.link(SUB, people['subFin1']!.partyId, { holder: 'platform' }, 'sub-link-0001', IP, NOW);
  const subRef = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_banking' and entity_id = $1`, [SUB])).rows[0]!.external_id;
  sim(host).post(subRef, 'credit', money(10_000_000n, 'USD'), 'Funded');
  await pooled.services.usBanking.link(POOL, people['poolFin1']!.partyId, { holder: 'platform' }, 'pool-link-0001', IP, NOW);
}, 300_000);
afterAll(async () => db.close());

const balance = (app: App, inst: string) => app.services.accounts.institutionBalance(inst, 'USD');
const financeActors = [{ partyId: uuidv7(NOW), role: 'finance' }, { partyId: uuidv7(NOW), role: 'finance' }];

describe('US funding (TST-INS-024, T-0653)', () => {
  it('only finance and admins quote; an unlinked account is refused; a quote is the fee, valid ten minutes', async () => {
    expect((await quote('ownStaff', OWN, 100_000n)).status).toBe(403);
    expect((await quote('freshFin', FRESH, 100_000n)).status).toBe(422);
    expect((await quote('ownFin1', OWN, 0n)).status).toBe(422);
    const q = await quote('ownFin1', OWN, 100_000n);
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ amount: usd(100_000n), fee: usd(0n), holder: 'institution', expiresAt: '2026-11-03T09:10:00.000Z' });
  });

  it('a request needs a step-up, a key and a quote that is ours, unspent and unexpired; the same key and quote answer the same request', async () => {
    const q = (await quote('ownFin1', OWN, 110_000n)).body as { quoteId: string };
    expect((await call('ownFin1', 'POST', `/institutions/${OWN}/us-funding`, { quoteId: q.quoteId }, { key: 'fund-key-0001', stepUp: false })).status).toBe(401);
    expect((await call('ownFin1', 'POST', `/institutions/${OWN}/us-funding`, { quoteId: q.quoteId }, { key: 'short' })).status).toBe(422);
    expect((await request('ownFin1', OWN, uuidv7(NOW), 'fund-key-0002')).status).toBe(404);
    const r = await request('ownFin1', OWN, q.quoteId, 'fund-key-0001');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'awaiting_approval', holder: 'institution', reference: paymentReference(OWN), amount: usd(110_000n) });
    expect((await request('ownFin1', OWN, q.quoteId, 'fund-key-0001')).body).toEqual(r.body);
    expect((await request('ownFin1', OWN, q.quoteId, 'fund-key-0003')).status).toBe(409);
    const q2 = (await quote('ownFin1', OWN, 111_000n)).body as { quoteId: string };
    expect((await request('ownFin1', OWN, q2.quoteId, 'fund-key-0001')).status).toBe(409);
    const stale = (await quote('ownFin1', OWN, 112_000n)).body as { quoteId: string };
    // The quote lapses (the step-up is only five minutes old, so the quote is expired in the table rather than the clock moved).
    await db.query(`update org.us_funding_quote set expires_at = $2 where id = $1`, [stale.quoteId, new Date(NOW.getTime() - 1000)]);
    const late = await request('ownFin1', OWN, stale.quoteId, 'fund-key-0004');
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.body)).toContain('QUOTE_EXPIRED');
  });

  it('the person who asked cannot approve; a second finance user does, one ACH goes to the collection account with the KC- reference, and a retried approval sends once', async () => {
    const send = vi.spyOn(sim(host), 'sendAch');
    const r = await asked('ownFin1', OWN, 200_000n, 'fund-key-0010');
    expect((await approve('ownFin1', OWN, r.id)).status).toBe(403);
    expect((await call('ownFin2', 'POST', `/institutions/${OWN}/us-funding/${r.id}/approve`, undefined, { stepUp: false })).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    const approved = await approve('ownFin2', OWN, r.id);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'in_transit', achStatus: 'pending', approvedBy: people['ownFin2']!.partyId });
    expect((await approve('ownFin2', OWN, r.id)).body).toMatchObject({ status: 'in_transit' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ counterpartyRef: 'cp_kesher', addenda: paymentReference(OWN), idempotencyKey: `us-fund:${OWN}:fund-key-0010`, amount: money(200_000n, 'USD') });
    // Nothing is posted by sending.
    expect(await balance(main, OWN)).toEqual(money(0n, 'USD'));
    send.mockRestore();
  });

  it('the bank\'s word on the ACH is shown; when the money arrives with the KC- reference and the deposit posts, the request is received', async () => {
    const r = ((await call('ownFin1', 'GET', `/institutions/${OWN}/us-funding`)).body as { items: View[] }).items.find((x) => x.amount.minor === '200000')!;
    const [{ external_id: paymentRef }] = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_funding' and entity_id = $1`, [r.id])).rows as [{ external_id: string }];
    await main.services.usFunding.onProviderAch(paymentRef, 'sent', NOW);
    await main.services.usFunding.onProviderAch(paymentRef, 'sent', NOW);
    expect(await view('ownFin1', OWN, r.id)).toMatchObject({ status: 'in_transit', achStatus: 'sent' });
    expect(await balance(main, OWN)).toEqual(money(0n, 'USD'));

    const credit = { creditId: 'bcr-own-1', rail: 'ach' as const, amount: money(200_000n, 'USD'), bankReference: 'FT2611-OWN1', remitterReference: `ACH CREDIT ${r.reference}`, valueDate: '2026-11-03' };
    expect(await main.services.deposits.applyBankCredit(credit, 'bank', LATER)).toMatchObject({ kind: 'posted' });
    expect(await balance(main, OWN)).toEqual(money(200_000n, 'USD'));
    expect(await view('ownFin1', OWN, r.id)).toMatchObject({ status: 'received', depositId: expect.any(String) });
    // The same credit again changes nothing.
    await main.services.deposits.applyBankCredit(credit, 'bank', LATER);
    expect(await balance(main, OWN)).toEqual(money(200_000n, 'USD'));
  });

  it('a request nobody has sent yet, or an ACH the bank still holds as pending, can be cancelled; one the bank has sent cannot', async () => {
    const waiting = await asked('ownFin1', OWN, 210_000n, 'fund-key-0020');
    expect((await call('ownFin2', 'POST', `/institutions/${OWN}/us-funding/${waiting.id}/cancel`)).body).toMatchObject({ status: 'cancelled' });
    expect((await call('ownFin2', 'POST', `/institutions/${OWN}/us-funding/${waiting.id}/cancel`)).status).toBe(409);

    const sent = await asked('ownFin1', OWN, 220_000n, 'fund-key-0021');
    await approve('ownFin2', OWN, sent.id);
    const cancelled = await call('ownFin1', 'POST', `/institutions/${OWN}/us-funding/${sent.id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', achStatus: 'cancelled' });

    const gone = await asked('ownFin1', OWN, 230_000n, 'fund-key-0022');
    await approve('ownFin2', OWN, gone.id);
    const ref = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_funding' and entity_id = $1`, [gone.id])).rows[0]!.external_id;
    sim(host).settleAch(ref);
    await main.services.usFunding.onProviderAch(ref, 'sent', NOW);
    expect((await call('ownFin1', 'POST', `/institutions/${OWN}/us-funding/${gone.id}/cancel`)).status).toBe(409);
  });

  it('a provider that is unavailable leaves the claim to go stale; the sweep sends it again under the same key, once', async () => {
    const send = vi.spyOn(sim(host), 'sendAch').mockRejectedValueOnce(new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'down'));
    const r = await asked('ownFin1', OWN, 240_000n, 'fund-key-0030');
    expect((await approve('ownFin2', OWN, r.id)).body).toMatchObject({ status: 'sending' });
    // A fresh claim is left alone; a cancel meanwhile is refused.
    expect(await main.services.usFunding.sweep('IL', new Date(NOW.getTime() + 60_000))).toMatchObject({ sent: 0 });
    expect((await call('ownFin1', 'POST', `/institutions/${OWN}/us-funding/${r.id}/cancel`)).status).toBe(409);
    const STALE = new Date(NOW.getTime() + 11 * 60_000);
    expect(await main.services.usFunding.sweep('IL', STALE)).toMatchObject({ sent: 1 });
    expect(await view('ownFin1', OWN, r.id)).toMatchObject({ status: 'in_transit', achStatus: 'pending' });
    expect(await main.services.usFunding.sweep('IL', STALE)).toMatchObject({ sent: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].idempotencyKey).toBe(send.mock.calls[1]![0].idempotencyKey);
    send.mockRestore();
  });

  it('an answer we cannot read stops the request for a person: needs_review, a case, and no resend', async () => {
    const send = vi.spyOn(sim(host), 'sendAch').mockRejectedValueOnce(new InstitutionBankingError('OUTCOME_UNKNOWN', 'unreadable'));
    const r = await asked('ownFin1', OWN, 270_000n, 'fund-key-0050');
    expect((await approve('ownFin2', OWN, r.id)).body).toMatchObject({ status: 'needs_review' });
    expect((await db.query(`select 1 from ops.case where kind = 'us_funding_failed' and payload->>'requestId' = $1`, [r.id])).rows).toHaveLength(1);
    await main.services.usFunding.sweep('IL', new Date(NOW.getTime() + 3 * 3_600_000));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await call('ownFin1', 'POST', `/institutions/${OWN}/us-funding/${r.id}/cancel`)).status).toBe(409);
    send.mockRestore();
  });

  it('a request still unsent after a day is stopped, not resent', async () => {
    const send = vi.spyOn(sim(host), 'sendAch').mockRejectedValue(new InstitutionBankingError('PROVIDER_UNAVAILABLE', 'down'));
    const r = await asked('ownFin1', OWN, 280_000n, 'fund-key-0051');
    await approve('ownFin2', OWN, r.id);
    await main.services.usFunding.sweep('IL', new Date(NOW.getTime() + 25 * 3_600_000));
    expect(await view('ownFin1', OWN, r.id)).toMatchObject({ status: 'needs_review' });
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRestore();
  });

  it('a refusal by the bank is final: failed, with a case; a return is shown and opens a case', async () => {
    const send = vi.spyOn(sim(host), 'sendAch').mockRejectedValueOnce(new InstitutionBankingError('REJECTED', 'closed'));
    const bad = await asked('ownFin1', OWN, 250_000n, 'fund-key-0040');
    expect((await approve('ownFin2', OWN, bad.id)).body).toMatchObject({ status: 'failed', failure: 'REJECTED' });
    send.mockRestore();
    expect((await db.query(`select 1 from ops.case where kind = 'us_funding_failed' and payload->>'requestId' = $1`, [bad.id])).rows).toHaveLength(1);

    const back = await asked('ownFin1', OWN, 260_000n, 'fund-key-0041');
    await approve('ownFin2', OWN, back.id);
    const ref = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_funding' and entity_id = $1`, [back.id])).rows[0]!.external_id;
    await main.services.usFunding.onProviderAch(ref, 'returned', NOW);
    expect(await view('ownFin1', OWN, back.id)).toMatchObject({ status: 'returned', achStatus: 'returned' });
    expect((await db.query(`select 1 from ops.case where kind = 'us_funding_failed' and payload->>'requestId' = $1`, [back.id])).rows).toHaveLength(1);
    // A late "sent" after a return changes nothing.
    await main.services.usFunding.onProviderAch(ref, 'sent', NOW);
    expect(await view('ownFin1', OWN, back.id)).toMatchObject({ status: 'returned' });
  });

  it('a platform sub-account books a transfer to the collection account and the deposit it records posts only when finance approves it', async () => {
    const book = vi.spyOn(sim(host), 'bookTransfer');
    const r = await asked('subFin1', SUB, 300_000n, 'fund-key-0050');
    const done = await approve('subFin2', SUB, r.id);
    expect(done.body).toMatchObject({ status: 'deposit_pending', depositId: expect.any(String) });
    expect(book).toHaveBeenCalledTimes(1);
    expect(book.mock.calls[0]![0]).toMatchObject({ toRef: collectionAccount, memo: paymentReference(SUB), idempotencyKey: `us-fund:${SUB}:fund-key-0050` });
    book.mockRestore();
    expect(await balance(main, SUB)).toEqual(money(0n, 'USD'));
    const depositId = (done.body as View).depositId!;
    for (const actor of financeActors) await main.services.deposits.approve(depositId, actor, LATER);
    expect(await balance(main, SUB)).toEqual(money(300_000n, 'USD'));
    expect(await view('subFin1', SUB, r.id)).toMatchObject({ status: 'received', depositId });
  });

  it('a pooled platform institution moves nothing at the bank: the request becomes a deposit for finance to approve', async () => {
    const psim = sim(pooledHost);
    const send = vi.spyOn(psim, 'sendAch');
    const book = vi.spyOn(psim, 'bookTransfer');
    const r = await asked('poolFin1', POOL, 400_000n, 'fund-key-0060');
    const done = await approve('poolFin2', POOL, r.id);
    expect(done.body).toMatchObject({ status: 'deposit_pending', depositId: expect.any(String) });
    expect(send).not.toHaveBeenCalled();
    expect(book).not.toHaveBeenCalled();
    expect(await balance(pooled, POOL)).toEqual(money(0n, 'USD'));
    for (const actor of financeActors) await pooled.services.deposits.approve((done.body as View).depositId!, actor, LATER);
    expect(await balance(pooled, POOL)).toEqual(money(400_000n, 'USD'));
    expect(await view('poolFin1', POOL, r.id)).toMatchObject({ status: 'received' });
  });

  it('with the institution\'s KYB not open the funding is refused with FEATURE_OFF, and nothing is written', async () => {
    const blocked = uuidv7(NOW);
    await db.query(`insert into org.institution (id, name, market) values ($1, 'Blocked School', 'IL')`, [blocked]);
    await person(main, 'blockedFin', '+972501250009', ['member', 'org_finance']);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'finance')`, [people['blockedFin']!.partyId, blocked]);
    await main.services.usBanking.link(blocked, people['blockedFin']!.partyId, { holder: 'platform' }, 'blocked-link-0001', IP, NOW);
    const q = await quote('blockedFin', blocked, 100_000n);
    expect(q.status).toBe(404);
    expect(JSON.stringify(q.body)).toContain('FEATURE_OFF');
    expect((await db.query('select 1 from org.us_funding_quote where institution_id = $1', [blocked])).rows).toHaveLength(0);
    expect((await db.query('select 1 from org.us_funding_request where institution_id = $1', [blocked])).rows).toHaveLength(0);
  });

  it('with the flag off every call answers 404 FEATURE_OFF', async () => {
    const flagsOff = createApp({ db, market: 'IL', issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(), registry: new SimulatorHost().registry, signingKey: await generateSigningKey() });
    await person(flagsOff, 'offFin', '+972501250010', ['member', 'org_finance']);
    const off = uuidv7(NOW);
    await db.query(`insert into org.institution (id, name, market) values ($1, 'Off School', 'IL')`, [off]);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'finance')`, [people['offFin']!.partyId, off]);
    for (const r of [await quote('offFin', off, 100_000n), await call('offFin', 'GET', `/institutions/${off}/us-funding`)]) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).toContain('FEATURE_OFF');
    }
  });
});
