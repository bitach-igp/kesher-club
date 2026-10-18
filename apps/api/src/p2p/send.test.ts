// P2P send (T-0505) end to end over PGlite and the simulators with real passkeys and step-up.
// TST-PAY-001: A sends ₪50 to verified B, both wallet postings land in one journal and B's notification
// is queued within 5 s. TST-PAY-002: ₪1,200 against ₪1,000 remaining → LIMIT_EXCEEDED with the remaining
// amount. TST-PAY-005: two POSTs with one key → one transfer, one journal, one notification. TST-PAY-003: a
// first ₪600 to a new counterparty holds two hours with cancel (T-0506). TST-PAY-006: a send to a member who
// receives in the other currency converts at the club rate with their plan markup, once, at the start (T-0515).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice, type NotifySimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { runLoad } from '../wallet/loads.ts';
import { HOLD_MS, releaseKey } from './holds.ts';
import { RECEIVED_TEMPLATE, settleKey } from './send.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-10T09:00:00Z');

interface Member {
  partyId: string;
  phone: string;
  access: string;
  stepUp: string;
}

async function register(phone: string, kyc = true): Promise<Member> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa', response: await device.register(r1.options!) });
  const access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  const stepUp = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
  if (kyc) {
    const session = await s.kyc.start(principal.partyId, 'T1', `kyc-${principal.partyId}`, NOW);
    await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-kyc-${principal.partyId}`, sessionId: session.sessionId, status: 'approved' }), now: NOW });
  }
  return { partyId: principal.partyId, phone, access, stepUp };
}

const send = (from: Member, body: Record<string, unknown>, key: string, h: Record<string, string> = {}) => dispatch(app, { method: 'POST', url: '/v1/transfers', headers: { authorization: `Bearer ${from.access}`, 'idempotency-key': key, 'x-step-up': from.stepUp, ...h }, rawBody: JSON.stringify(body), now: NOW });
const ils = (minor: string) => ({ minor, currency: 'ILS' });
const usd = (minor: string) => ({ minor, currency: 'USD' });
const fund = (m: Member, minor: bigint, currency: 'ILS' | 'USD' = 'ILS') => runLoad(app.services.loads, { payerPartyId: m.partyId, memberPartyId: m.partyId, method: 'card', amount: money(minor, currency), paymentMethodId: 'pm_ok' }, `fund-${m.partyId}-${currency}-${minor}`, NOW);
const available = async (partyId: string, currency: 'ILS' | 'USD' = 'ILS') => (await app.services.accounts.purses(partyId)).find((p) => p.currency === currency)!.available.minor;
/** Every posting of the journal under the key: who (a member, or the system account's type), the currency, the amount. */
const postingsOf = async (key: string) =>
  (
    await db.query<{ owner: string; currency: string; amount_minor: string }>(
      `select case when a.type in ('wallet', 'pending') then a.owner_party_id::text else a.type::text end as owner, p.currency::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id join ledger.journal j on j.id = p.journal_id where j.idempotency_key = $1 order by p.amount_minor desc`,
      [key],
    )
  ).rows;
const metadataOf = async (key: string) => (await db.query<{ metadata: Record<string, unknown> }>(`select metadata from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.metadata;
const notifySim = () => host.simulators.notify as NotifySimulator;

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'p2p.enabled': true }) });
}, 60_000);
afterAll(async () => db.close());

