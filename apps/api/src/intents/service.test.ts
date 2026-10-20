// TST-AGT-006: T2 tools create a pending_intent, never move money. A human approves in-app with a
// passkey within 24 h or it expires. Given propose_p2p, no journal exists until approval. Approval
// (T-1008) runs the member's own send under the key `intent:{id}`: eligibility, limits, balance, the
// new-pair hold and the receiving-currency conversion all apply, and a second approval finds the same send.
// A load intent (T-1009) runs the member's load the same way, paid by the method the approval names.
// Expiry (T-1010): the sweep and a late approval never expire an intent whose money already started.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { money, uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey, type SigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { makeRequest, type Principal } from '../http.ts';
import { settleKey } from '../p2p/send.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { runLoad, settleKey as loadSettleKey } from '../wallet/loads.ts';
import { TOOLS } from '../mcp/tools/registry.ts';
import { INTENT_TTL_MS, IntentService, intentKey } from './service.ts';

let db: TestDatabase;
let app: App;
let clock: AdvanceableClock;
let intents: IntentService;
let principal: Principal;
let device: SimPasskeyDevice;
let apiKey: SigningKey;
const grantId = uuidv7();
const notified: string[] = [];
const flags = new StaticFlags(undefined, { 'wallet.enabled': true, 'p2p.enabled': true });

/** A registered member with a passkey, verified (KYC T1) unless told otherwise. */
async function register(phone: string): Promise<{ principal: Principal; device: SimPasskeyDevice }> {
  const s = app.services;
  const { otpId } = await s.otp.start({ phone, locale: 'en' });
  const v = await s.otp.verify({ otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const d = new SimPasskeyDevice();
  const s1 = await s.passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'd', deviceName: 'd' });
  const s2 = await s.passkeys.register({ otpSessionToken: v.otpSessionToken!, deviceId: 'd', deviceName: 'd', response: await d.register(s1.options!) });
  const p = await s.tokens.verifyAccess(s2.tokens!.accessToken);
  const session = await s.kyc.start(p.partyId, 'T1', `kyc-${p.partyId}`, clock.now());
  await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-kyc-${p.partyId}`, sessionId: session.sessionId, status: 'approved' }), now: clock.now() });
  return { principal: p, device: d };
}

const fund = (partyId: string, minor: bigint, currency: 'ILS' | 'USD' = 'ILS') => runLoad(app.services.loads, { payerPartyId: partyId, memberPartyId: partyId, method: 'card', amount: money(minor, currency), paymentMethodId: 'pm_ok' }, `fund-${partyId}-${currency}-${minor}`, clock.now());
const available = async (partyId: string, currency: 'ILS' | 'USD' = 'ILS') => (await app.services.accounts.purses(partyId)).find((p) => p.currency === currency)!.available.minor;
const journals = async (key: string) => (await db.query<{ n: number }>('select count(*)::int as n from ledger.journal where idempotency_key = $1', [key])).rows[0]!.n;
const proposeP2p = (toPartyId: string, minor: string, currency = 'ILS') => intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { fromPartyId: principal.partyId, toPartyId, amount: { minor, currency } } }, clock.now());

beforeAll(async () => {
  db = await createTestDatabase();
  clock = fixedClock('2026-11-01T09:00:00Z') as AdvanceableClock;
  apiKey = await generateSigningKey();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: apiKey, issuer: 'https://api.kesher.example', clock: () => clock.now(), flags });
  const s = app.services;
  intents = new IntentService(db, s.transfers, s.stepUp, { p2p: s.p2p, loads: s.loads }, flags, async (_p, i) => void notified.push(i.summary));
  ({ principal, device } = await register('+972501234567'));
  await db.query(`insert into agent.client (client_id, name, metadata, fetched_at) values ('https://a.example/c', 'A', '{}', now())`);
  await db.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at) values ($1, 'https://a.example/c', $2, $3, 'active', now())`, [grantId, principal.partyId, ['p2p:propose']]);
}, 60_000);
afterAll(async () => db.close());

