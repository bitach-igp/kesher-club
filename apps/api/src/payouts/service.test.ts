// Payouts (T-0510, REQ-PO-001/002) end to end over PGlite and the payout simulator with real passkeys
// and step-up. TST-PO-001: payee validation at the API and the bank. TST-PO-002: a new payee at ₪3,000
// is scheduled +24 h in cooling_off with nothing moved; amounts over the two-person threshold wait in
// awaiting_second_approval; a settled webhook settles once; a failed webhook reverses the journal once
// and queues a push to the payer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock, type NotifySimulator, type PayoutSimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { runLoad } from '../wallet/loads.ts';
import { COOL_OFF_MS, runPayout, settleKey, type PayoutView } from './service.ts';

const seedTransfer = (db: { query: (t: string, p?: readonly unknown[]) => Promise<unknown> }, f: { id: string; kind: string; state: string; market: string; at: Date }) =>
  db.query(
    `insert into ops.transfer (id, idempotency_key, kind, to_party_id, amount_minor, currency, state, hold_releases_at, market, created_at, updated_at) values ($1, $2, $3, $4, 100, 'USD', $5, $6, $7, $6, $6)`,
    [f.id, `seed-${f.id}`, f.kind, f.id, f.state, f.at, f.market],
  );

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;
let member = '';
let access = '';
let stepUpToken = '';
let device: SimPasskeyDevice;
const IL = 'IL620108000000099999999';
const IL2 = 'IL070108000000012345678';
const IL3 = 'IL460108000000087654321';

