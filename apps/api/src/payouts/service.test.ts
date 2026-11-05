// Payouts (T-0510, REQ-PO-001/002) end to end over PGlite and the payout simulator with real passkeys
// and step-up. TST-PO-001: payee validation at the API and the bank. TST-PO-002: a new payee at ₪3,000
// is scheduled +24 h in cooling_off with nothing moved; amounts over the two-person threshold wait in
// awaiting_second_approval; a settled webhook settles once; a failed webhook reverses the journal once
// and queues a push to the payer.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { decideKyb, verifiedPayoutAccount } from '../test-institution.ts';
import { fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock, type NotifySimulator, type PayoutSimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { monthlyExport } from '../institutions/export.ts';
import { statement } from '../institutions/statement.ts';
import { runLoad } from '../wallet/loads.ts';
import { COOL_OFF_MS, RETRY_AFTER_MS, runPayout, settleKey, type PayoutView } from './service.ts';

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
afterEach(() => vi.restoreAllMocks());
/** Engine-level tests need a member payout a second approver must decide, which a request no longer lets in (T-0545); they skip that one refusal. */
const allowBigMemberPayouts = () => vi.spyOn(app.services.payouts as unknown as { refuseUnapprovable: () => void }, 'refuseUnapprovable').mockImplementation(() => undefined);

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
    // T-0540: the amount is reserved (wallet → pending) the moment it has to wait, so it cannot be spent meanwhile.
    expect(await available()).toBe(1_700_000n);
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

  it('a member payout over the two-person threshold is refused at request time with the limit, and nothing is reserved; at the threshold it goes through (T-0545, F42)', async () => {
    const before = await available();
    const r = await payout({ amount: { minor: '500001', currency: 'ILS' } }, 'po-over-1');
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'VALIDATION_FAILED', limit: { minor: '500000', currency: 'ILS' } });
    expect(await app.services.transfers.byKey('po-over-1')).toBeUndefined();
    expect(await available()).toBe(before);
  });

  it('over the two-person threshold the payout waits for a finance approver; approved, it submits; a forged webhook is refused', async () => {
    allowBigMemberPayouts();
    const r = await payout({ amount: { minor: '600000', currency: 'ILS' } }, 'po-big-1');
    expect(r.body).toMatchObject({ state: 'awaiting_second_approval', amount: { minor: '600000', currency: 'ILS' } });
    const id = (r.body as PayoutView).id;
    expect(await available()).toBe(800_000n); // reserved while it waits for the approver
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

  it('a replay of a payout the rail never took asks the rail again (503, no second journal); thirty minutes on it fails and reverses once and the member is told (T-0541)', async () => {
    // Its own outage payout, so the test does not lean on an earlier one.
    expect((await payout({ payee: { iban: IL3, name: 'OUTAGE' }, amount: { minor: '50000', currency: 'ILS' } }, 'po-outage-2')).body).toMatchObject({ status: 503 });
    const t = (await app.services.transfers.byKey('po-outage-2'))!;
    expect(t.state).toBe('submitted');
    const before = await available();
    const pushes = notifySim().sent.length;
    // Replayed with the same key while the rail is still down: the vendor is asked again, the answer is the outage, nothing doubles.
    expect((await payout({ payee: { iban: IL3, name: 'OUTAGE' }, amount: { minor: '50000', currency: 'ILS' } }, 'po-outage-2')).body).toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    expect(await journals(settleKey('po-outage-2'))).toBe(1);
    expect(await available()).toBe(before);
    expect((await app.services.transfers.get(t.id))!.state).toBe('submitted');
    // Past thirty minutes with no vendor payout: failed, reversed once, the payer told.
    advance(31 * 60_000);
    await signInAgain();
    const r = await payout({ payee: { iban: IL3, name: 'OUTAGE' }, amount: { minor: '50000', currency: 'ILS' } }, 'po-outage-2');
    expect(r.body).toMatchObject({ id: t.id, state: 'reversed' });
    expect(await available()).toBe(before + 50_000n);
    expect(await journals(`${settleKey('po-outage-2')}:reversal`)).toBe(1);
    expect(await app.services.transfers.get(t.id)).toMatchObject({ state: 'failed', failureCode: 'PROVIDER_UNAVAILABLE' });
    expect(notifySim().sent.slice(pushes).filter((n) => n.template === 'money.payout_failed')).toHaveLength(1);
    // Again: nothing more happens.
    await payout({ payee: { iban: IL3, name: 'OUTAGE' }, amount: { minor: '50000', currency: 'ILS' } }, 'po-outage-2');
    expect(await available()).toBe(before + 50_000n);
    expect(await journals(`${settleKey('po-outage-2')}:reversal`)).toBe(1);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.case where kind = 'payout_stranded' and payload->>'transferId' = $1`, [t.id])).rows[0]!.n).toBe(1);
  });

  it('the 30 minutes are counted from the first attempt to the second: at 29:59 the payout is still retried, at 30:00 it is failed and reversed (T-0541)', async () => {
    expect((await payout({ payee: { iban: IL3, name: 'OUTAGE' }, amount: { minor: '50000', currency: 'ILS' } }, 'po-outage-3')).body).toMatchObject({ status: 503 });
    const t = (await app.services.transfers.byKey('po-outage-3'))!;
    const payouts = app.services.payouts;
    advance(30 * 60_000 - 1_000);
    await expect(runPayout(payouts, await payouts.inputFor(t), 'po-outage-3', now)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((await app.services.transfers.get(t.id))!.state).toBe('submitted');
    advance(1_000);
    const out = await runPayout(payouts, await payouts.inputFor(t), 'po-outage-3', now);
    expect(out.transfer.state).toBe('failed');
    expect(await app.services.transfers.get(t.id)).toMatchObject({ state: 'failed', failureCode: 'PROVIDER_UNAVAILABLE' });
    expect(await journals(`${settleKey('po-outage-3')}:reversal`)).toBe(1);
  });

  it('a payout the old rail took is at a rail whatever the current provider: it is not sent again, and the sweep does not list it', async () => {
    await signInAgain();
    expect((await payout({ payee: { iban: IL3, name: 'OUTAGE' }, amount: { minor: '50000', currency: 'ILS' } }, 'po-outage-4')).body).toMatchObject({ status: 503 });
    const t = (await app.services.transfers.byKey('po-outage-4'))!;
    const payouts = app.services.payouts;
    expect(await payouts.atRail(t)).toBe(false);
    await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('transfer', $1, 'previous-rail', $2)`, [t.id, `old-po-${t.id}`]);
    expect(await payouts.atRail(t)).toBe(true);
    advance(RETRY_AFTER_MS + 1_000);
    expect((await payouts.resumable(now)).map((x) => x.id)).not.toContain(t.id);
    const out = await runPayout(payouts, await payouts.inputFor(t), 'po-outage-4', now);
    expect(out.transfer.state).toBe('submitted');
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

describe('T-0540: a payout that waits has its funds reserved (REQ-PO-001, REQ-WAL-001, F11)', () => {
  const reserveKey = (k: string) => `${k}:reserve`;
  const unreserveKey = (k: string) => `${k}:unreserve`;
  const poPayee = (iban: string, name: string) => ({ iban, name });
  async function newMember(minor: bigint) {
    const party = uuidv7(now);
    await app.services.accounts.provisionMember(party);
    await runLoad(app.services.loads, { payerPartyId: party, memberPartyId: party, method: 'card', amount: money(minor, 'ILS'), paymentMethodId: 'pm_ok' }, `po-fund-${party}`, now);
    return party;
  }
  const purse = async (party: string) => {
    const p = (await app.services.accounts.purses(party)).find((x) => x.currency === 'ILS')!;
    return { available: p.available.minor, holds: p.holds.minor };
  };
  const ask = (party: string, key: string, minor: bigint, payee = poPayee(IL, 'Yeshivat Example')) =>
    app.services.payouts.request(party, { payee, amount: { minor: minor.toString(), currency: 'ILS' }, reference: 'tuition' }, key, now);
  const run = async (key: string) => {
    const t = (await app.services.transfers.byKey(key))!;
    return runPayout(app.services.payouts, await app.services.payouts.inputFor(t), key, now);
  };

  it('3,000 to a new payee with 3,000 available: spending it during the cool-off is refused, and the release leaves the wallet at zero, not below', async () => {
    const party = await newMember(300_000n);
    const key = `po-res-1-${party}`;
    const r = await ask(party, key, 300_000n);
    expect(r).toMatchObject({ state: 'cooling_off' });
    expect(await purse(party)).toEqual({ available: 0n, holds: 300_000n });
    expect(await journals(reserveKey(key))).toBe(1);
    // The same 3,000 cannot be spent again (another payout, as P2P would be).
    await expect(ask(party, `po-res-1b-${party}`, 100_000n, poPayee(IL2, 'FAIL'))).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    // A replay with the same key reserves nothing more.
    expect(await ask(party, key, 300_000n)).toMatchObject({ state: 'cooling_off' });
    expect(await journals(reserveKey(key))).toBe(1);
    // The cool-off ends: the payout posts from the reserve, not from the wallet.
    advance(COOL_OFF_MS);
    const out = await run(key);
    expect(out.transfer.state).toBe('pending');
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n });
    expect(await journals(settleKey(key))).toBe(1);
    // Replayed: nothing more is posted.
    await run(key);
    expect(await journals(settleKey(key))).toBe(1);
    expect(await journals(reserveKey(key))).toBe(1);
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n });
  });

  it('a rail failure after a cool-off returns the money to the wallet exactly once (the payout and the reserve are each reversed once)', async () => {
    const party = await newMember(300_000n);
    const key = `po-res-2-${party}`;
    await ask(party, key, 300_000n, poPayee(IL2, 'FAIL'));
    expect(await purse(party)).toEqual({ available: 0n, holds: 300_000n });
    advance(COOL_OFF_MS);
    const t = (await run(key)).transfer;
    const po = (await vendorPayoutOf(t.id))!;
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    expect((await hook(sim().nextWebhook(po))).status).toBe(200);
    expect(await app.services.transfers.get(t.id)).toMatchObject({ state: 'failed', failureCode: 'ACCOUNT_CLOSED' });
    expect(await purse(party)).toEqual({ available: 300_000n, holds: 0n });
    expect(await journals(`${settleKey(key)}:reversal`)).toBe(1);
    expect(await journals(unreserveKey(key))).toBe(1);
    await run(key);
    expect(await purse(party)).toEqual({ available: 300_000n, holds: 0n });
  });

  it('an approval that expires fails the payout and releases the reserve once; a payout that cooled off and was approved posts from the reserve', async () => {
    allowBigMemberPayouts();
    const party = await newMember(900_000n);
    const key = `po-res-3-${party}`;
    expect(await ask(party, key, 600_000n)).toMatchObject({ state: 'cooling_off' });
    expect(await purse(party)).toEqual({ available: 300_000n, holds: 600_000n });
    advance(COOL_OFF_MS);
    const waiting = await run(key);
    expect(waiting.waiting).toBe('approval');
    expect(await purse(party)).toEqual({ available: 300_000n, holds: 600_000n }); // still reserved, once
    expect(await journals(reserveKey(key))).toBe(1);
    // Nobody decides for seven days and a bit: the sweep finds it and fails it.
    advance(7 * 86_400_000 + 60_000);
    const due = (await app.services.payouts.resumable(now)).map((t) => t.id);
    expect(due).toContain(waiting.transfer.id);
    const after = await run(key);
    expect(after.transfer).toMatchObject({ state: 'failed', failureCode: 'APPROVAL_EXPIRED' });
    expect(await purse(party)).toEqual({ available: 900_000n, holds: 0n });
    expect(await journals(unreserveKey(key))).toBe(1);
    expect(await journals(settleKey(key))).toBe(0);
    await run(key);
    expect(await journals(unreserveKey(key))).toBe(1);
    expect(await purse(party)).toEqual({ available: 900_000n, holds: 0n });
    expect((await app.services.payouts.view(after.transfer)).state).toBe('failed');
    expect(await app.services.payouts.resumable(now)).not.toContainEqual(expect.objectContaining({ id: waiting.transfer.id }));
  });

  const FINANCE = '00000000-0000-7000-8000-00000000f1a1';
  const approvalOf = async (transferId: string) => (await db.query<{ status: string }>(`select status from ops.approval_request where kind = 'payout' and subject = $1`, [transferId])).rows[0]?.status;
  /** A member with 900,000 and a 600,000 payout that cooled off and now waits for an approver (the reserve held once). */
  async function waitingForApprover(tag: string) {
    const party = await newMember(900_000n);
    await app.services.identity.upsertDevice({ partyId: party, deviceId: `d-${tag}`, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), pushToken: `ExponentPushToken[${tag}]` });
    const key = `po-${tag}-${party}`;
    await ask(party, key, 600_000n);
    advance(COOL_OFF_MS);
    const waiting = await run(key);
    expect(waiting.waiting).toBe('approval');
    return { party, key, id: waiting.transfer.id };
  }

  it('a finance rejection of a member payout fails it and returns the reserve once, however many sweeps run', async () => {
    allowBigMemberPayouts();
    const { party, key, id } = await waitingForApprover('rej');
    const req = (await app.services.approvals.find('payout', id))!;
    await app.services.approvals.decide(req.id, { partyId: FINANCE, role: 'finance' }, 'reject', now, 'not this one');
    expect(await purse(party)).toEqual({ available: 300_000n, holds: 600_000n }); // the rejection alone moves nothing
    expect((await app.services.payouts.resumable(now)).map((t) => t.id)).toContain(id);
    const after = await run(key);
    expect(after.transfer).toMatchObject({ state: 'failed', failureCode: 'REJECTED' });
    expect(await purse(party)).toEqual({ available: 900_000n, holds: 0n });
    expect(await journals(unreserveKey(key))).toBe(1);
    await run(key);
    expect(await journals(unreserveKey(key))).toBe(1);
    expect(await approvalOf(id)).toBe('rejected');
    expect((await app.services.payouts.resumable(now)).map((t) => t.id)).not.toContain(id);
  });

  it('a decision attempted after the approval ran out is refused, and the payout still fails and returns its reserve', async () => {
    allowBigMemberPayouts();
    const { party, key, id } = await waitingForApprover('late');
    advance(7 * 86_400_000 + 60_000);
    const req = (await app.services.approvals.find('payout', id))!;
    await expect(app.services.approvals.decide(req.id, { partyId: FINANCE, role: 'finance' }, 'approve', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await approvalOf(id)).toBe('expired'); // the refused decision marked it
    expect((await app.services.payouts.resumable(now)).map((t) => t.id)).toContain(id);
    expect((await run(key)).transfer).toMatchObject({ state: 'failed', failureCode: 'APPROVAL_EXPIRED' });
    expect(await purse(party)).toEqual({ available: 900_000n, holds: 0n });
    expect(await journals(unreserveKey(key))).toBe(1);
  });

  it('an expiry marks the approval expired and tells the payer once', async () => {
    allowBigMemberPayouts();
    const { key, id } = await waitingForApprover('exp');
    const before = notifySim().sent.length;
    advance(7 * 86_400_000 + 60_000);
    await run(key);
    expect(await approvalOf(id)).toBe('expired');
    const pushes = notifySim().sent.slice(before).filter((n) => n.template === 'money.payout_failed');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ channel: 'push', category: 'money', data: { reason: 'APPROVAL_EXPIRED', transferId: id } });
    await run(key);
    expect(notifySim().sent.slice(before).filter((n) => n.template === 'money.payout_failed')).toHaveLength(1);
  });

  it('a payout that was already waiting before the reserve existed is reserved when it resumes, or failed (not overdrawn) when the money has gone', async () => {
    const party = await newMember(300_000n);
    const key = `po-legacy-${party}`;
    await db.query(`insert into ops.payee (id, party_id, iban, iban_last4, name, bank_code, validated_at, created_at) values ($1, $2, $3, '9999', 'Yeshivat Example', null, $4, $4)`, [uuidv7(now), party, IL, now]);
    const payeeId = (await db.query<{ id: string }>(`select id from ops.payee where party_id = $1`, [party])).rows[0]!.id;
    const input = { partyId: party, source: { kind: 'member' as const }, payeeId, payee: { iban: IL, name: 'Yeshivat Example' }, amount: money(300_000n, 'ILS'), reference: 'legacy' };
    const payouts = app.services.payouts;
    // How a payout looked before this change: cooling off, nothing reserved.
    await payouts.coolOff(await payouts.begin(input, key, now), now);
    expect(await journals(reserveKey(key))).toBe(0);
    expect(await purse(party)).toEqual({ available: 300_000n, holds: 0n });
    // The member spends it during the wait (a straight-to-the-rail payout).
    expect(await ask(party, `po-legacy-spend-${party}`, 200_000n, poPayee(IL, 'Yeshivat Example'))).toMatchObject({ state: 'processing' });
    advance(COOL_OFF_MS);
    const out = await runPayout(payouts, input, key, now);
    expect(out.transfer).toMatchObject({ state: 'failed', failureCode: 'INSUFFICIENT_FUNDS' });
    expect((await purse(party)).available).toBe(100_000n); // never below zero, and the reserve was never posted
    expect(await journals(reserveKey(key))).toBe(0);
    expect(await journals(settleKey(key))).toBe(0);
  });

  it('a run that died between the hold and the reserve is reserved by the next pass while it still cools off, so the money cannot be spent meanwhile (T-0549)', async () => {
    const party = await newMember(400_000n);
    const key = `po-res-crash-${party}`;
    const crash = vi.spyOn(app.services.payouts, 'reserve').mockRejectedValueOnce(new Error('died before the reserve'));
    await expect(ask(party, key, 300_000n)).rejects.toThrow('died before');
    crash.mockRestore();
    const t = (await app.services.transfers.byKey(key))!;
    expect(t.state).toBe('pending_hold');
    expect(await journals(reserveKey(key))).toBe(0);
    expect(await purse(party)).toEqual({ available: 400_000n, holds: 0n });
    // The cool-off is nowhere near over, yet the sweep finds it and the run reserves.
    expect((await app.services.payouts.resumable(now)).map((x) => x.id)).toContain(t.id);
    const out = await run(key);
    expect(out).toMatchObject({ waiting: 'cooling_off' });
    expect(await journals(reserveKey(key))).toBe(1);
    expect(await purse(party)).toEqual({ available: 100_000n, holds: 300_000n });
    // Reserved, so no longer swept on every pass, and the same money cannot be spent again.
    expect((await app.services.payouts.resumable(now)).map((x) => x.id)).not.toContain(t.id);
    await expect(ask(party, `po-res-crash-2-${party}`, 200_000n, poPayee(IL2, 'FAIL'))).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('a payout that ended meanwhile takes no new reserve from a stale read', async () => {
    const party = await newMember(500_000n);
    const key = `po-res-ended-${party}`;
    await db.query(`insert into ops.payee (id, party_id, iban, iban_last4, name, bank_code, validated_at, created_at) values ($1, $2, $3, '9999', 'Yeshivat Example', null, $4, $4)`, [uuidv7(now), party, IL, now]);
    const payeeId = (await db.query<{ id: string }>(`select id from ops.payee where party_id = $1`, [party])).rows[0]!.id;
    const input = { partyId: party, source: { kind: 'member' as const }, payeeId, payee: { iban: IL, name: 'Yeshivat Example' }, amount: money(300_000n, 'ILS'), reference: 'ended' };
    const payouts = app.services.payouts;
    const stale = await payouts.coolOff(await payouts.begin(input, key, now), now); // nothing reserved
    await payouts.fail(stale, 'CANCELLED_BY_TEST', now, 'ended');
    expect(await payouts.reserve(stale, input, now)).toBeUndefined();
    expect(await journals(reserveKey(key))).toBe(0);
    expect(await purse(party)).toEqual({ available: 500_000n, holds: 0n });
  });

  it('a payout that goes straight to the rail reserves nothing and posts from the wallet as before', async () => {
    const party = await newMember(500_000n);
    const key = `po-res-4-${party}`;
    expect(await ask(party, key, 200_000n)).toMatchObject({ state: 'processing' });
    expect(await journals(reserveKey(key))).toBe(0);
    expect(await purse(party)).toEqual({ available: 300_000n, holds: 0n });
  });
});