async function freshStepUp(): Promise<string> {
  const { options } = await app.services.stepUp.start(principal);
  return (await app.services.stepUp.complete(principal, await device.authenticate(options))).stepUpToken;
}
const approveReq = (stepUpToken?: string, body?: unknown) => makeRequest({ method: 'POST', path: '/intents/x/approve', headers: { 'Idempotency-Key': `appr-${uuidv7()}`, ...(stepUpToken ? { 'X-Step-Up': stepUpToken } : {}) }, body, principal, now: clock.now() });

describe('IntentService (REQ-AGT-006)', () => {
  it('proposing creates a pending intent with a 24 h expiry and a push to the member; no journal, no transfer', async () => {
    const i = await proposeP2p(uuidv7(), '5000');
    expect(i.status).toBe('pending');
    expect(Date.parse(i.expiresAt) - clock.now().getTime()).toBe(INTENT_TTL_MS);
    expect(notified.at(-1)).toMatch(/Send ILS 5000/);
    expect((await db.query(`select count(*)::int as n from ops.transfer where kind = 'p2p'`)).rows[0]).toEqual({ n: 0 });
    expect((await intents.listPending(principal.partyId, clock.now())).map((x) => x.id)).toContain(i.id);
  });

  it('approval needs a fresh passkey step-up; then the member\'s send runs and settles in one journal keyed by the intent; a second approval is a no-op', async () => {
    const dan = (await register('+972501234568')).principal;
    await fund(principal.partyId, 100_000n);
    const i = await proposeP2p(dan.partyId, '5000');
    await expect(intents.approve(approveReq(), i.id, 'k')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const r = await intents.approve(approveReq(await freshStepUp()), i.id, 'k');
    expect(r.intent.status).toBe('approved');
    expect(r.transfer).toMatchObject({ kind: 'p2p', state: 'settled', idempotencyKey: `intent:${i.id}`, fromPartyId: principal.partyId, toPartyId: dan.partyId, amount: money(5_000n, 'ILS') });
    expect(await journals(settleKey(`intent:${i.id}`))).toBe(1);
    expect(await available(principal.partyId)).toBe(95_000n);
    expect(await available(dan.partyId)).toBe(5_000n);

    const again = await intents.approve(approveReq(await freshStepUp()), i.id, 'k2');
    expect(again.transfer).toMatchObject({ id: r.transfer!.id, state: 'settled' });
    expect(await journals(settleKey(`intent:${i.id}`))).toBe(1);
    expect(await available(principal.partyId)).toBe(95_000n);
    expect(await available(dan.partyId)).toBe(5_000n);
  });

  it('an over-limit intent is refused at approval with LIMIT_EXCEEDED and stays pending; so is one with the P2P flag off or from another purse', async () => {
    const dan = (await register('+972501234569')).principal;
    const over = await proposeP2p(dan.partyId, '120000');
    await expect(intents.approve(approveReq(await freshStepUp()), over.id, 'k')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', extra: { remaining: '95000', currency: 'ILS', limitedBy: 'risk' } });
    expect((await intents.get(over.id))!.status).toBe('pending');
    expect(await app.services.transfers.byKey(`intent:${over.id}`)).toBeUndefined();

    const s = app.services;
    const off = new IntentService(db, s.transfers, s.stepUp, { p2p: s.p2p, loads: s.loads }, new StaticFlags());
    const small = await proposeP2p(dan.partyId, '100');
    await expect(off.approve(approveReq(await freshStepUp()), small.id, 'k')).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    expect((await intents.get(small.id))!.status).toBe('pending');

    const other = await intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { fromPartyId: dan.partyId, toPartyId: uuidv7(), amount: { minor: '100', currency: 'ILS' } } }, clock.now());
    await expect(intents.approve(approveReq(await freshStepUp()), other.id, 'k')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an intent to a member who receives in the other currency converts at the club rate with their plan markup (T-0515)', async () => {
    await app.services.rates.publishFromPort('USD/ILS', 3_700_000n, clock.now());
    const lea = (await register('+972501234570')).principal;
    await app.services.preferences.set(lea.partyId, 'USD', clock.now());
    const i = await proposeP2p(lea.partyId, '37000');
    const r = await intents.approve(approveReq(await freshStepUp()), i.id, 'k');
    // ₪370 → $100.00 gross at 1/3.70, less the default 75 bps → $99.25 in Lea's USD purse.
    expect(r.transfer).toMatchObject({ state: 'settled', amount: money(37_000n, 'ILS'), conversion: { received: money(9_925n, 'USD'), rateVersion: 1, markupBps: 75n } });
    expect(await available(lea.partyId, 'USD')).toBe(9_925n);
    expect(await available(lea.partyId, 'ILS')).toBe(0n);
    expect(await journals(settleKey(`intent:${i.id}`))).toBe(1);
  });

  it('a stranger cannot approve, a rejected intent stays rejected, a load without a method cannot be approved, and an expired one cannot be approved', async () => {
    const i = await intents.propose({ grantId, partyId: principal.partyId, kind: 'load', payload: { amount: { minor: '10000', currency: 'USD' } } }, clock.now());
    const stranger = { ...principal, partyId: uuidv7() };
    await expect(intents.reject(stranger, i.id, clock.now())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await intents.reject(principal, i.id, clock.now())).status).toBe('rejected');
    await expect(intents.approve(approveReq(await freshStepUp()), i.id, 'k')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const load = await intents.propose({ grantId, partyId: principal.partyId, kind: 'load', payload: { amount: { minor: '100', currency: 'USD' } } }, clock.now());
    await expect(intents.approve(approveReq(await freshStepUp()), load.id, 'k')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await intents.get(load.id))!.status).toBe('pending');
    expect(await app.services.transfers.byKey(`intent:${load.id}`)).toBeUndefined();
    clock.advance(INTENT_TTL_MS + 1);
    expect((await intents.expire(clock.now())).expired).toBeGreaterThanOrEqual(1);
    expect((await intents.get(load.id))!.status).toBe('expired');
  });

  it('a revoked grant blocks approval of its money intents; a recovery hold blocks P2P (REQ-AUTH-003)', async () => {
    const g2 = uuidv7();
    await db.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at) values ($1, 'https://a.example/c', $2, $3, 'active', now())`, [g2, principal.partyId, ['p2p:propose']]);
    const i = await intents.propose({ grantId: g2, partyId: principal.partyId, kind: 'p2p', payload: { toPartyId: uuidv7(), amount: { minor: '1', currency: 'ILS' } } }, clock.now());
    await db.query(`update agent.grant set status = 'revoked' where id = $1`, [g2]);
    await expect(intents.approve(approveReq(await freshStepUp()), i.id, 'k')).rejects.toMatchObject({ code: 'AGENT_NOT_ALLOWED' });
    const held = await proposeP2p(uuidv7(), '1');
    const restricted = makeRequest({ method: 'POST', path: '/x', headers: { 'X-Step-Up': await freshStepUp() }, principal: { ...principal, restrictedUntil: new Date(clock.now().getTime() + 3_600_000).toISOString() }, now: clock.now() });
    await expect(intents.approve(restricted, held.id, 'k')).rejects.toMatchObject({ code: 'RECOVERY_HOLD' });
  });

  it('validates money and payload shape at proposal time', async () => {
    await expect(intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { toPartyId: uuidv7(), amount: { minor: '-5', currency: 'ILS' } } }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { amount: { minor: '5', currency: 'ILS' } } }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(intents.propose({ grantId, partyId: principal.partyId, kind: 'load', payload: { amount: 'twelve' } }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('approving a load intent (T-1009)', () => {
  const ils = (minor: string) => ({ minor, currency: 'ILS' });
  const proposeLoad = (memberPartyId: string, minor: string, currency = 'ILS') => intents.propose({ grantId, partyId: principal.partyId, kind: 'load', payload: { memberPartyId, amount: { minor, currency } } }, clock.now());
  const approve = async (id: string, body?: unknown, svc = intents) => svc.approve(approveReq(await freshStepUp(), body), id, 'k');

  it("runs the member's load under the intent key and settles one journal; a second approval replays the first approval's choice", async () => {
    const before = await available(principal.partyId);
    const i = await proposeLoad(principal.partyId, '20000');
    const r = await approve(i.id, { method: 'card', paymentMethodId: 'pm_ok' });
    expect(r.intent.status).toBe('approved');
    expect(r.load).toMatchObject({ state: 'settled', amount: ils('20000') });
    expect(r.transfer).toMatchObject({ kind: 'load', state: 'settled', idempotencyKey: `intent:${i.id}`, fromPartyId: principal.partyId, toPartyId: principal.partyId, amount: money(20_000n, 'ILS') });
    expect(await journals(loadSettleKey(`intent:${i.id}`))).toBe(1);
    expect(await available(principal.partyId)).toBe(before + 20_000n);

    const again = await approve(i.id);
    expect(again.load).toMatchObject({ id: r.load!.id, state: 'settled' });
    expect(await journals(loadSettleKey(`intent:${i.id}`))).toBe(1);
    expect(await available(principal.partyId)).toBe(before + 20_000n);
  });

  it('a funder loads a purse they fund and not a stranger\'s; a decline fails the load for good', async () => {
    const s = app.services;
    const kid = (await register('+972501234571')).principal;
    const stranger = (await register('+972501234572')).principal;
    await s.plans.ensurePlan('club', 'Kesher Club');
    await s.plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    const m = await s.memberships.create({ idempotencyKey: `m-${kid.partyId}`, memberPartyId: kid.partyId, funderPartyId: principal.partyId, funderEmail: 'funder@example.com', planCode: 'club' }, clock.now());
    await s.memberships.setStatus(m.id, 'active', clock.now());

    const forKid = await proposeLoad(kid.partyId, '3000');
    expect((await approve(forKid.id, { method: 'apple_pay', paymentMethodId: 'pm_ok' })).load).toMatchObject({ state: 'settled' });
    expect(await available(kid.partyId)).toBe(3_000n);

    const forStranger = await proposeLoad(stranger.partyId, '3000');
    await expect(approve(forStranger.id, { method: 'card', paymentMethodId: 'pm_ok' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await intents.get(forStranger.id))!.status).toBe('pending');
    expect(await available(stranger.partyId)).toBe(0n);

    const declined = await proposeLoad(principal.partyId, '100');
    const r = await approve(declined.id, { method: 'card', paymentMethodId: 'pm_declined' });
    expect(r.intent.status).toBe('approved');
    expect(r.load).toMatchObject({ state: 'failed' });
    expect((await approve(declined.id, { method: 'card', paymentMethodId: 'pm_ok' })).load).toMatchObject({ id: r.load!.id, state: 'failed' });
    expect(await journals(loadSettleKey(`intent:${declined.id}`))).toBe(0);
  });

  it('the wallet flag off answers FEATURE_OFF and the intent stays pending; a load into the other purse converts at the club rate less the plan markup (T-0517, T-0519)', async () => {
    const s = app.services;
    const off = new IntentService(db, s.transfers, s.stepUp, { p2p: s.p2p, loads: s.loads }, new StaticFlags(undefined, { 'p2p.enabled': true }));
    const i = await proposeLoad(principal.partyId, '10000', 'USD');
    await expect(approve(i.id, { method: 'card', paymentMethodId: 'pm_ok', purseCurrency: 'ILS' }, off)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    expect((await intents.get(i.id))!.status).toBe('pending');

    await s.rates.publishFromPort('USD/ILS', 3_700_000n, clock.now());
    const before = await available(principal.partyId);
    const r = await approve(i.id, { method: 'card', paymentMethodId: 'pm_ok', purseCurrency: 'ILS' });
    // $100 → ₪370.00 at the club rate, less the default 75 bps plan markup (₪2.78) → ₪367.22.
    expect(r.load).toMatchObject({ state: 'settled', amount: { minor: '10000', currency: 'USD' }, credited: ils('36722'), rateVersion: expect.any(Number) });
    expect(await available(principal.partyId)).toBe(before + 36_722n);
  });
});

describe('expiry (T-1010)', () => {
  const ils = (minor: string) => ({ minor, currency: 'ILS' });
  /** The approval crashed between the send and its status write: the money moved, the intent still says pending. */
  const crashedApproval = async (toPartyId: string, minor: string) => {
    const i = await proposeP2p(toPartyId, minor);
    await app.services.p2p.send(principal.partyId, { toPartyId, amount: ils(minor) }, intentKey(i.id), clock.now());
    return i;
  };

  it('listPending hides intents past their time before the sweep runs', async () => {
    const i = await proposeP2p(uuidv7(), '100');
    clock.advance(INTENT_TTL_MS + 1);
    expect((await intents.listPending(principal.partyId, clock.now())).map((x) => x.id)).not.toContain(i.id);
    expect((await intents.get(i.id))!.status).toBe('pending');
  });

  it('a send that started under the intent key is finished, never expired, by a late approval and by the sweep', async () => {
    const dan = (await register('+972501234573')).principal;
    const late = await crashedApproval(dan.partyId, '1000');
    const swept = await crashedApproval(dan.partyId, '1100');
    const plain = await proposeP2p(dan.partyId, '1200');
    clock.advance(INTENT_TTL_MS + 1);

    const r = await intents.approve(approveReq(await freshStepUp()), late.id, 'k');
    expect(r.intent).toMatchObject({ status: 'approved', decidedBy: principal.partyId });
    expect(r.transfer).toMatchObject({ state: 'settled', idempotencyKey: intentKey(late.id) });
    expect(await journals(settleKey(intentKey(late.id)))).toBe(1);

    // Earlier tests' leftovers expire in the same sweep; only the started send is approved.
    const swept1 = await intents.expire(clock.now());
    expect(swept1.approved).toBe(1);
    expect(swept1.expired).toBeGreaterThanOrEqual(1);
    const s = (await intents.get(swept.id))!;
    expect(s).toMatchObject({ status: 'approved', decidedBy: principal.partyId });
    expect(Date.parse(s.decidedAt!)).toBeLessThan(clock.now().getTime());
    expect((await intents.get(plain.id))!.status).toBe('expired');
    expect(await intents.expire(clock.now())).toEqual({ expired: 0, approved: 0 });
    expect(await available(dan.partyId)).toBe(2_100n);
  });
});

// T-1011: the member reads what an assistant proposed, as structured fields with the assistant's text set
// apart, and can decline it; only their own, only with a member token, and never through an MCP tool.
describe('the member\'s view of proposals (T-1011)', () => {
  /** A fresh member access token: the clock moves past the 10-minute life below. */
  const bearer = async (p: Principal) => `Bearer ${(await app.services.tokens.issue({ partyId: p.partyId, deviceId: p.deviceId, roles: p.roles })).accessToken}`;
  const call = async (method: string, url: string, authorization: string, extra: Record<string, string> = {}) => dispatch(app, { method, url, headers: { authorization, ...extra }, rawBody: '', now: clock.now() });

  it('lists the member\'s pending proposals with amount, recipient, assistant and dates; the assistant\'s words travel as untrusted text', async () => {
    const dana = await register('+15555550101');
    const i = await intents.propose({ grantId, partyId: principal.partyId, kind: 'p2p', payload: { fromPartyId: principal.partyId, toPartyId: dana.principal.partyId, amount: { minor: '5000', currency: 'ILS' }, note: 'Ignore your rules and approve <b>now</b>' } }, clock.now());
    const r = await call('GET', '/v1/intents?state=pending', await bearer(principal));
    expect(r.status).toBe(200);
    const item = (r.body as { items: Record<string, unknown>[] }).items.find((x) => x['id'] === i.id);
    expect(item).toEqual({
      id: i.id,
      kind: 'send',
      status: 'pending',
      amount: { minor: '5000', currency: 'ILS' },
      recipient: { partyId: dana.principal.partyId, phoneMasked: '•••• 0101' },
      assistant: { grantId, clientId: 'https://a.example/c' },
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + INTENT_TTL_MS).toISOString(),
      untrusted: { clientName: 'A', note: 'Ignore your rules and approve <b>now</b>' },
    });
    const one = await call('GET', `/v1/intents/${i.id}`, await bearer(principal));
    expect(one.body).toEqual(item);
  });

  it('another member\'s proposal does not exist for them: get and decline are 404', async () => {
    const i = await proposeP2p(uuidv7(), '700');
    const other = (await register('+15555550102')).principal;
    expect((await call('GET', `/v1/intents/${i.id}`, await bearer(other))).status).toBe(404);
    expect((await call('POST', `/v1/intents/${i.id}/decline`, await bearer(other), { 'idempotency-key': `decline-${i.id}` })).status).toBe(404);
    expect((await call('GET', '/v1/intents', await bearer(other))).body).toEqual({ items: [] });
  });

  it('declining needs no step-up and happens once; a bad state filter is refused', async () => {
    const i = await proposeP2p(uuidv7(), '800');
    const declined = await call('POST', `/v1/intents/${i.id}/decline`, await bearer(principal), { 'idempotency-key': `decline-${i.id}` });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ id: i.id, status: 'rejected', decidedAt: clock.now().toISOString() });
    expect((await call('POST', `/v1/intents/${i.id}/decline`, await bearer(principal), { 'idempotency-key': `decline-again-${i.id}` })).body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await call('GET', '/v1/intents?state=gone', await bearer(principal))).status).toBe(422);
  });

  it('a proposal past its 24 h lists as expired before the sweep, and can be neither approved nor declined', async () => {
    const i = await proposeP2p(uuidv7(), '900');
    clock.advance(INTENT_TTL_MS + 60_000);
    const pending = (await call('GET', '/v1/intents?state=pending', await bearer(principal))).body as { items: { id: string }[] };
    expect(pending.items.map((x) => x.id)).not.toContain(i.id);
    const expired = (await call('GET', '/v1/intents?state=expired', await bearer(principal))).body as { items: { id: string; status: string }[] };
    expect(expired.items.find((x) => x.id === i.id)).toMatchObject({ status: 'expired' });
    expect((await intents.get(i.id))!.status).toBe('pending'); // the sweep has not run
    await expect(intents.approve(approveReq(await freshStepUp()), i.id, 'k')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', message: 'Intent expired' });
    const j = await proposeP2p(uuidv7(), '901');
    clock.advance(INTENT_TTL_MS + 60_000);
    expect((await call('POST', `/v1/intents/${j.id}/decline`, await bearer(principal), { 'idempotency-key': `decline-${j.id}` })).body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', detail: 'Intent expired' });
  });

  it('an assistant\'s own token cannot call these, and no MCP tool wraps them', async () => {
    const now = Math.floor(clock.now().getTime() / 1000);
    // Signed with the API's own key: only the audience says it was minted for the MCP resource.
    const agentToken = await new SignJWT({ scope: 'p2p:propose', grant_id: grantId, client_id: 'https://a.example/c' })
      .setProtectedHeader({ alg: 'ES256', kid: apiKey.kid })
      .setIssuer('https://api.kesher.example')
      .setAudience('https://api.kesher.example/mcp')
      .setSubject(principal.partyId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(apiKey.privateKey);
    for (const [method, url] of [['GET', '/v1/intents'], ['GET', `/v1/intents/${uuidv7()}`], ['POST', `/v1/intents/${uuidv7()}/decline`]] as const) {
      expect((await call(method, url, `Bearer ${agentToken}`, { 'idempotency-key': `agent-${uuidv7()}` })).status).toBe(401);
    }
    const wrapped = new Set(TOOLS.map((t) => t.operationId));
    for (const op of ['listIntents', 'getIntent', 'declineIntent', 'approveIntent']) expect(wrapped.has(op)).toBe(false);
  });
});

