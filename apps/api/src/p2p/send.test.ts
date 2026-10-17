// P2P send (T-0505) end to end over PGlite and the simulators with real passkeys and step-up.
// TST-PAY-001: A sends ₪50 to verified B, both wallet postings land in one journal and B's notification
// is queued within 5 s. TST-PAY-002: ₪1,200 against ₪1,000 remaining → LIMIT_EXCEEDED with the remaining
// amount. TST-PAY-005: two POSTs with one key → one transfer, one journal, one notification.
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
const fund = (m: Member, minor: bigint) => runLoad(app.services.loads, { payerPartyId: m.partyId, memberPartyId: m.partyId, method: 'card', amount: money(minor, 'ILS'), paymentMethodId: 'pm_ok' }, `fund-${m.partyId}-${minor}`, NOW);
const available = async (partyId: string) => (await app.services.accounts.purses(partyId)).find((p) => p.currency === 'ILS')!.available.minor;
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
    expect((await send(a, { toPartyId: b.partyId, amount: ils('100') }, `fund-${a.partyId}-10000`)).body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
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