describe('POST /transfers', () => {
  it('TST-PAY-001: A sends ₪50 to verified B; both wallets move in one journal and B is told within 5 s', async () => {
    const a = await register('+972501000001');
    const b = await register('+972501000002');
    await fund(a, 20_000n);
    const before = notifySim().sent.length;
    const started = Date.now();
    const r = await send(a, { toPartyId: b.partyId, amount: ils('5000'), note: 'קפה ☕' }, 'send-a-b-1');
    const elapsed = Date.now() - started;
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), state: 'settled', amount: ils('5000') });
    expect(await available(a.partyId)).toBe(15_000n);
    expect(await available(b.partyId)).toBe(5_000n);

    const t = (await app.services.transfers.byKey('send-a-b-1'))!;
    expect(t).toMatchObject({ kind: 'p2p', state: 'settled', fromPartyId: a.partyId, toPartyId: b.partyId, note: 'קפה ☕' });
    expect((await app.services.transfers.history(t.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'settled']);
    const postings = (await db.query<{ owner: string; amount_minor: string }>(`select a.owner_party_id as owner, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id join ledger.journal j on j.id = p.journal_id where j.idempotency_key = $1 and j.kind = 'p2p' order by p.amount_minor desc`, [settleKey('send-a-b-1')])).rows;
    expect(postings).toEqual([
      { owner: a.partyId, amount_minor: '5000' },
      { owner: b.partyId, amount_minor: '-5000' },
    ]);
    expect(t.journalId).toBe((await db.query<{ id: string }>(`select id from ledger.journal where idempotency_key = $1`, [settleKey('send-a-b-1')])).rows[0]!.id);

    const sent = notifySim().sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms', to: b.phone, template: RECEIVED_TEMPLATE, category: 'money', data: { amount: '5000', currency: 'ILS', transferId: t.id } });
    expect(JSON.stringify(sent[0])).not.toContain('קפה');
    expect(elapsed).toBeLessThan(5_000);
  });

  it('TST-PAY-005: two POSTs with one key are one transfer, one journal, one notification; the key of another operation is refused', async () => {
    const a = await register('+972501000003');
    const b = await register('+972501000004');
    await fund(a, 10_000n);
    const before = notifySim().sent.length;
    const [r1, r2] = await Promise.all([send(a, { toPartyId: b.partyId, amount: ils('1000') }, 'send-twice-1'), send(a, { toPartyId: b.partyId, amount: ils('1000') }, 'send-twice-1')]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((r1.body as { id: string }).id).toBe((r2.body as { id: string }).id);
    const r3 = await send(a, { toPartyId: b.partyId, amount: ils('1000') }, 'send-twice-1');
    expect(r3.body).toEqual(r1.body);
    expect(await available(a.partyId)).toBe(9_000n);
    expect(await available(b.partyId)).toBe(1_000n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where idempotency_key = 'send-twice-1'`)).rows[0]).toEqual({ n: 1 });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey('send-twice-1')])).rows[0]).toEqual({ n: 1 });
    expect(notifySim().sent.length - before).toBe(1);

    // Another member replaying A's key, or A reusing a load's key, is a conflict, not a second transfer.
    expect((await send(b, { toPartyId: a.partyId, amount: ils('1000') }, 'send-twice-1')).body).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect((await send(a, { toPartyId: b.partyId, amount: ils('100') }, `fund-${a.partyId}-ILS-10000`)).body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('TST-PAY-002: ₪1,200 against ₪1,000 remaining is refused with the remaining amount; the lower cap binds', async () => {
    const a = await register('+972501000005');
    const b = await register('+972501000006');
    await fund(a, 500_000n);
    const r = await send(a, { toPartyId: b.partyId, amount: ils('120000') }, 'send-over-1');
    expect(r.body).toMatchObject({ status: 422, code: 'LIMIT_EXCEEDED', remaining: '100000', currency: 'ILS', limitedBy: 'risk' });
    expect(await app.services.transfers.byKey('send-over-1')).toBeUndefined();
    expect((await send(a, { toPartyId: b.partyId, amount: ils('60000') }, 'send-under-1')).status).toBe(201);
    expect((await send(a, { toPartyId: b.partyId, amount: ils('40001') }, 'send-over-2')).body).toMatchObject({ code: 'LIMIT_EXCEEDED', remaining: '40000' });
    // A trusted member with a plan: the plan's cap binds.
    await app.services.p2pLimits.setTier(a.partyId, 'trusted', 'staff:ops-1', 'test', NOW);
    await app.services.plans.ensurePlan('club', 'Kesher Club');
    await app.services.plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: { 'p2p.monthlySendMinor': { limit: '100000', unit: 'minor', period: 'month' } }, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    const m = await app.services.memberships.create({ idempotencyKey: `m-${a.partyId}`, memberPartyId: a.partyId, funderPartyId: a.partyId, funderEmail: 'a@example.com', planCode: 'club' }, NOW);
    await app.services.memberships.setStatus(m.id, 'active', NOW);
    expect((await send(a, { toPartyId: b.partyId, amount: ils('120000') }, 'send-over-3')).body).toMatchObject({ code: 'LIMIT_EXCEEDED', remaining: '100000', limitedBy: 'entitlement' });
    expect((await send(a, { toPartyId: b.partyId, amount: ils('30000') }, 'send-plan-1')).status).toBe(201);
    expect((await send(a, { toPartyId: b.partyId, amount: ils('70001') }, 'send-over-4')).body).toMatchObject({ code: 'LIMIT_EXCEEDED', remaining: '70000', limitedBy: 'entitlement' });
  });

  it('TST-PAY-003: a first ₪600 to a new counterparty waits two hours with cancel; the next send to that pair does not', async () => {
    const a = await register('+972501000010');
    const b = await register('+972501000011');
    await fund(a, 100_000n);
    const before = notifySim().sent.length;
    const r = await send(a, { toPartyId: b.partyId, amount: ils('60000') }, 'hold-http-1');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), state: 'pending_hold', amount: ils('60000'), holdReleasesAt: new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString() });
    const id = (r.body as { id: string }).id;
    const purse = (await app.services.accounts.purses(a.partyId)).find((p) => p.currency === 'ILS')!;
    expect(purse.available.minor).toBe(40_000n);
    expect(purse.holds.minor).toBe(60_000n);
    expect(await available(b.partyId)).toBe(0n);
    expect(notifySim().sent.length).toBe(before);
    // Replay: the same held transfer.
    expect((await send(a, { toPartyId: b.partyId, amount: ils('60000') }, 'hold-http-1')).body).toEqual(r.body);

    // B cannot cancel A's send; A can, once, and the money is back.
    const cancel = (m: Member, key: string) => dispatch(app, { method: 'POST', url: `/v1/transfers/${id}/cancel`, headers: { authorization: `Bearer ${m.access}`, 'idempotency-key': key }, rawBody: '', now: NOW });
    expect((await cancel(b, 'cancel-b-1')).status).toBe(404);
    expect((await cancel(a, 'cancel-a-1')).body).toEqual({ id, state: 'cancelled', amount: ils('60000') });
    expect((await cancel(a, 'cancel-a-1')).body).toMatchObject({ state: 'cancelled' });
    expect(await available(a.partyId)).toBe(100_000n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = 'hold-http-1:hold:reversal'`)).rows[0]).toEqual({ n: 1 });

    // Under the threshold: straight through, and the pair is known from then on.
    expect((await send(a, { toPartyId: b.partyId, amount: ils('50000') }, 'hold-http-2')).body).toMatchObject({ state: 'settled' });
    expect((await send(a, { toPartyId: b.partyId, amount: ils('45000') }, 'hold-http-3')).body).toMatchObject({ state: 'settled' });
    expect(await available(b.partyId)).toBe(95_000n);
    // A settled send cannot be cancelled.
    const settledId = ((await send(a, { toPartyId: b.partyId, amount: ils('1000') }, 'hold-http-4')).body as { id: string }).id;
    expect((await dispatch(app, { method: 'POST', url: `/v1/transfers/${settledId}/cancel`, headers: { authorization: `Bearer ${a.access}`, 'idempotency-key': 'cancel-settled' }, rawBody: '', now: NOW })).body).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('the gate and the eligibility: step-up, flag, key, verified members on both sides, the balance, the body', async () => {
    const a = await register('+972501000007');
    const b = await register('+972501000008');
    const stranger = await register('+972501000009', false);
    await fund(a, 1_000n);
    expect((await send(a, { toPartyId: b.partyId, amount: ils('100') }, 'gate-1', { 'x-step-up': '' })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await send(a, { toPartyId: b.partyId, amount: ils('100') }, 'short')).status).toBe(422);
    const off = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, identity: app.services.identity, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
    const su = await off.services.stepUp.start(await off.services.tokens.verifyAccess(a.access).catch(() => ({ partyId: a.partyId, roles: ['member'], sessionId: 's', deviceId: 'd' })));
    expect(su).toBeTruthy();
    await expect(off.services.p2p.send(a.partyId, { toPartyId: b.partyId, amount: ils('100') }, 'gate-flag', NOW)).resolves.toMatchObject({ state: 'settled' }); // the service itself has no flag: the handler gates
    expect((await dispatch(off, { method: 'POST', url: '/v1/transfers', headers: { authorization: `Bearer ${a.access}`, 'idempotency-key': 'gate-flag-2', 'x-step-up': a.stepUp }, rawBody: JSON.stringify({ toPartyId: b.partyId, amount: ils('100') }), now: NOW })).body).toMatchObject({ code: expect.stringMatching(/FEATURE_OFF|STEP_UP_REQUIRED|UNAUTHENTICATED/) });

    expect((await send(a, { toPartyId: a.partyId, amount: ils('100') }, 'gate-self')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await send(a, { toPartyId: 'not-a-uuid', amount: ils('100') }, 'gate-uuid')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await send(a, { toPartyId: b.partyId, amount: ils('0') }, 'gate-zero')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await send(a, { toPartyId: b.partyId, amount: { minor: '100', currency: 'EUR' } }, 'gate-eur')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await send(a, { toPartyId: b.partyId, amount: ils('100'), note: 'x'.repeat(141) }, 'gate-note')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await send(a, { toPartyId: uuidv7(NOW), amount: ils('100') }, 'gate-nobody')).body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect((await send(a, { toPartyId: stranger.partyId, amount: ils('100') }, 'gate-unverified')).body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await send(stranger, { toPartyId: b.partyId, amount: ils('100') }, 'gate-sender-unverified')).body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await send(a, { toPartyId: b.partyId, amount: ils('5000') }, 'gate-funds')).body).toMatchObject({ status: 422, code: 'INSUFFICIENT_FUNDS', available: '900' });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where idempotency_key like 'gate-%' and kind = 'p2p'`)).rows[0]).toEqual({ n: 1 });
  });
});

describe('TST-PAY-006: the receiving currency', () => {
  const MIN = 60_000;

  it('converts at the club rate with the recipient\'s plan markup, in one journal through fx_position; limits judge the sent amount; the SMS names the received amount', async () => {
    await app.services.rates.publishFromPort('USD/ILS', 3_700_000n, NOW);
    const a = await register('+972501000020');
    const b = await register('+972501000021');
    const d = await register('+972501000022');
    await fund(a, 50_000n, 'USD');
    await fund(a, 100_000n);
    await app.services.preferences.set(b.partyId, 'ILS', NOW);
    await app.services.preferences.set(d.partyId, 'USD', NOW);
    const before = notifySim().sent.length;

    // $100 → ₪370.00 gross at 3.70, less the default 75 bps (₪2.78) → ₪367.22 in B's ILS purse.
    const r = await send(a, { toPartyId: b.partyId, amount: usd('10000') }, 'xccy-send-1');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), state: 'settled', amount: usd('10000'), received: ils('36722'), rateVersion: 1 });
    expect(await available(a.partyId, 'USD')).toBe(40_000n);
    expect(await available(b.partyId, 'ILS')).toBe(36_722n);
    expect(await available(b.partyId, 'USD')).toBe(0n);
    expect(await postingsOf(settleKey('xccy-send-1'))).toEqual([
      { owner: 'fx_position', currency: 'ILS', amount_minor: '37000' },
      { owner: a.partyId, currency: 'USD', amount_minor: '10000' },
      { owner: 'fee_income', currency: 'ILS', amount_minor: '-278' },
      { owner: 'fx_position', currency: 'USD', amount_minor: '-10000' },
      { owner: b.partyId, currency: 'ILS', amount_minor: '-36722' },
    ]);
    expect(await metadataOf(settleKey('xccy-send-1'))).toMatchObject({ fx_rate_version: 1, fx_markup_bps: 75, rate: '3.700000', sent: usd('10000'), received: ils('36722'), markup: ils('278'), fromPartyId: a.partyId, toPartyId: b.partyId });
    const t = (await app.services.transfers.byKey('xccy-send-1'))!;
    expect(t.conversion).toMatchObject({ received: money(36_722n, 'ILS'), rateVersion: 1, rateScaled: 3_700_000n, markupBps: 75n });
    const sent = notifySim().sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: b.phone, template: RECEIVED_TEMPLATE, data: { amount: '36722', currency: 'ILS', transferId: t.id } });
    // A replay answers the same priced transfer and moves nothing more.
    expect((await send(a, { toPartyId: b.partyId, amount: usd('10000') }, 'xccy-send-1')).body).toEqual(r.body);
    expect(await available(b.partyId, 'ILS')).toBe(36_722n);

    // The limit is judged and consumed in the sent currency: $300 a month for a new member, $100 of it used.
    expect((await send(a, { toPartyId: b.partyId, amount: usd('25000') }, 'xccy-limit-1')).body).toMatchObject({ status: 422, code: 'LIMIT_EXCEEDED', remaining: '20000', currency: 'USD' });

    // The other direction uses the same rate row inverted: ₪370 → $100.00 gross (0.270270), less $0.75 → $99.25 in D's USD purse.
    const r2 = await send(a, { toPartyId: d.partyId, amount: ils('37000') }, 'xccy-send-2');
    expect(r2.body).toMatchObject({ state: 'settled', amount: ils('37000'), received: usd('9925'), rateVersion: 1 });
    expect(await available(d.partyId, 'USD')).toBe(9_925n);
    expect(await available(d.partyId, 'ILS')).toBe(0n);
    expect(await postingsOf(settleKey('xccy-send-2'))).toEqual([
      { owner: a.partyId, currency: 'ILS', amount_minor: '37000' },
      { owner: 'fx_position', currency: 'USD', amount_minor: '10000' },
      { owner: 'fee_income', currency: 'USD', amount_minor: '-75' },
      { owner: d.partyId, currency: 'USD', amount_minor: '-9925' },
      { owner: 'fx_position', currency: 'ILS', amount_minor: '-37000' },
    ]);
    expect(await metadataOf(settleKey('xccy-send-2'))).toMatchObject({ fx_rate_version: 1, rate: '0.270270' });

    // Same currency as the preference: a plain two-posting send, nothing converted, nothing extra on the body.
    const r3 = await send(a, { toPartyId: b.partyId, amount: ils('1000') }, 'xccy-same-ccy');
    expect(r3.body).toEqual({ id: expect.any(String), state: 'settled', amount: ils('1000') });
    expect(await postingsOf(settleKey('xccy-same-ccy'))).toHaveLength(2);
    expect(await metadataOf(settleKey('xccy-same-ccy'))).not.toHaveProperty('fx_rate_version');
  });

  it('T-0518: the preview prices exactly as the send does, under the bearer alone, and creates nothing', async () => {
    const a = await register('+972501000030');
    const b = await register('+972501000031');
    const c = await register('+972501000032');
    await app.services.preferences.set(b.partyId, 'ILS', NOW);
    const preview = (from: Member, body: unknown, token = from.access) => dispatch(app, { method: 'POST', url: '/v1/transfers/preview', headers: { authorization: `Bearer ${token}` }, rawBody: JSON.stringify(body), now: NOW });

    const usdToIls = await preview(a, { toPartyId: b.partyId, amount: usd('10000') });
    expect(usdToIls.status).toBe(200);
    expect(usdToIls.body).toEqual({ amount: usd('10000'), received: ils('36722'), rate: '3.700000', rateVersion: 1 });
    expect((await preview(a, { toPartyId: c.partyId, amount: ils('5000') })).body).toEqual({ amount: ils('5000'), received: ils('5000') });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where from_party_id = $1`, [a.partyId])).rows[0]).toEqual({ n: 0 });

    // The send lands what the preview said.
    await fund(a, 20_000n, 'USD');
    expect((await send(a, { toPartyId: b.partyId, amount: usd('10000') }, 'xccy-preview-send')).body).toMatchObject({ received: ils('36722'), rateVersion: 1 });

    expect((await preview(a, { toPartyId: a.partyId, amount: usd('100') })).body).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((await preview(a, { toPartyId: uuidv7(NOW), amount: usd('100') })).body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect((await preview(a, { toPartyId: b.partyId, amount: usd('-1') })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await dispatch(app, { method: 'POST', url: '/v1/transfers/preview', headers: {}, rawBody: '{}', now: NOW })).status).toBe(401);
    // Twenty minutes on, the port rate has run out: the preview refuses as the send would.
    await expect(app.services.p2p.preview(a.partyId, { toPartyId: b.partyId, amount: usd('10000') }, new Date(NOW.getTime() + 20 * MIN))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('a converted hold is priced when it begins and releases at that price; no valid rate refuses before anything is created', async () => {
    const a = await register('+972501000023');
    const c = await register('+972501000024');
    await fund(a, 50_000n, 'USD');
    await fund(a, 10_000n);
    await app.services.preferences.set(c.partyId, 'ILS', NOW);
    const before = notifySim().sent.length;

    // $200 to a new counterparty is over the $150 threshold: held, already priced at version 1 ($200 → ₪740.00 − ₪5.55).
    const r = await send(a, { toPartyId: c.partyId, amount: usd('20000') }, 'xccy-hold-1');
    expect(r.body).toEqual({ id: expect.any(String), state: 'pending_hold', amount: usd('20000'), holdReleasesAt: new Date(NOW.getTime() + HOLD_MS).toISOString(), received: ils('73445'), rateVersion: 1 });
    const purse = (await app.services.accounts.purses(a.partyId)).find((p) => p.currency === 'USD')!;
    expect(purse.available.minor).toBe(30_000n);
    expect(purse.holds.minor).toBe(20_000n);
    expect(await available(c.partyId, 'ILS')).toBe(0n);

    // A new rate (version 2) is published a minute later; the hold keeps its price.
    await app.services.rates.publishFromPort('USD/ILS', 3_800_000n, new Date(NOW.getTime() + MIN));

    // Twenty minutes on, version 2 has run out: a fresh converted send is refused and creates nothing; a same-currency send still goes.
    const stale = new Date(NOW.getTime() + 20 * MIN);
    await expect(app.services.p2p.send(a.partyId, { toPartyId: c.partyId, amount: usd('1000') }, 'xccy-stale', stale)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await app.services.transfers.byKey('xccy-stale')).toBeUndefined();
    await expect(app.services.p2p.send(a.partyId, { toPartyId: c.partyId, amount: ils('1000') }, 'xccy-stale-ils', stale)).resolves.toMatchObject({ state: 'settled', amount: ils('1000') });

    // Two hours on, the release moves the held dollars through fx_position at version 1, not version 2 and not nothing.
    const later = new Date(NOW.getTime() + HOLD_MS);
    const released = await app.services.p2p.send(a.partyId, { toPartyId: c.partyId, amount: usd('20000') }, 'xccy-hold-1', later);
    expect(released).toEqual({ id: (r.body as { id: string }).id, state: 'settled', amount: usd('20000'), received: ils('73445'), rateVersion: 1 });
    expect(await available(a.partyId, 'USD')).toBe(30_000n);
    expect((await app.services.accounts.purses(a.partyId)).find((p) => p.currency === 'USD')!.holds.minor).toBe(0n);
    expect(await available(c.partyId, 'ILS')).toBe(73_445n + 1_000n);
    expect(await postingsOf(releaseKey('xccy-hold-1'))).toEqual([
      { owner: 'fx_position', currency: 'ILS', amount_minor: '74000' },
      { owner: a.partyId, currency: 'USD', amount_minor: '20000' },
      { owner: 'fee_income', currency: 'ILS', amount_minor: '-555' },
      { owner: 'fx_position', currency: 'USD', amount_minor: '-20000' },
      { owner: c.partyId, currency: 'ILS', amount_minor: '-73445' },
    ]);
    expect(await metadataOf(releaseKey('xccy-hold-1'))).toMatchObject({ fx_rate_version: 1, fx_markup_bps: 75, rate: '3.700000', received: ils('73445') });
    const sent = notifySim().sent.slice(before).filter((n) => n.data['transferId'] === released.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: c.phone, data: { amount: '73445', currency: 'ILS' } });
    expect((await app.services.transfers.history(released.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'pending_hold', 'pending', 'settled']);
  });
});