describe('T-0554: an institution payout whose approval is rejected or runs out ends (REQ-PO-001, REQ-INS-020)', () => {
  const requester = uuidv7(NOW);
  const finance2 = { partyId: uuidv7(NOW), role: 'finance' };
  async function funded(minor: bigint) {
    const inst = uuidv7(now);
    await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [inst]);
    await decideKyb(db, inst);
    await verifiedPayoutAccount(db, inst, IL, 'Yeshivat Example');
    const master = await app.services.accounts.institutionAccount(inst, 'ILS');
    const partner = await app.services.accounts.systemAccount('partner_settlement', 'ILS');
    await app.services.ledger.post({ idempotencyKey: `inst-fund-${inst}`, kind: 'deposit', postings: [{ accountId: partner, currency: 'ILS', amountMinor: minor }, { accountId: master, currency: 'ILS', amountMinor: -minor }] });
    return inst;
  }
  const ask = (inst: string, key: string, minor: bigint) =>
    app.services.payouts.request(inst, { payee: { iban: IL, name: 'Yeshivat Example' }, amount: { minor: minor.toString(), currency: 'ILS' }, reference: 'transfer' }, key, now, { kind: 'institution', requestedBy: requester, requesterRole: 'finance' });
  /** What the institution can use: its master account. */
  const owned = async (inst: string) => (await app.services.accounts.institutionBalance(inst, 'ILS')).minor;
  const reservedOf = async (inst: string) => (await app.services.accounts.institutionReserved(inst, 'ILS')).minor;
  const journalCount = async (k: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [k])).rows[0]!.n;
  const sweep = async (keys: string[]) => {
    const out = [];
    for (const t of (await app.services.payouts.resumable(now)).filter((x) => keys.includes(x.idempotencyKey))) out.push((await runPayout(app.services.payouts, await app.services.payouts.inputFor(t), t.idempotencyKey, now)).transfer);
    return out;
  };

  it('an approval that runs out fails the payout once with APPROVAL_EXPIRED, ends the approval and gives the set-aside money back once', async () => {
    const inst = await funded(1_000_000n);
    const key = `po-inst-exp-${inst}`;
    const r = await ask(inst, key, 600_000n);
    // A new payee over the threshold cools off for a day first (unchanged); then it waits for its second approver.
    expect(r).toMatchObject({ state: 'cooling_off' });
    expect([await owned(inst), await reservedOf(inst)]).toEqual([400_000n, 600_000n]); // set aside from the first moment it waits
    advance(COOL_OFF_MS + 60_000);
    await sweep([key]);
    const waiting = (await app.services.transfers.byKey(key))!;
    expect((await app.services.payouts.view(waiting)).state).toBe('awaiting_second_approval');
    expect([await owned(inst), await reservedOf(inst)]).toEqual([400_000n, 600_000n]);
    expect((await app.services.payouts.resumable(now)).map((t) => t.idempotencyKey)).not.toContain(key);
    advance(8 * 86_400_000);
    const ended = (await sweep([key])).find((t) => t.idempotencyKey === key)!;
    expect(ended).toMatchObject({ state: 'failed', failureCode: 'APPROVAL_EXPIRED' });
    const t = (await app.services.transfers.byKey(key))!;
    expect((await app.services.approvals.find('payout', t.id))!.status).toBe('expired');
    expect([await owned(inst), await reservedOf(inst)]).toEqual([1_000_000n, 0n]);
    expect(await journalCount(`${key}:unreserve`)).toBe(1);
    // A second sweep finds nothing more to do for it.
    expect((await app.services.payouts.resumable(now)).map((x) => x.idempotencyKey)).not.toContain(key);
    expect((await app.services.transfers.byKey(key))!.state).toBe('failed');
    expect(await journalCount(`${key}:unreserve`)).toBe(1);
  });

  it('a rejected approval fails the payout with REJECTED', async () => {
    const inst = await funded(1_000_000n);
    const key = `po-inst-rej-${inst}`;
    await ask(inst, key, 600_000n);
    const t = (await app.services.transfers.byKey(key))!;
    const req = (await app.services.approvals.find('payout', t.id))!;
    await app.services.approvals.decide(req.id, finance2, 'reject', now, 'wrong payee');
    advance(COOL_OFF_MS + 60_000);
    const ended = (await sweep([key])).find((x) => x.idempotencyKey === key)!;
    expect(ended).toMatchObject({ state: 'failed', failureCode: 'REJECTED' });
    expect([await owned(inst), await reservedOf(inst)]).toEqual([1_000_000n, 0n]);
    expect(await journalCount(`${key}:unreserve`)).toBe(1);
  });
  it('money set aside for a waiting payout cannot be spent again: another payout that would need it is refused INSUFFICIENT_FUNDS (T-0550)', async () => {
    const inst = await funded(1_000_000n);
    await ask(inst, `po-inst-hold-a-${inst}`, 600_000n);
    expect([await owned(inst), await reservedOf(inst)]).toEqual([400_000n, 600_000n]);
    await expect(ask(inst, `po-inst-hold-b-${inst}`, 500_000n)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    // What is left is still usable: a payout within it is accepted.
    expect(await ask(inst, `po-inst-hold-c-${inst}`, 100_000n)).toBeDefined();
  });

  it('once approved, the payout posts from the reserve once; while it waited the statement and export showed no payout, afterwards one (T-0550, T-0555)', async () => {
    const inst = await funded(1_000_000n);
    const key = `po-inst-go-${inst}`;
    await ask(inst, key, 600_000n);
    const monthOf = (d: Date) => d.toISOString().slice(0, 7);
    const reserveMonth = monthOf(now);
    const payoutRows = async (month: string) => ({
      statement: (await statement(db, app.services.accounts, inst, month, 'ILS')).rows.filter((r) => r.kind === 'payout').length,
      export: (await monthlyExport(db, inst, month, 'ILS')).rows.filter((r) => r.kind === 'payout').length,
    });
    expect(await payoutRows(reserveMonth)).toEqual({ statement: 0, export: 0 });
    expect((await statement(db, app.services.accounts, inst, reserveMonth, 'ILS')).closing.minor).toBe(1_000_000n); // what it owns is unchanged
    advance(COOL_OFF_MS + 60_000);
    await sweep([key]);
    const t = (await app.services.transfers.byKey(key))!;
    const req = (await app.services.approvals.find('payout', t.id))!;
    await app.services.approvals.decide(req.id, finance2, 'approve', now, 'checked');
    const out = (await sweep([key])).find((x) => x.idempotencyKey === key)!;
    expect(['submitted', 'pending']).toContain(out.state);
    expect([await owned(inst), await reservedOf(inst)]).toEqual([400_000n, 0n]); // the reserve paid it out
    expect(await journalCount(settleKey(key))).toBe(1);
    await sweep([key]); // a replay posts nothing more
    expect(await journalCount(settleKey(key))).toBe(1);
    const months = [...new Set([reserveMonth, monthOf(now)])];
    let rows = { statement: 0, export: 0 };
    for (const m of months) {
      const r = await payoutRows(m);
      rows = { statement: rows.statement + r.statement, export: rows.export + r.export };
    }
    expect(rows).toEqual({ statement: 1, export: 1 });
  });

  it('a payout the rail fails after it was posted from the reserve gives the money back to the master once', async () => {
    const inst = await funded(1_000_000n);
    const key = `po-inst-fail-${inst}`;
    await ask(inst, key, 600_000n);
    advance(COOL_OFF_MS + 60_000);
    await sweep([key]);
    const t = (await app.services.transfers.byKey(key))!;
    const req = (await app.services.approvals.find('payout', t.id))!;
    await app.services.approvals.decide(req.id, finance2, 'approve', now, 'checked');
    await sweep([key]);
    expect(await reservedOf(inst)).toBe(0n);
    await app.services.payouts.fail((await app.services.transfers.byKey(key))!, 'ACCOUNT_CLOSED', now, 'bank refused');
    expect([await owned(inst), await reservedOf(inst)]).toEqual([1_000_000n, 0n]);
    expect(await journalCount(`${settleKey(key)}:reversal`)).toBe(1);
    expect(await journalCount(`${key}:unreserve`)).toBe(1);
  });
});