const advance = (ms: number) => {
  host.clock.advance(ms);
  now = new Date(now.getTime() + ms);
};
/** A day on, the bearer and the step-up have expired: sign in again with the same passkey. */
async function signInAgain() {
  const s = app.services;
  const a1 = await s.passkeys.authenticate({ deviceId: 'iphone-1' });
  const a2 = await s.passkeys.authenticate({ deviceId: 'iphone-1', response: await device.authenticate(a1.options!) });
  access = a2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  stepUpToken = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
}
const call = (method: string, url: string, body?: unknown, h: Record<string, string> = {}) => dispatch(app, { method, url, headers: { authorization: `Bearer ${access}`, ...h }, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const payout = (body: Record<string, unknown>, key: string, h: Record<string, string> = {}) => call('POST', '/v1/payouts', { payee: { iban: IL, name: 'Yeshivat Example' }, amount: { minor: '100000', currency: 'ILS' }, reference: 'tuition', ...body }, { 'idempotency-key': key, 'x-step-up': stepUpToken, ...h });
const hook = (w: { headers: Record<string, string>; rawBody: string }) => dispatch(app, { method: 'POST', url: '/v1/hooks/payout', headers: w.headers, rawBody: w.rawBody, now });
const available = async () => (await app.services.accounts.purses(member)).find((p) => p.currency === 'ILS')!.available.minor;
const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.n;
const vendorPayoutOf = async (transferId: string) => (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'transfer' and provider = 'simulator' and entity_id = $1`, [transferId])).rows[0]?.external_id;
const sim = () => host.simulators.payout as PayoutSimulator;
const notifySim = () => host.simulators.notify as NotifySimulator;

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost(fixedClock(NOW.toISOString()) as AdvanceableClock);
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now, flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'payouts.nium': true }) });
  const s = app.services;
  const started = await s.otp.start({ phone: '+972507000001', locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa', response: await device.register(r1.options!) });
  access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  member = principal.partyId;
  const su = await s.stepUp.start(principal);
  stepUpToken = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
  await s.identity.upsertDevice({ partyId: member, deviceId: 'iphone-1', firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), pushToken: 'ExponentPushToken[noa]' });
  await runLoad(s.loads, { payerPartyId: member, memberPartyId: member, method: 'card', amount: money(2_000_000n, 'ILS'), paymentMethodId: 'pm_ok' }, 'po-fund', now);
}, 60_000);
afterAll(async () => db.close());

describe('TST-PO-001: the payee', () => {
  it('refuses a bad checksum, a foreign account, a missing name and a name the bank does not know, before any money', async () => {
    expect((await payout({ payee: { iban: 'IL630108000000099999999', name: 'X Y' } }, 'po-bad-1')).body).toMatchObject({ code: 'VALIDATION_FAILED', problems: ['IBAN_CHECKSUM'] });
    expect((await payout({ payee: { iban: 'DE89370400440532013000', name: 'X Y' } }, 'po-bad-2')).body).toMatchObject({ code: 'VALIDATION_FAILED', problems: ['NOT_ISRAELI'] });
    expect((await payout({ payee: { iban: IL, name: '' } }, 'po-bad-3')).body).toMatchObject({ code: 'VALIDATION_FAILED', problems: ['NAME_REQUIRED'] });
    expect((await payout({ payee: { iban: IL, name: 'WRONG NAME' } }, 'po-bad-4')).body).toMatchObject({ code: 'VALIDATION_FAILED', problems: ['NAME_MISMATCH'] });
    expect((await payout({ amount: { minor: '100', currency: 'USD' } }, 'po-bad-5')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await payout({ reference: '' }, 'po-bad-6')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await payout({ amount: { minor: '100000000', currency: 'ILS' } }, 'po-bad-7')).body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect((await payout({}, 'po-bad-8', { 'x-step-up': '' })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where kind = 'payout'`)).rows[0]).toEqual({ n: 0 });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.payee`)).rows[0]).toEqual({ n: 0 });
  });
});

describe('TST-PO-002: cooling off, approval, settlement and reversal', () => {
  it('a new payee at ₪3,000 is scheduled +24 h in cooling_off with nothing moved; the worker-side resume submits it after 24 h', async () => {
    const r = await payout({ amount: { minor: '300000', currency: 'ILS' } }, 'po-cool-1');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), state: 'cooling_off', amount: { minor: '300000', currency: 'ILS' }, scheduledFor: new Date(NOW.getTime() + COOL_OFF_MS).toISOString() });
    const id = (r.body as PayoutView).id;
    expect(await available()).toBe(2_000_000n);
    expect(await journals(settleKey('po-cool-1'))).toBe(0);
    expect((await db.query<{ n: number; last4: string }>(`select count(*)::int as n, min(iban_last4) as last4 from ops.payee where party_id = $1`, [member])).rows[0]).toEqual({ n: 1, last4: '9999' });
    // Replay: the same held payout.
    expect((await payout({ amount: { minor: '300000', currency: 'ILS' } }, 'po-cool-1')).body).toMatchObject({ id, state: 'cooling_off' });
    // Before the time: the resume leaves it; at the time: the journal posts and the rail is asked.
    advance(COOL_OFF_MS - 1);
    expect(await app.services.payouts.resumable(now)).toEqual([]);
    advance(1);
    await signInAgain();
    const due = await app.services.payouts.resumable(now);
    expect(due.map((t) => t.id)).toEqual([id]);
    const run = await runPayout(app.services.payouts, await app.services.payouts.inputFor(due[0]!), 'po-cool-1', now);
    expect(run).toMatchObject({ replayed: true, transfer: { state: 'pending' } }); // past the hold; the rail's webhook settles it
    expect(run.waiting).toBeUndefined();
    expect(run.transfer.journalId).toBeDefined();
    expect(await available()).toBe(1_700_000n);
    expect(await journals(settleKey('po-cool-1'))).toBe(1);
    expect(await vendorPayoutOf(id)).toMatch(/^po_/);
    expect((await app.services.payouts.view((await app.services.transfers.get(id))!)).state).toBe('processing');
    // The rail settles: once, however many notices; the payee is now known.
    const po = (await vendorPayoutOf(id))!;
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    const t = (await app.services.transfers.get(id))!;
    expect(t.state).toBe('settled');
    expect((await app.services.transfers.history(id)).map((e) => e.to)).toEqual(['created', 'submitted', 'pending_hold', 'pending', 'settled']);
    expect((await db.query<{ first_settled_at: string | null }>(`select first_settled_at from ops.payee where party_id = $1`, [member])).rows[0]!.first_settled_at).not.toBeNull();
    // The second payout to that payee at ₪3,000 does not cool off.
    const again = await payout({ amount: { minor: '300000', currency: 'ILS' } }, 'po-known-1');
    expect(again.body).toMatchObject({ state: 'processing' });
    expect(await available()).toBe(1_400_000n);
  });

  it('₪2,000 exactly to a new payee goes straight to the rail; a failed webhook reverses the journal once and pushes to the payer', async () => {
    const before = notifySim().sent.length;
    const r = await payout({ payee: { iban: IL2, name: 'FAIL' }, amount: { minor: '200000', currency: 'ILS' } }, 'po-fail-1');
    expect(r.body).toMatchObject({ state: 'processing', amount: { minor: '200000', currency: 'ILS' } });
    const id = (r.body as PayoutView).id;
    expect(await available()).toBe(1_200_000n);
    const po = (await vendorPayoutOf(id))!;
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    const t = (await app.services.transfers.get(id))!;
    expect(t).toMatchObject({ state: 'failed', failureCode: 'ACCOUNT_CLOSED' });
    expect(t.reversalJournalId).toBeDefined();
    expect(await available()).toBe(1_400_000n);
    expect(await journals(`${settleKey('po-fail-1')}:reversal`)).toBe(1);
    expect((await app.services.payouts.view(t)).state).toBe('reversed');
    const pushes = notifySim().sent.slice(before);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ channel: 'push', to: 'ExponentPushToken[noa]', template: 'money.payout_failed', category: 'money', data: { reason: 'ACCOUNT_CLOSED', transferId: id } });
    expect((await db.query<{ first_settled_at: string | null }>(`select first_settled_at from ops.payee where party_id = $1 and iban = $2`, [member, IL2])).rows[0]!.first_settled_at).toBeNull();
  });

  it('over the two-person threshold the payout waits for a finance approver; approved, it submits; a forged webhook is refused', async () => {
    const r = await payout({ amount: { minor: '600000', currency: 'ILS' } }, 'po-big-1');
    expect(r.body).toMatchObject({ state: 'awaiting_second_approval', amount: { minor: '600000', currency: 'ILS' } });
    const id = (r.body as PayoutView).id;
    expect(await available()).toBe(1_400_000n);
    const req = (await app.services.approvals.find('payout', id))!;
    expect(req).toMatchObject({ kind: 'payout', required: 2, approvals: 1, status: 'awaiting_second_approval' });
    expect(await app.services.payouts.resumable(now)).toEqual([]);
    // A second member cannot approve; finance can.
    await expect(app.services.approvals.decide(req.id, { partyId: member, role: 'member' }, 'approve', now)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|IDEMPOTENCY_CONFLICT/) });
    await app.services.approvals.decide(req.id, { partyId: '00000000-0000-7000-8000-00000000f1a1', role: 'finance' }, 'approve', now, 'checked with the yeshiva');
    const due = await app.services.payouts.resumable(now);
    expect(due.map((t) => t.id)).toEqual([id]);
    const run = await runPayout(app.services.payouts, await app.services.payouts.inputFor(due[0]!), 'po-big-1', now);
    expect(run.transfer.state).toBe('submitted');
    expect((await app.services.payouts.view(run.transfer)).state).toBe('processing');
    expect(await available()).toBe(800_000n);
    const po = (await vendorPayoutOf(id))!;
    const forged = sim().nextWebhook(po);
    expect((await hook({ ...forged, headers: { 'x-sim-signature': 'nope' } })).status).toBe(401);
    expect((await app.services.transfers.get(id))!.state).toBe('submitted');
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    expect((await app.services.transfers.get(id))!.state).toBe('settled');
  });

  it('a rail outage leaves the payout retryable under the same key with the money reserved; the flag off answers FEATURE_OFF', async () => {
    const r = await payout({ payee: { iban: IL3, name: 'OUTAGE' }, amount: { minor: '50000', currency: 'ILS' } }, 'po-outage-1');
    expect(r.body).toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    const t = (await app.services.transfers.byKey('po-outage-1'))!;
    expect(t.state).toBe('submitted');
    expect(await journals(settleKey('po-outage-1'))).toBe(1);
    expect(await available()).toBe(750_000n);
    expect(await vendorPayoutOf(t.id)).toBeUndefined();
    const off = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now, identity: app.services.identity, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
    await expect(off.services.payouts.request(member, {}, 'po-off-1', now)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
  });

  it('the payout sweep resumes only this market\'s payouts, on this market\'s rail (T-0028)', async () => {
    const past = new Date(now.getTime() - 60_000);
    const [il, us] = [uuidv7(), uuidv7()];
    await seedTransfer(db, { id: il, kind: 'payout', state: 'pending_hold', market: 'IL', at: past });
    await seedTransfer(db, { id: us, kind: 'payout', state: 'pending_hold', market: 'US', at: past });
    const resumable = (await app.services.payouts.resumable(now, 1000)).map((t) => t.id);
    expect(resumable).toContain(il);
    expect(resumable).not.toContain(us);
  });

});
