// Loads (T-0501, REQ-WAL-002; T-0502, REQ-WAL-003) end to end. TST-WAL-002: a $100 Apple Pay load posts
// partner_settlement → wallet on success; requires_action returns the client secret and stores it
// nowhere; the webhook settles or fails the transfer once; the workflow id is the Idempotency-Key, and
// so is the vendor pull's key. An ACH load is held in pending until the bank's hold date (TST-WAL-003's
// release job is tested in the worker). TST-WAL-006: a load names the purse it credits; into the other
// currency it converts at the club rate, priced once, and a missing or stale rate refuses it before the
// vendor is asked. Over the funding simulator and PGlite with a real passkey and step-up.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainError, money, uuidv7 } from '@kesher/domain';
import { FundingAccountError, FundingAccountSimulator, FundingError, FundingSimulator, fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock, type FundingPort, type Load as VendorLoad } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { FakeStripe, StripeFundingAdapter } from '@kesher/adapters';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import type { Database } from '../db.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { Transfer } from '../transfers/service.ts';
import { applyVendorState, creditAttemptState, creditKey, HELD_RECHECK_MS, holdKey, loadState, LoadService, recordCreditBegan, recordCreditOutcome, releaseKey, runLoad, settleKey, type CreditOutcome, type LoadView } from './loads.ts';
import { seedTransfer } from '../test-seed.ts';
import { creditMayHaveMoved, recordCreditResent } from './load-credit.ts';
import { openCase } from '../ops/cases.ts';
import { ownerFailedMarker } from './sub-account-markers.ts';
import { OWNER_FAILED_CASE, ownerCaseKey, ownerKind } from './sub-accounts.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-02T09:00:00Z'); // a Monday: an ACH hold of 3 business days ends Thursday
let member = '';
let access = '';
let stepUpToken = '';
let signingKey: Awaited<ReturnType<typeof generateSigningKey>>;

const USD_100 = { minor: '10000', currency: 'USD' };
const call = (method: string, url: string, body?: unknown, h: Record<string, string> = {}) => dispatch(app, { method, url, headers: { authorization: `Bearer ${access}`, ...h }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const load = (body: Record<string, unknown>, key: string, h: Record<string, string> = {}) => call('POST', '/v1/loads', { memberPartyId: member, amount: USD_100, method: 'apple_pay', paymentMethodId: 'pm_ok', ...body }, { 'idempotency-key': key, 'x-step-up': stepUpToken, ...h });
const hook = (w: { headers: Record<string, string>; rawBody: string }) => dispatch(app, { method: 'POST', url: '/v1/hooks/funding', headers: w.headers, rawBody: w.rawBody, now: NOW });

const available = async (party = member) => (await app.services.accounts.purses(party)).find((p) => p.currency === 'USD')!.available.minor;
const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey(key)])).rows[0]!.n;
const vendorLoadOf = (transferId: string) => app.services.loads.vendorLoadOf(transferId);

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost(fixedClock(NOW.toISOString()) as AdvanceableClock);
  signingKey = await generateSigningKey();
  app = createApp({ db, registry: host.registry, market: 'US', signingKey, issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'funding.ach': true }) });
  const s = app.services;
  const started = await s.otp.start({ phone: '+12125550100', locale: 'en' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Dana' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Dana', response: await device.register(r1.options!) });
  access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  member = principal.partyId;
  const su = await s.stepUp.start(principal);
  stepUpToken = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
}, 60_000);
afterAll(async () => db.close());

describe('POST /loads (TST-WAL-002)', () => {
  it('the gate: the flag first, then the step-up, then the key', async () => {
    const off = createApp({ db, registry: host.registry, market: 'US', signingKey, identity: app.services.identity, issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags() });
    const r = await dispatch(off, { method: 'POST', url: '/v1/loads', headers: { authorization: `Bearer ${access}` }, rawBody: '{}', now: NOW });
    expect(r.body).toMatchObject({ code: 'FEATURE_OFF' });
    expect((await load({}, 'load-gate-1', { 'x-step-up': '' })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await load({}, 'short')).status).toBe(422);
  });

  it('a $100 Apple Pay load settles at once: partner_settlement → wallet, one journal keyed by the workflow id, the vendor pull keyed by the Idempotency-Key', async () => {
    const key = 'load-apple-100';
    const before = await available();
    const r = await load({}, key);
    expect(r.status).toBe(201);
    const view = r.body as LoadView;
    expect(view).toEqual({ id: expect.any(String), state: 'settled', amount: USD_100 });
    expect(await available()).toBe(before + 10_000n);

    const t = (await app.services.transfers.byKey(key))!;
    expect(t).toMatchObject({ id: view.id, kind: 'load', state: 'settled', toPartyId: member, fromPartyId: member, amount: money(10_000n, 'USD') });
    expect((await app.services.transfers.history(t.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'settled']);
    const j = (await db.query<{ kind: string; transfer_id: string; postings: number }>(`select j.kind, j.transfer_id, (select count(*)::int from ledger.posting p where p.journal_id = j.id) as postings from ledger.journal j where j.id = $1`, [t.journalId])).rows[0];
    expect(j).toEqual({ kind: 'load', transfer_id: t.id, postings: 2 });
    const sides = (await db.query<{ type: string; amount_minor: string }>(`select a.type, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id where p.journal_id = $1 order by a.type::text`, [t.journalId])).rows;
    expect(sides).toEqual([
      { type: 'partner_settlement', amount_minor: '10000' },
      { type: 'wallet', amount_minor: '-10000' },
    ]);

    // The vendor pull carried the key: the same input with the same key at the simulator is the same load.
    const vendorLoad = (await vendorLoadOf(t.id))!;
    const again = await host.simulators.funding.createLoad({ customerId: member, method: 'apple_pay', amount: money(10_000n, 'USD'), paymentMethodId: 'pm_ok' }, key);
    expect(again.loadId).toBe(vendorLoad);
  });

  it('a replay with the same key returns the same load and posts nothing; the key of another operation is refused', async () => {
    const before = await available();
    const first = (await load({}, 'load-apple-100')).body as LoadView;
    expect(first.state).toBe('settled');
    expect(await available()).toBe(before);
    expect(await journals('load-apple-100')).toBe(1);

    await app.services.transfers.create({ idempotencyKey: 'p2p-not-a-load', kind: 'p2p', fromPartyId: member, toPartyId: uuidv7(NOW), amount: money(100n, 'USD') }, NOW);
    expect((await load({}, 'p2p-not-a-load')).body).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('validates the body and refuses a stranger\'s purse; bank methods wait on their own cards', async () => {
    expect((await load({ amount: { minor: '-5', currency: 'USD' } }, 'load-bad-amount-1')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await load({ amount: { minor: '500', currency: 'EUR' } }, 'load-bad-amount-2')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await load({ method: 'wire' }, 'load-bad-method-1')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await load({ method: 'rtp' }, 'load-rtp-later')).body).toMatchObject({ code: 'FEATURE_OFF' });
    const s = app.services;
    const achOff = new LoadService({ db, port: host.simulators.funding, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: new StaticFlags(undefined, { 'wallet.enabled': true }), provider: 'simulator' });
    await expect(achOff.request(member, { memberPartyId: member, amount: USD_100, method: 'ach', paymentMethodId: 'pm_bank' }, 'load-ach-off-1', NOW)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    expect((await load({ memberPartyId: uuidv7(NOW) }, 'load-stranger-1')).body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await app.services.transfers.byKey('load-stranger-1')).toBeUndefined();
  });

  it('a funder loads the purse of a member they fund', async () => {
    const kid = uuidv7(NOW);
    await app.services.plans.ensurePlan('club', 'Kesher Club');
    await app.services.plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    const m = await app.services.memberships.create({ idempotencyKey: 'm-kid-load', memberPartyId: kid, funderPartyId: member, funderEmail: 'f@example.com', planCode: 'club' }, NOW);
    await app.services.memberships.setStatus(m.id, 'cancelled', NOW);
    expect((await load({ memberPartyId: kid, method: 'card' }, 'load-kid-cancelled')).body).toMatchObject({ code: 'FORBIDDEN' });
    await app.services.memberships.setStatus(m.id, 'active', NOW);
    const r = await load({ memberPartyId: kid, method: 'card' }, 'load-kid-1');
    expect(r.body).toMatchObject({ state: 'settled' });
    expect(await available(kid)).toBe(10_000n);
    expect((await app.services.transfers.byKey('load-kid-1'))!).toMatchObject({ fromPartyId: member, toPartyId: kid });
  });

  it('a decline fails the transfer with the vendor code and posts nothing', async () => {
    const before = await available();
    const r = await load({ paymentMethodId: 'pm_declined' }, 'load-declined-1');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: 'failed', amount: USD_100 });
    const t = (await app.services.transfers.byKey('load-declined-1'))!;
    expect(t).toMatchObject({ state: 'failed', failureCode: 'DECLINED' });
    expect(t.journalId).toBeUndefined();
    expect(await available()).toBe(before);
    expect((await load({ paymentMethodId: 'pm_declined' }, 'load-declined-1')).body).toMatchObject({ state: 'failed' });
  });

  it('a vendor outage answers 503 and leaves the transfer submitted; the same key then completes it', async () => {
    const r = await load({ paymentMethodId: 'pm_outage' }, 'load-outage-1');
    expect(r.body).toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    const t = (await app.services.transfers.byKey('load-outage-1'))!;
    expect(t.state).toBe('submitted');
    expect(await vendorLoadOf(t.id)).toBeUndefined();
    const before = await available();
    expect((await load({}, 'load-outage-1')).body).toMatchObject({ id: t.id, state: 'settled' });
    expect(await available()).toBe(before + 10_000n);
    expect((await app.services.transfers.history(t.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'settled']);
  });
});

describe('the webhook (/hooks/funding)', () => {
  it('a second notice of a settled load changes nothing; a forged one is refused; an unknown load is acknowledged', async () => {
    const t = (await app.services.transfers.byKey('load-apple-100'))!;
    const vendorLoad = (await vendorLoadOf(t.id))!;
    const before = await available();
    const ok = await hook(host.simulators.funding.webhookFor(vendorLoad, 'succeeded'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ duplicate: false });
    expect(await journals('load-apple-100')).toBe(1);
    expect(await available()).toBe(before);
    expect((await app.services.transfers.history(t.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'settled']);

    const forged = host.simulators.funding.webhookFor(vendorLoad, 'succeeded');
    expect((await hook({ ...forged, headers: { 'x-sim-signature': 'nope' } })).status).toBe(401);

    const unknown = await hook({ headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-unknown-1', loadId: 'load_999999', status: 'succeeded', amount: USD_100 }) });
    expect(unknown.status).toBe(200);
    const stored = (await db.query<{ processed_at: string | null; error: string | null }>(`select processed_at, error from ops.inbound_event where provider = 'funding' and event_id = 'evt-unknown-1'`)).rows[0];
    expect(stored).toMatchObject({ error: null });
    expect(stored?.processed_at).not.toBeNull();
  });

  it('an ACH load is held in the pending purse until Thursday; the vendor confirming during the hold leaves it held (REQ-WAL-003)', async () => {
    const key = 'load-held-ach-1';
    const before = await available();
    const r = await load({ method: 'ach', paymentMethodId: 'pm_bank', amount: { minor: '5000', currency: 'USD' } }, key);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), state: 'on_hold', amount: { minor: '5000', currency: 'USD' }, holdUntil: '2026-11-05' });
    const t = (await app.services.transfers.byKey(key))!;
    expect(t).toMatchObject({ state: 'pending_hold', holdReleasesAt: '2026-11-05T09:00:00.000Z' });
    expect(loadState(t)).toBe('on_hold');
    const purse = (await app.services.accounts.purses(member)).find((p) => p.currency === 'USD')!;
    expect(purse.available.minor).toBe(before);
    expect(purse.holds.minor).toBe(5_000n);
    expect(await journals(key)).toBe(0);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1 and kind = 'load_hold'`, [holdKey(key)])).rows[0]).toEqual({ n: 1 });

    const vendorLoad = (await vendorLoadOf(t.id))!;
    expect((await hook(host.simulators.funding.webhookFor(vendorLoad, 'succeeded'))).status).toBe(200);
    expect((await load({ method: 'ach', paymentMethodId: 'pm_bank', amount: { minor: '5000', currency: 'USD' } }, key)).body).toMatchObject({ id: t.id, state: 'on_hold', holdUntil: '2026-11-05' });
    expect(await available()).toBe(before);
    expect((await app.services.transfers.history(t.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'pending_hold']);
  });

  it('an ACH return during the hold fails the load once and reverses the hold, so the money leaves the pending purse', async () => {
    const key = 'load-held-ach-2';
    const r = await load({ method: 'ach', paymentMethodId: 'pm_bank', amount: { minor: '7000', currency: 'USD' } }, key);
    expect(r.body).toMatchObject({ state: 'on_hold' });
    const t = (await app.services.transfers.byKey(key))!;
    const holdsBefore = (await app.services.accounts.purses(member)).find((p) => p.currency === 'USD')!.holds.minor;
    const before = await available();
    const vendorLoad = (await vendorLoadOf(t.id))!;
    expect((await hook(host.simulators.funding.webhookFor(vendorLoad, 'failed'))).status).toBe(200);
    expect((await hook(host.simulators.funding.webhookFor(vendorLoad, 'failed'))).status).toBe(200);
    expect(await app.services.transfers.get(t.id)).toMatchObject({ state: 'failed', failureCode: 'VENDOR_FAILED' });
    const purse = (await app.services.accounts.purses(member)).find((p) => p.currency === 'USD')!;
    expect(purse.holds.minor).toBe(holdsBefore - 7_000n);
    expect(purse.available.minor).toBe(before);
    expect(await journals(key)).toBe(0);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where reverses_id = $1`, [t.journalId])).rows[0]).toEqual({ n: 1 });
    expect((await app.services.transfers.history(t.id)).filter((e) => e.to === 'failed')).toHaveLength(1);
  });
});

describe('requires_action (a scripted vendor)', () => {
  const secret = 'pi_secret_never_stored_7f3a';
  const loads = new Map<string, VendorLoad>();
  const port: FundingPort = {
    async createLoad(input, key) {
      const existing = loads.get(key);
      if (existing) return { ...existing };
      const l: VendorLoad = { loadId: `vl_${loads.size + 1}`, method: input.method, amount: input.amount, status: 'requires_action', clientSecret: secret };
      loads.set(key, l);
      return { ...l };
    },
    async getLoad(id) {
      const l = [...loads.values()].find((x) => x.loadId === id);
      if (!l) throw new FundingError('UNKNOWN_LOAD', id);
      return { ...l };
    },
    async refund() {
      throw new FundingError('VALIDATION_FAILED', 'not in this script');
    },
    async getRefund(id) {
      throw new FundingError('UNKNOWN_REFUND', id);
    },
    async parseWebhook(headers, rawBody) {
      if (headers['x-sig'] !== 'ok') throw new FundingError('BAD_SIGNATURE', 'nope');
      const b = JSON.parse(rawBody) as { eventId: string; loadId: string; status: VendorLoad['status'] };
      const l = [...loads.values()].find((x) => x.loadId === b.loadId);
      if (!l) throw new FundingError('UNKNOWN_LOAD', b.loadId);
      const { clientSecret: _s, ...rest } = l;
      return { eventId: b.eventId, load: { ...rest, status: b.status } };
    },
  };

  it('returns the client secret to the member only, then the webhook settles exactly once', async () => {
    const s = app.services;
    const svc = new LoadService({ db, port, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider: 'scripted' });
    const key = 'load-sheet-1';
    const view = await svc.request(member, { memberPartyId: member, amount: USD_100, method: 'card', paymentMethodId: 'pm_sheet' }, key, NOW);
    expect(view).toEqual({ id: expect.any(String), state: 'requires_action', amount: USD_100, clientSecret: secret });
    const t = (await s.transfers.byKey(key))!;
    expect(t.state).toBe('submitted');
    const leaks = await db.query<{ n: number }>(
      `select (select count(*) from ops.transfer where note like $1)::int + (select count(*) from ops.transfer_event where reason like $1)::int + (select count(*) from ops.outbox where payload::text like $1)::int
            + (select count(*) from ops.external_ref where external_id like $1)::int + (select count(*) from ops.inbound_event where payload::text like $1)::int as n`,
      [`%${secret}%`],
    );
    expect(leaks.rows[0]).toEqual({ n: 0 });
    // Asked again while the sheet is open: the same load, the secret again, still nothing posted.
    expect(await svc.request(member, { memberPartyId: member, amount: USD_100, method: 'card', paymentMethodId: 'pm_sheet' }, key, NOW)).toMatchObject({ id: t.id, state: 'requires_action', clientSecret: secret });
    expect(await journals(key)).toBe(0);

    const before = await available();
    const verifier = svc.webhookVerifier();
    const notice = async (eventId: string, status: VendorLoad['status']) => {
      const raw = JSON.stringify({ eventId, loadId: 'vl_1', status });
      const v = await verifier.verify({ 'x-sig': 'ok' }, raw, NOW);
      expect(v.ok).toBe(true);
      expect(JSON.stringify(v.payload)).not.toContain(secret);
      return svc.applyWebhook({ provider: 'scripted', eventId, receivedAt: NOW.toISOString(), signatureOk: true, payload: v.payload }, NOW);
    };
    expect(await notice('evt-sheet-1', 'processing')).toMatchObject({ state: 'submitted' });
    expect(await notice('evt-sheet-2', 'succeeded')).toMatchObject({ id: t.id, state: 'settled' });
    expect(await notice('evt-sheet-3', 'succeeded')).toMatchObject({ state: 'settled' });
    expect(await available()).toBe(before + 10_000n);
    expect(await journals(key)).toBe(1);
    await expect(notice('evt-sheet-4', 'failed')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await verifier.verify({ 'x-sig': 'bad' }, JSON.stringify({ eventId: 'evt-forged' }), NOW))).toMatchObject({ ok: false, eventId: 'evt-forged', reason: 'bad signature' });
    expect(await svc.request(member, { memberPartyId: member, amount: USD_100, method: 'card' }, key, NOW)).toEqual({ id: t.id, state: 'settled', amount: USD_100 });
  });
});

describe('TST-WAL-006: loads into the chosen purse', () => {
  const MIN = 60_000;
  const purse = async (currency: 'USD' | 'ILS', party = member) => {
    const p = (await app.services.accounts.purses(party)).find((x) => x.currency === currency)!;
    return { available: p.available.minor, holds: p.holds.minor };
  };
  const postingsOf = async (key: string) =>
    (
      await db.query<{ type: string; currency: string; amount_minor: string }>(
        `select a.type::text as type, p.currency::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id join ledger.journal j on j.id = p.journal_id where j.idempotency_key = $1 order by p.amount_minor desc`,
        [key],
      )
    ).rows;
  const metadataOf = async (key: string) => (await db.query<{ metadata: Record<string, unknown> }>(`select metadata from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.metadata;
  /** The simulator, counting the pulls: a refused load must never reach the vendor. */
  const counting = () => {
    const sim = host.simulators.funding;
    const port = {
      pulls: 0,
      createLoad(input: Parameters<FundingPort['createLoad']>[0], key: string) {
        port.pulls += 1;
        return sim.createLoad(input, key);
      },
      getLoad: (id: string) => sim.getLoad(id),
      refund: (input: Parameters<FundingPort['refund']>[0], key: string) => sim.refund(input, key),
      getRefund: (id: string) => sim.getRefund(id),
      parseWebhook: (headers: Record<string, string>, rawBody: string) => sim.parseWebhook(headers, rawBody),
    };
    const s = app.services;
    return { port, svc: new LoadService({ db, port, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider: 'simulator', rates: s.rates, markups: s.fx }) };
  };

  it('the same purse changes nothing; an unknown purse is refused; with no rate published the load is refused before the vendor', async () => {
    const r = await load({ purseCurrency: 'USD' }, 'load-same-purse-1');
    expect(r.body).toEqual({ id: expect.any(String), state: 'settled', amount: USD_100 });
    expect(await postingsOf(settleKey('load-same-purse-1'))).toEqual([
      { type: 'partner_settlement', currency: 'USD', amount_minor: '10000' },
      { type: 'wallet', currency: 'USD', amount_minor: '-10000' },
    ]);
    expect((await load({ purseCurrency: 'EUR' }, 'load-purse-eur-1')).body).toMatchObject({ code: 'VALIDATION_FAILED' });

    const { port, svc } = counting();
    await expect(svc.request(member, { memberPartyId: member, amount: USD_100, method: 'apple_pay', paymentMethodId: 'pm_ok', purseCurrency: 'ILS' }, 'load-ils-no-rate', NOW)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(port.pulls).toBe(0);
    expect(await app.services.transfers.byKey('load-ils-no-rate')).toBeUndefined();
    expect((await load({ purseCurrency: 'ILS' }, 'load-ils-no-rate-2')).body).toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
  });

  it('$100 into the shekel purse at 3.70 credits ₪367.22 after the 75 bps plan markup, in one journal through fx_position and fee income, and a replay keeps its price', async () => {
    const v1 = (await app.services.rates.publishFromPort('USD/ILS', 3_700_000n, NOW))!;
    const usdBefore = await purse('USD');
    const ilsBefore = await purse('ILS');
    const r = await load({ purseCurrency: 'ILS' }, 'load-into-ils-1');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), state: 'settled', amount: USD_100, credited: { minor: '36722', currency: 'ILS' }, rateVersion: v1.version });
    expect((await purse('ILS')).available).toBe(ilsBefore.available + 36_722n);
    expect(await purse('USD')).toEqual(usdBefore);

    expect(await postingsOf(settleKey('load-into-ils-1'))).toEqual([
      { type: 'fx_position', currency: 'ILS', amount_minor: '37000' },
      { type: 'partner_settlement', currency: 'USD', amount_minor: '10000' },
      { type: 'fee_income', currency: 'ILS', amount_minor: '-278' },
      { type: 'fx_position', currency: 'USD', amount_minor: '-10000' },
      { type: 'wallet', currency: 'ILS', amount_minor: '-36722' },
    ]);
    expect(await metadataOf(settleKey('load-into-ils-1'))).toMatchObject({ fx_rate_version: v1.version, fx_rate_id: v1.id, rate: '3.700000', fx_markup_bps: 75, loaded: USD_100, credited: { minor: '36722', currency: 'ILS' }, markup: { minor: '278', currency: 'ILS' } });
    const t = (await app.services.transfers.byKey('load-into-ils-1'))!;
    expect(t.conversion).toMatchObject({ received: money(36_722n, 'ILS'), rateVersion: v1.version, markupBps: 75n });

    // A new rate does not re-price a replay; the next load takes it.
    const v2 = (await app.services.rates.publishFromPort('USD/ILS', 3_800_000n, NOW))!;
    expect(v2.version).toBeGreaterThan(v1.version);
    expect((await load({ purseCurrency: 'ILS' }, 'load-into-ils-1')).body).toMatchObject({ credited: { minor: '36722', currency: 'ILS' }, rateVersion: v1.version });
    expect(await journals('load-into-ils-1')).toBe(1);
    expect((await purse('ILS')).available).toBe(ilsBefore.available + 36_722n);

    // ₪370.00 into the dollar purse: the inverse rate, rounded half up, gives $97.37 gross; less 75 bps ($0.73).
    const back = await load({ amount: { minor: '37000', currency: 'ILS' }, purseCurrency: 'USD' }, 'load-into-usd-1');
    expect(back.body).toMatchObject({ state: 'settled', amount: { minor: '37000', currency: 'ILS' }, credited: { minor: '9664', currency: 'USD' }, rateVersion: v2.version });
  });

  it('an ACH hold credits the pending shekel purse, and the release moves the credited amount within it', async () => {
    const key = 'load-ach-ils-1';
    const before = await purse('ILS');
    const r = await load({ method: 'ach', paymentMethodId: 'pm_bank', purseCurrency: 'ILS' }, key);
    expect(r.body).toMatchObject({ state: 'on_hold', holdUntil: '2026-11-05', amount: USD_100, credited: { minor: '37715', currency: 'ILS' } });
    expect(await purse('ILS')).toEqual({ available: before.available, holds: before.holds + 37_715n });
    expect(await postingsOf(holdKey(key))).toEqual([
      { type: 'fx_position', currency: 'ILS', amount_minor: '38000' },
      { type: 'partner_settlement', currency: 'USD', amount_minor: '10000' },
      { type: 'fee_income', currency: 'ILS', amount_minor: '-285' },
      { type: 'fx_position', currency: 'USD', amount_minor: '-10000' },
      { type: 'pending', currency: 'ILS', amount_minor: '-37715' },
    ]);

    const thursday = new Date('2026-11-05T09:00:00Z');
    const released = await app.services.loads.release((await app.services.transfers.byKey(key))!, thursday);
    expect(released.state).toBe('settled');
    expect(await purse('ILS')).toEqual({ available: before.available + 37_715n, holds: before.holds });
    expect(await postingsOf(releaseKey(key))).toEqual([
      { type: 'pending', currency: 'ILS', amount_minor: '37715' },
      { type: 'wallet', currency: 'ILS', amount_minor: '-37715' },
    ]);
  });

  it('the purse owner\'s plan sets the markup: a 25 bps plan keeps more of the load', async () => {
    const kid = uuidv7(NOW);
    await app.services.plans.ensurePlan('lean', 'Kesher Lean');
    await app.services.plans.createVersion({ planCode: 'lean', price: money(9_900n, 'USD'), termMonths: 12, entitlements: {}, fxMarkupBps: 25n, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    const m = await app.services.memberships.create({ idempotencyKey: 'm-kid-lean', memberPartyId: kid, funderPartyId: member, funderEmail: 'f@example.com', planCode: 'lean' }, NOW);
    await app.services.memberships.setStatus(m.id, 'active', NOW);
    // $100 at 3.80 is ₪380.00 gross; 25 bps is ₪0.95.
    const r = await load({ memberPartyId: kid, purseCurrency: 'ILS' }, 'load-kid-lean-1');
    expect(r.body).toMatchObject({ state: 'settled', credited: { minor: '37905', currency: 'ILS' } });
    expect(await metadataOf(settleKey('load-kid-lean-1'))).toMatchObject({ fx_markup_bps: 25, markup: { minor: '95', currency: 'ILS' } });
  });

  it('a stale rate refuses a converted load before the vendor, while a same-currency load still goes', async () => {
    const later = new Date(NOW.getTime() + 20 * MIN); // the port rate is good for 15 minutes
    const { port, svc } = counting();
    const body = { memberPartyId: member, amount: USD_100, method: 'apple_pay', paymentMethodId: 'pm_ok' };
    await expect(svc.request(member, { ...body, purseCurrency: 'ILS' }, 'load-ils-stale-1', later)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(port.pulls).toBe(0);
    expect(await app.services.transfers.byKey('load-ils-stale-1')).toBeUndefined();
    expect(await svc.request(member, { ...body, purseCurrency: 'USD' }, 'load-usd-stale-1', later)).toMatchObject({ state: 'settled', amount: USD_100 });
    expect(port.pulls).toBe(1);
  });

  it('an auto-reload rule tops up the purse of its own currency', async () => {
    const party = uuidv7(NOW);
    const ils = (await app.services.accounts.purses(party)).find((p) => p.currency === 'ILS')!;
    const ils50 = { minor: '5000', currency: 'ILS' };
    await app.services.autoReload.set(party, ils.id, { threshold: ils50, target: { minor: '20000', currency: 'ILS' }, method: 'card', paymentMethodId: 'pm_ok' }, NOW);
    const out = await app.services.autoReload.attempt((await app.services.autoReload.byAccount(ils.id))!, NOW);
    expect(out.outcome).toBe('loaded');
    expect(out.run!.transfer).toMatchObject({ state: 'settled', amount: money(20_000n, 'ILS') });
    expect(out.run!.transfer.conversion).toBeUndefined();
    expect(await purse('ILS', party)).toEqual({ available: 20_000n, holds: 0n });
    expect(await purse('USD', party)).toEqual({ available: 0n, holds: 0n });
  });

  it('the stale-load sweep also picks up a load held for the bank\'s hold days, so a return during the hold is found (F05)', async () => {
    const old = new Date(NOW.getTime() - 3_600_000);
    const [held, settled] = [uuidv7(), uuidv7()];
    await seedTransfer(db, { id: held, kind: 'load', state: 'pending_hold', market: 'US', at: old });
    await seedTransfer(db, { id: settled, kind: 'load', state: 'settled', market: 'US', at: old });
    const stale = (await app.services.loads.stale(NOW, 60_000, 1000)).map((t) => t.id);
    expect(stale).toContain(held);
    expect(stale).not.toContain(settled);
  });

  describe('a held load is asked about once per interval (T-0558, TST-WAL-003)', () => {
    const achLoad = (key: string) => load({ method: 'ach', paymentMethodId: 'pm_bank', amount: { minor: '1500', currency: 'USD' } }, key);
    const staleIds = async (at: Date) => (await app.services.loads.stale(at, 60_000, 1000)).map((t) => t.id);
    const HOUR = 3_600_000;

    it('a never-asked hold is swept; once asked it waits out HELD_RECHECK_MS, and a due hold is swept every cycle', async () => {
      expect((await achLoad('load-asked-1')).status).toBe(201);
      const t = (await app.services.transfers.byKey('load-asked-1'))!;
      expect(t).toMatchObject({ state: 'pending_hold', holdReleasesAt: '2026-11-05T09:00:00.000Z' });
      const t0 = new Date(NOW.getTime() + HOUR);
      expect(await staleIds(t0)).toContain(t.id); // no marker: asked on its first sweep
      await app.services.loads.recordAsked(t.id, t0);
      expect(await staleIds(new Date(t0.getTime() + HOUR))).not.toContain(t.id);
      expect(await staleIds(new Date(t0.getTime() + HELD_RECHECK_MS - 1))).not.toContain(t.id);
      expect(await staleIds(new Date(t0.getTime() + HELD_RECHECK_MS))).toContain(t.id); // asked again after the interval
      // A fresh marker never hides a due hold: asked every cycle until it releases.
      const due = new Date('2026-11-05T09:01:00Z');
      await app.services.loads.recordAsked(t.id, new Date(due.getTime() - 60_000));
      expect(await staleIds(due)).toContain(t.id);
      // The marker is one row per load, upserted.
      await app.services.loads.recordAsked(t.id, due);
      expect((await db.query(`select 1 from ops.load_check where transfer_id = $1`, [t.id])).rows).toHaveLength(1);
    });

    it('the marker is about held loads only: a submitted load with a marker is still swept', async () => {
      const id = uuidv7();
      await seedTransfer(db, { id, kind: 'load', state: 'submitted', market: 'US', at: new Date(NOW.getTime() - HOUR) });
      await app.services.loads.recordAsked(id, NOW);
      expect(await staleIds(NOW)).toContain(id);
    });

    it('the marker never moves backwards, and release() itself writes it for an ordinary read (N1, N2)', async () => {
      expect((await achLoad('load-asked-release-1')).status).toBe(201);
      const t = (await app.services.transfers.byKey('load-asked-release-1'))!;
      const at = new Date(NOW.getTime() + HOUR);
      expect((await app.services.loads.release(t, at)).state).toBe('settled');
      const marker = async () => (await db.query<{ last_asked_at: Date }>(`select last_asked_at from ops.load_check where transfer_id = $1`, [t.id])).rows[0]!.last_asked_at.getTime();
      expect(await marker()).toBe(at.getTime());
      await app.services.loads.recordAsked(t.id, new Date(at.getTime() - HOUR)); // an older clock reading
      expect(await marker()).toBe(at.getTime());
      await app.services.loads.recordAsked(t.id, new Date(at.getTime() + HOUR));
      expect(await marker()).toBe(at.getTime() + HOUR);
    });

    it('an UNKNOWN_LOAD hold records its marker, opens one case, and is not swept again inside the interval', async () => {
      expect((await achLoad('load-asked-unknown-1')).status).toBe(201);
      const t = (await app.services.transfers.byKey('load-asked-unknown-1'))!;
      const ask = vi.spyOn(host.simulators.funding, 'getLoad').mockRejectedValue(new FundingError('UNKNOWN_LOAD', 'no such load'));
      const at = new Date(NOW.getTime() + HOUR);
      expect((await app.services.loads.release(t, at)).state).toBe('pending_hold');
      ask.mockRestore();
      expect((await db.query<{ last_asked_at: Date }>(`select last_asked_at from ops.load_check where transfer_id = $1`, [t.id])).rows[0]!.last_asked_at.getTime()).toBe(at.getTime());
      expect((await db.query(`select 1 from ops.case where kind = 'load_unknown' and dedupe_key = $1`, [`load-unknown:${t.id}`])).rows).toHaveLength(1);
      expect(await staleIds(new Date(at.getTime() + HOUR))).not.toContain(t.id);
    });
  });

  describe('a fail racing a hold, and a load the vendor does not know (T-0547)', () => {
    const holds = async () => (await app.services.accounts.purses(member)).find((p) => p.currency === 'USD')!.holds.minor;
    const reversals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [`${holdKey(key)}:reversal`])).rows[0]!.n;
    const achLoad = (key: string) => load({ method: 'ach', paymentMethodId: 'pm_bank', amount: { minor: '3000', currency: 'USD' } }, key);

    it('a fail between the hold journal and the row moving to held reverses the journal; a fail before the journal posts is repaired by the hold itself', async () => {
      // (b) The fail runs after the hold journal is posted and before the row says held: it sees `submitted` and must still reverse it.
      const before = await holds();
      const realApply = app.services.transfers.apply.bind(app.services.transfers);
      const spy = vi.spyOn(app.services.transfers, 'apply').mockImplementation(async (id, event, now, extra) => {
        if (event === 'hold') await app.services.loads.fail((await app.services.transfers.get(id))!, 'RETURNED', NOW);
        return realApply(id, event, now, extra);
      });
      await achLoad('load-race-b-1');
      spy.mockRestore();
      expect((await app.services.transfers.byKey('load-race-b-1'))!.state).toBe('failed');
      expect(await holds()).toBe(before);
      expect(await reversals('load-race-b-1')).toBe(1);
      // (a) The fail runs before the journal exists: nothing to reverse then, so the hold, finding the row failed, reverses its own journal.
      const realPost = app.services.ledger.post.bind(app.services.ledger);
      const post = vi.spyOn(app.services.ledger, 'post').mockImplementation(async (input) => {
        if (input.idempotencyKey === holdKey('load-race-a-1')) await app.services.loads.fail((await app.services.transfers.byKey('load-race-a-1'))!, 'RETURNED', NOW);
        return realPost(input);
      });
      await achLoad('load-race-a-1');
      post.mockRestore();
      expect((await app.services.transfers.byKey('load-race-a-1'))!.state).toBe('failed');
      expect(await holds()).toBe(before);
      expect(await reversals('load-race-a-1')).toBe(1);
    });

    it('a held load the vendor does not know opens one case and is not asked again', async () => {
      expect((await achLoad('load-unknown-1')).status).toBe(201);
      const t = (await app.services.transfers.byKey('load-unknown-1'))!;
      const beforeAvailable = await available();
      const ask = vi.spyOn(host.simulators.funding, 'getLoad').mockRejectedValue(new FundingError('UNKNOWN_LOAD', 'no such load'));
      expect((await app.services.loads.release(t, NOW)).state).toBe('pending_hold');
      expect((await app.services.loads.release(t, NOW)).state).toBe('pending_hold');
      expect(ask).toHaveBeenCalledTimes(1);
      ask.mockRestore();
      expect((await db.query(`select 1 from ops.case where kind = 'load_unknown' and dedupe_key = $1`, [`load-unknown:${t.id}`])).rows).toHaveLength(1);
      expect(await app.services.loads.unknownLoadOpen(t.id)).toBe(true);
      // Nothing was credited while the case was open; once people resolve it the vendor is asked again and the load goes on.
      expect(await available()).toBe(beforeAvailable);
      await db.query(`update ops.case set status = 'resolved' where dedupe_key = $1`, [`load-unknown:${t.id}`]);
      expect(await app.services.loads.unknownLoadOpen(t.id)).toBe(false);
      expect((await app.services.loads.release(t, NOW)).state).toBe('settled');
      expect(await available()).toBe(beforeAvailable + 3_000n);
    });

    it('a case people resolved while the vendor still does not know the load is reopened, with what was decided kept, and the vendor is not asked again until they act (T-0680)', async () => {
      expect((await achLoad('load-unknown-2')).status).toBe(201);
      const t = (await app.services.transfers.byKey('load-unknown-2'))!;
      const key = `load-unknown:${t.id}`;
      const ask = vi.spyOn(host.simulators.funding, 'getLoad').mockRejectedValue(new FundingError('UNKNOWN_LOAD', 'no such load'));
      await app.services.loads.release(t, NOW);
      await db.query(`update ops.case set status = 'dismissed', resolution = 'looked, will check with the bank', decided_by = 'staff-1', assigned_to = 'staff-1' where dedupe_key = $1`, [key]);
      expect(await app.services.loads.unknownLoadOpen(t.id)).toBe(false);
      // The vendor is asked again, still does not know the load: the same case reopens (never a silent stall).
      expect((await app.services.loads.release(t, NOW)).state).toBe('pending_hold');
      const reopened = (await db.query<{ status: string; resolution: string | null; payload: { reopened?: { was: string; resolution: string | null } } }>(`select status, resolution, payload from ops.case where dedupe_key = $1`, [key])).rows;
      expect(reopened).toHaveLength(1);
      expect(reopened[0]).toMatchObject({ status: 'open', resolution: null });
      // Nothing of the earlier decision or assignment lingers on the reopened case.
      expect((await db.query(`select 1 from ops.case where dedupe_key = $1 and decided_by is null and assigned_to is null and disposition is null`, [key])).rows).toHaveLength(1);
      expect(reopened[0]!.payload.reopened).toMatchObject({ was: 'dismissed', resolution: 'looked, will check with the bank' });
      expect(await app.services.loads.unknownLoadOpen(t.id)).toBe(true);
      // Open again: not asked, not reopened twice.
      const asks = ask.mock.calls.length;
      await app.services.loads.release(t, NOW);
      expect(ask.mock.calls.length).toBe(asks);
      ask.mockRestore();
    });
  });

  it('held loads do not starve the submitted ones: with a small limit the submitted load comes first', async () => {
    const old = new Date(NOW.getTime() - 7_200_000);
    const older = new Date(NOW.getTime() - 9_000_000);
    const [held, submitted] = [uuidv7(), uuidv7()];
    await seedTransfer(db, { id: held, kind: 'load', state: 'pending_hold', market: 'US', at: older });
    await seedTransfer(db, { id: submitted, kind: 'load', state: 'submitted', market: 'US', at: old });
    // Earlier tests in this file leave stale submitted loads of their own, so ask for exactly as many as exist.
    const submittedCount = Number((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where kind = 'load' and state = 'submitted' and market = 'US' and updated_at <= $1`, [new Date(NOW.getTime() - 60_000)])).rows[0]!.n);
    const firstPage = (await app.services.loads.stale(NOW, 60_000, submittedCount)).map((t) => t.id);
    expect(firstPage).toContain(submitted);
    expect(firstPage).not.toContain(held); // the limit is filled by submitted loads; the held one waits
    expect((await app.services.loads.stale(NOW, 60_000, submittedCount + 1)).map((t) => t.id)).toContain(held);
  });

  it('a release that dies after the row moved to pending is finished by the vendor\'s confirmation, a retry or the sweep, and never credits twice (T-0543, F09)', async () => {
    const crashAtSettle = async (run: () => Promise<unknown>) => {
      const transfers = app.services.transfers;
      const real = transfers.apply.bind(transfers);
      let boom = true;
      transfers.apply = async (id, event, at, extra) => {
        if (event === 'settle' && boom) {
          boom = false;
          throw new Error('db down');
        }
        return real(id, event, at, extra);
      };
      try {
        await expect(run()).rejects.toThrow('db down');
      } finally {
        transfers.apply = real;
      }
    };
    const stuck = async (key: string) => {
      const r = await load({ method: 'ach', paymentMethodId: 'pm_bank', amount: { minor: '5000', currency: 'USD' } }, key);
      const t = (await app.services.transfers.byKey(key))!;
      expect(r.body).toMatchObject({ state: 'on_hold' });
      await crashAtSettle(() => app.services.loads.release(t, new Date('2026-11-05T09:00:00Z')));
      const pending = (await app.services.transfers.get(t.id))!;
      expect(pending.state).toBe('pending');
      return pending;
    };
    const count = async (k: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [k])).rows[0]!.n;

    // (a) the vendor says it succeeded (webhook) while the row is pending: it settles the release, it does not post a second credit.
    const before = await available();
    const a = await stuck('load-pending-hook-1');
    expect(await available()).toBe(before + 5_000n); // the release journal already credited the wallet
    expect((await hook(host.simulators.funding.webhookFor((await vendorLoadOf(a.id))!, 'succeeded'))).status).toBe(200);
    expect((await app.services.transfers.get(a.id))!.state).toBe('settled');
    expect(await available()).toBe(before + 5_000n);
    expect(await count(settleKey('load-pending-hook-1'))).toBe(0);

    // (b) the member's retry with the same key.
    const b = await stuck('load-pending-retry-1');
    const again = await load({ method: 'ach', paymentMethodId: 'pm_bank', amount: { minor: '5000', currency: 'USD' } }, 'load-pending-retry-1');
    expect(again.body).toMatchObject({ id: b.id, state: 'settled' });
    expect(await available()).toBe(before + 10_000n);
    expect(await count(settleKey('load-pending-retry-1'))).toBe(0);
    expect(await count(releaseKey('load-pending-retry-1'))).toBe(1);

    // (c) the sweep picks a stuck pending load up, and asking the vendor finishes it the same way.
    const c = await stuck('load-pending-sweep-1');
    const sweepAt = new Date('2026-11-05T10:00:00Z');
    expect((await app.services.loads.stale(sweepAt, 60_000, 1000)).map((t) => t.id)).toContain(c.id);
    const { applyVendorState } = await import('./loads.ts');
    const vendor = await host.simulators.funding.getLoad((await vendorLoadOf(c.id))!);
    expect((await applyVendorState(app.services.loads, c, vendor, c.idempotencyKey, sweepAt)).transfer.state).toBe('settled');
    expect(await available()).toBe(before + 15_000n);
    expect(await count(settleKey('load-pending-sweep-1'))).toBe(0);
  });

  it('a pending load is swept ahead of loads still in their hold, even when more held loads are older than the limit (T-0543)', async () => {
    const [held1, held2, held3, pending] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    const ancient = new Date(NOW.getTime() - 30 * 86_400_000);
    for (const id of [held1, held2, held3]) await seedTransfer(db, { id, kind: 'load', state: 'pending_hold', market: 'US', at: ancient });
    await seedTransfer(db, { id: pending, kind: 'load', state: 'pending', market: 'US', at: new Date(NOW.getTime() - 86_400_000) });
    // The limit is the number of rows that must come first (submitted or pending): the held ones, however old, wait behind them.
    const first = Number((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where kind = 'load' and market = 'US' and state in ('submitted', 'pending') and updated_at <= $1`, [new Date(NOW.getTime() - 60_000)])).rows[0]!.n);
    const page = (await app.services.loads.stale(NOW, 60_000, first)).map((t) => t.id);
    expect(page).toContain(pending);
    for (const id of [held1, held2, held3]) expect(page).not.toContain(id);
  });

  it('the stale-load sweep sees only this market\'s loads, so it asks only this market\'s provider (T-0028)', async () => {
    const old = new Date(NOW.getTime() - 3_600_000);
    const [us, il] = [uuidv7(), uuidv7()];
    await seedTransfer(db, { id: us, kind: 'load', state: 'submitted', market: 'US', at: old });
    await seedTransfer(db, { id: il, kind: 'load', state: 'submitted', market: 'IL', at: old });
    const stale = (await app.services.loads.stale(NOW, 60_000, 1000)).map((t) => t.id);
    expect(stale).toContain(us);
    expect(stale).not.toContain(il);
  });

});

describe('a returned ACH debit through the real Stripe adapter (T-0539, F05)', () => {
  const HOLD_END = new Date('2026-11-05T09:00:00Z'); // Monday + 3 business days
  const clock = fixedClock(NOW.toISOString()) as AdvanceableClock;
  // One fake for the file's tests: its ids advance like Stripe's, so two loads never share a vendor id.
  let shared: { fake: FakeStripe; svc: LoadService } | undefined;
  const stripe = () => {
    if (shared) return shared;
    const fake = new FakeStripe({ secretKey: 'sk_test_fake_key', webhookSecret: 'whsec_fake_signing_secret', clock });
    const port = new StripeFundingAdapter({ secretKey: 'sk_test_fake_key', webhookSecret: 'whsec_fake_signing_secret', fetch: fake.fetch, clock });
    const s = app.services;
    shared = { fake, svc: new LoadService({ db, port, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider: 'stripe' }) };
    return shared;
  };
  const heldLoad = async (svc: LoadService, party: string, key: string) => {
    const run = await runLoad(svc, { payerPartyId: party, memberPartyId: party, method: 'ach', amount: money(8_000n, 'USD'), paymentMethodId: 'pm_us_bank_ok' }, key, NOW);
    return { run, loadId: (await svc.vendorLoadOf(run.transfer.id))! };
  };
  const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.n;
  const newParty = async () => {
    const party = uuidv7(NOW);
    await app.services.accounts.provisionMember(party);
    return party;
  };

  it('the payment_failed webhook fails the held load and reverses the hold once; a repeat changes nothing', async () => {
    const { fake, svc } = stripe();
    const party = await newParty();
    const key = `stripe-ach-hook-${party}`;
    const { run, loadId } = await heldLoad(svc, party, key);
    expect(run.transfer).toMatchObject({ state: 'pending_hold' });
    const hook = fake.settlePaymentIntent(loadId, 'returned');
    const v = await svc.webhookVerifier().verify(hook.headers, hook.rawBody, NOW);
    expect(v.ok).toBe(true);
    const event = { provider: 'funding', eventId: v.eventId, receivedAt: NOW.toISOString(), signatureOk: true, payload: v.payload };
    expect(await svc.applyWebhook(event, NOW)).toMatchObject({ state: 'failed', failureCode: 'insufficient_funds' });
    expect(await svc.applyWebhook(event, NOW)).toMatchObject({ state: 'failed' });
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await available(party)).toBe(0n);
  });

  // T-0781 security guard: the live Stripe funding receiver (app.ts binds `loads.webhookVerifier()`, which calls the adapter's
  // verifyStripeSignature with a 5-minute tolerance) refuses a forged, a missing and a replayed (stale) signature.
  it('the Stripe funding receiver refuses a forged, a missing and a stale signature, and accepts one at the edge of the window', async () => {
    const { fake, svc } = stripe();
    const party = await newParty();
    const { loadId } = await heldLoad(svc, party, `stripe-ach-sig-${party}`);
    const hook = fake.settlePaymentIntent(loadId, 'returned');
    const verify = (headers: Record<string, string>, body = hook.rawBody) => svc.webhookVerifier().verify(headers, body, NOW);
    expect((await verify(hook.headers)).ok).toBe(true);
    const t = Math.floor(NOW.getTime() / 1000);
    expect(await verify({ 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` })).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(await verify(new FakeStripe({ secretKey: 'sk_test_fake_key', webhookSecret: 'whsec_some_other_secret', clock }).sign(hook.rawBody))).toMatchObject({ ok: false });
    expect(await verify({})).toMatchObject({ ok: false, reason: 'bad signature' });
    // A captured, correctly signed delivery replayed after the window is refused; at the edge it still verifies.
    expect(await verify(fake.sign(hook.rawBody, 301))).toMatchObject({ ok: false, reason: 'bad signature' });
    expect((await verify(fake.sign(hook.rawBody, 300))).ok).toBe(true);
    // A body altered after signing is refused.
    expect((await verify(hook.headers, hook.rawBody + ' ')).ok).toBe(false);
  });

  it('with the webhook lost, the release on the hold date asks Stripe, fails the load and credits nothing', async () => {
    const { fake, svc } = stripe();
    const party = await newParty();
    const key = `stripe-ach-lost-${party}`;
    const { run, loadId } = await heldLoad(svc, party, key);
    fake.settlePaymentIntent(loadId, 'returned'); // the bank returned it; nobody told us
    const after = await svc.release((await app.services.transfers.get(run.transfer.id))!, HOLD_END);
    expect(after).toMatchObject({ state: 'failed', failureCode: 'insufficient_funds' });
    expect(await journals(releaseKey(key))).toBe(0);
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await available(party)).toBe(0n);
    await expect(svc.release(after, HOLD_END)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});


describe('applyVendorLoad: re-read the load, then move its transfer (T-0703)', () => {
  const svcOver = (getLoad: FundingPort['getLoad']) => {
    const s = app.services;
    return new LoadService({ db, port: { getLoad } as unknown as FundingPort, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider: 'scripted' });
  };
  const vendor = (over: Partial<VendorLoad> & { metadata?: unknown }): VendorLoad => ({ loadId: 'v:1', method: 'hosted', status: 'processing', amount: money(10_000n, 'USD'), ...over }) as VendorLoad;
  const newTransfer = async (key: string, vendorId: string) => {
    const party = uuidv7(NOW);
    await app.services.accounts.provisionMember(party);
    const svc = svcOver(async () => vendor({}));
    const t = await svc.submit(await svc.begin({ payerPartyId: party, memberPartyId: party, method: 'hosted', amount: money(10_000n, 'USD') }, key, NOW), NOW);
    await svc.link(t, vendor({ loadId: vendorId }));
    return t;
  };

  it('a load the vendor does not know, or no transfer owns, is ignored', async () => {
    const unknown = svcOver(async () => Promise.reject(new FundingError('UNKNOWN_LOAD', 'Unknown load')));
    expect(await unknown.applyVendorLoad('v:none', NOW)).toBeUndefined();
    const unowned = svcOver(async () => vendor({ loadId: 'v:nobody', status: 'succeeded' }));
    expect(await unowned.applyVendorLoad('v:nobody', NOW)).toBeUndefined();
    await expect(svcOver(async () => Promise.reject(new FundingError('PROVIDER_UNAVAILABLE', 'down'))).applyVendorLoad('v:x', NOW)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('a load asked for by one of its payments is found through the id the transfer is linked under, and is settled once, whatever the repeat', async () => {
    const t = await newTransfer('avl-alias-0001', 'v:intent-1');
    const svc = svcOver(async () => vendor({ loadId: 'v:payment-1', status: 'succeeded', metadata: { intentLoadId: 'v:intent-1' } }));
    expect(await svc.applyVendorLoad('v:payment-1', NOW)).toMatchObject({ id: t.id, state: 'settled' });
    expect(await svc.applyVendorLoad('v:payment-1', NOW)).toMatchObject({ id: t.id, state: 'settled' });
    expect(await journals('avl-alias-0001')).toBe(1);
    // The journal names the id the transfer is linked under, not the payment's.
    const meta = (await db.query<{ metadata: { loadId: string } }>(`select metadata from ledger.journal where idempotency_key = $1`, [settleKey('avl-alias-0001')])).rows[0]!.metadata;
    expect(meta.loadId).toBe('v:intent-1');
  });

  describe('a return after release opens a case and moves nothing (T-0742, TST-WAL-003)', () => {
    const returnedCases = async (transferId: string) => (await db.query<{ kind: string; severity: string; status: string; payload: Record<string, unknown> }>(`select kind, severity, status, payload from ops.case where dedupe_key = $1`, [`load-returned:${transferId}`])).rows;
    const journalCount = async (transferId: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where transfer_id = $1`, [transferId])).rows[0]!.n;
    const settledLoad = async (key: string, vendorId: string) => {
      const t = await newTransfer(key, vendorId);
      await svcOver(async () => vendor({ loadId: vendorId, status: 'succeeded' })).applyVendorLoad(vendorId, NOW);
      return { t, party: t.toPartyId };
    };

    it('a settled load the vendor now reads RETURNED opens ONE high case with ids, amount and code; no journal, no state change, the balance stays; a repeat opens no second', async () => {
      const { t, party } = await settledLoad('avl-late-0001', 'v:intent-2');
      const balance = await available(party);
      const journalsBefore = await journalCount(t.id);
      expect(balance).toBe(10_000n);
      const late = svcOver(async () => vendor({ loadId: 'v:intent-2', status: 'failed', failureCode: 'RETURNED' }));
      expect(await late.applyVendorLoad('v:intent-2', NOW)).toMatchObject({ id: t.id, state: 'settled' });
      expect(await late.applyVendorLoad('v:intent-2', NOW)).toMatchObject({ id: t.id, state: 'settled' });
      expect(await returnedCases(t.id)).toEqual([{ kind: 'load_returned_after_release', severity: 'high', status: 'open', payload: expect.objectContaining({ transferId: t.id, loadId: 'v:intent-2', amount: { minor: '10000', currency: 'USD' }, memberPartyId: party, failureCode: 'RETURNED' }) }]);
      expect(await journalCount(t.id)).toBe(journalsBefore);
      expect((await app.services.transfers.get(t.id))!.state).toBe('settled');
      expect(await available(party)).toBe(balance);
    });

    it('a REFUNDED or CANCELLED read opens the same kind of case with that code; a resolved case is reopened by a later read, the decision kept in the payload', async () => {
      const { t } = await settledLoad('avl-late-0002', 'v:intent-3');
      const svc = (code: string) => svcOver(async () => vendor({ loadId: 'v:intent-3', status: 'failed', failureCode: code }));
      await svc('REFUNDED').applyVendorLoad('v:intent-3', NOW);
      expect(await returnedCases(t.id)).toMatchObject([{ status: 'open', payload: { failureCode: 'REFUNDED' } }]);
      await db.query(`update ops.case set status = 'resolved' where dedupe_key = $1`, [`load-returned:${t.id}`]);
      await svc('CANCELLED').applyVendorLoad('v:intent-3', NOW);
      expect(await returnedCases(t.id)).toMatchObject([{ status: 'open', payload: { failureCode: 'CANCELLED', reopened: { was: 'resolved' } } }]);
    });

    it('a return BEFORE release still fails the load and opens no case; a failed read with no failure code is VENDOR_FAILED', async () => {
      const t = await newTransfer('avl-early-001', 'v:intent-4');
      const early = svcOver(async () => vendor({ loadId: 'v:intent-4', status: 'failed', failureCode: 'RETURNED' }));
      expect(await early.applyVendorLoad('v:intent-4', NOW)).toMatchObject({ id: t.id, state: 'failed' });
      expect(await returnedCases(t.id)).toEqual([]);
      const { t: t2 } = await settledLoad('avl-late-0003', 'v:intent-5');
      await svcOver(async () => vendor({ loadId: 'v:intent-5', status: 'failed' })).applyVendorLoad('v:intent-5', NOW);
      expect(await returnedCases(t2.id)).toMatchObject([{ payload: { failureCode: 'VENDOR_FAILED' } }]);
    });
  });
});

describe('a hosted load needs the member\'s funding account (T-0740, TST-WAL-002)', () => {
  type Details = { firstName: string; lastName: string; email: string; mobile: string; dateOfBirth?: string };
  let n = 0;
  /** One vendor for the block: its contact refs are unique per provider in ops.external_ref. */
  const accounts = new FundingAccountSimulator();
  /** A fresh payer each time, so the vendor's party-and-mobile rules never cross between cases. Fake details, never a real person's. */
  const setup = (over: { email?: string; details?: boolean } = {}) => {
    const s = app.services;
    n += 1;
    const party = uuidv7(NOW);
    const ensure = vi.spyOn(accounts, 'ensureAccount');
    ensure.mockReset();
    const sim = host.simulators.funding;
    const seen: Parameters<FundingPort['createLoad']>[0][] = [];
    const port: FundingPort = {
      async createLoad(input, key) {
        seen.push(input);
        return sim.createLoad({ ...input, method: 'card', paymentMethodId: 'pm_ok' }, key);
      },
      getLoad: (id) => sim.getLoad(id),
      refund: (input, key) => sim.refund(input, key),
      getRefund: (id) => sim.getRefund(id),
      parseWebhook: (headers, rawBody) => sim.parseWebhook(headers, rawBody),
    };
    const stored: Details = { firstName: 'Test', lastName: 'Member', email: over.email ?? `member${n}@example.test`, mobile: `+1415555${String(1000 + n).padStart(4, '0')}` };
    const details = { read: vi.fn(async (): Promise<Details | undefined> => (over.details === false ? undefined : stored)) };
    const deps = { db, port, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: new StaticFlags(undefined, { 'wallet.enabled': true }), provider: 'simulator-funding' };
    const svc = new LoadService({ ...deps, fundingAccounts: accounts, details });
    return { party, svc, accounts, ensure, details, seen, stored, port };
  };
  const hostedBody = (party: string) => ({ memberPartyId: party, amount: USD_100, method: 'hosted' });
  const refs = async (party: string) => (await db.query<{ entity_type: string; provider: string; external_id: string }>(`select entity_type, provider, external_id from ops.external_ref where entity_id = $1 order by entity_type`, [party])).rows;
  const transfersOf = async (party: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where from_party_id = $1`, [party])).rows[0]!.n;
  const cases = async (party: string) => (await db.query<{ kind: string; payload: unknown }>(`select kind, payload from ops.case where dedupe_key = $1`, [`funding-account:${party}`])).rows;

  it('no stored details: 422 VALIDATION_FAILED with detailsRequired, before any vendor call and with no transfer', async () => {
    const t = setup({ details: false });
    await expect(t.svc.request(t.party, hostedBody(t.party), 'hosted-nodetails-1', NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', extra: { detailsRequired: true } });
    expect(t.ensure).not.toHaveBeenCalled();
    expect(t.seen).toHaveLength(0);
    expect(await transfersOf(t.party)).toBe(0);
    expect(await refs(t.party)).toEqual([]);
  });

  it('with details: ensureAccount once under funding-account:{partyId}, both refs written, and the pull carries the contact ref', async () => {
    const t = setup();
    const view = await t.svc.request(t.party, hostedBody(t.party), 'hosted-first-001', NOW);
    expect(view.state).toBe('settled'); // the scripted vendor answers a card here; the hosted request fields are T-0714
    expect(t.ensure).toHaveBeenCalledTimes(1);
    expect(t.ensure.mock.calls[0]![1]).toBe(`funding-account:${t.party}`);
    expect(t.ensure.mock.calls[0]![0]).toMatchObject({ partyId: t.party, firstName: 'Test', mobile: t.stored.mobile });
    const rows = await refs(t.party);
    expect(rows.map((r) => [r.entity_type, r.provider])).toEqual([['funding_account', 'simulator-funding'], ['funding_contact', 'simulator-funding']]);
    const contact = rows.find((r) => r.entity_type === 'funding_contact')!.external_id;
    expect(t.seen[0]!.customerId).toBe(contact);
    expect(t.seen[0]!.customerId).not.toBe(t.party);
    expect(JSON.stringify(view)).not.toContain(rows.find((r) => r.entity_type === 'funding_account')!.external_id);
    expect(JSON.stringify(view)).not.toContain(contact);
  });

  it('the second hosted load makes no ensureAccount call and reads no details: the rows are read first', async () => {
    const t = setup();
    await t.svc.request(t.party, hostedBody(t.party), 'hosted-twice-001', NOW);
    t.ensure.mockClear();
    t.details.read.mockClear();
    await t.svc.request(t.party, hostedBody(t.party), 'hosted-twice-002', NOW);
    expect(t.ensure).not.toHaveBeenCalled();
    expect(t.details.read).not.toHaveBeenCalled();
    expect(await refs(t.party)).toHaveLength(2);
    expect(t.seen[1]!.customerId).toBe(t.seen[0]!.customerId);
  });

  it.each(['rejected', 'archived', 'frozen'])('a %s member is refused with FEATURE_OFF naming the status, nothing created, before the transfer begins', async (status) => {
    const t = setup({ email: `${status}@example.test` });
    const err = await t.svc.request(t.party, hostedBody(t.party), `hosted-${status}-01`, NOW).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'FEATURE_OFF' });
    const text = JSON.stringify([(err as Error).message, (err as { extra?: unknown }).extra]);
    expect(text).toContain(status);
    expect(text).not.toContain(t.stored.mobile);
    expect(text).not.toContain('Member');
    expect(t.seen).toHaveLength(0);
    expect(await transfersOf(t.party)).toBe(0);
    expect(await refs(t.party)).toEqual([]);
  });

  it('a closed account is refused the same way', async () => {
    const t = setup();
    t.ensure.mockResolvedValueOnce({ contactRef: 'c:9', accountRef: 'a:9', status: 'closed' });
    await expect(t.svc.request(t.party, hostedBody(t.party), 'hosted-closed-01', NOW)).rejects.toMatchObject({ code: 'FEATURE_OFF', message: expect.stringContaining('closed') });
    expect(await refs(t.party)).toEqual([]);
  });

  it.each(['DUPLICATE_MOBILE', 'PARTY_CONFLICT'] as const)('%s is 409 IDEMPOTENCY_CONFLICT with a fixed message and one case for people', async (code) => {
    const t = setup();
    t.ensure.mockRejectedValue(new FundingAccountError(code, `vendor text with ${t.stored.mobile}`));
    for (const k of ['hosted-conflict-a1', 'hosted-conflict-a2']) {
      const err = await t.svc.request(t.party, hostedBody(t.party), k, NOW).catch((e: unknown) => e as Error);
      expect(err).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect((err as Error).message).not.toContain(t.stored.mobile);
    }
    const rows = await cases(t.party);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('load_account_conflict');
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(t.stored.mobile);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('Member');
    expect(await refs(t.party)).toEqual([]);
    expect(await transfersOf(t.party)).toBe(0);
  });

  it('a vendor outage is PROVIDER_UNAVAILABLE and nothing is created', async () => {
    const t = setup({ email: 'outage@example.test' });
    await expect(t.svc.request(t.party, hostedBody(t.party), 'hosted-outage-01', NOW)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await refs(t.party)).toEqual([]);
    expect(await transfersOf(t.party)).toBe(0);
    expect(t.seen).toHaveLength(0);
  });

  it('a hosted load for another member is FORBIDDEN, and without the account dependencies the hosted path is FEATURE_OFF', async () => {
    const t = setup();
    const other = uuidv7(NOW);
    await expect(t.svc.request(t.party, hostedBody(other), 'hosted-other-001', NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(t.ensure).not.toHaveBeenCalled();
    const s = app.services;
    const bare = new LoadService({ db, port: t.port, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: new StaticFlags(undefined, { 'wallet.enabled': true }), provider: 'simulator-funding' });
    await expect(bare.request(t.party, hostedBody(t.party), 'hosted-bare-0001', NOW)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    expect(await transfersOf(t.party)).toBe(0);
  });

  it('every other method passes the party id as the customer, with no account call', async () => {
    const t = setup();
    await t.svc.request(t.party, { memberPartyId: t.party, amount: USD_100, method: 'apple_pay', paymentMethodId: 'pm_ok' }, 'hosted-apple-0001', NOW);
    expect(t.seen[0]!.customerId).toBe(t.party);
    expect(t.ensure).not.toHaveBeenCalled();
    expect(t.details.read).not.toHaveBeenCalled();
  });
});

describe('a card load credits the vendor wallet before its journal (T-0705, TST-WAL-003)', () => {
  /** After the rows' own updated_at (set by the database clock), so the sweep finds them. */
  const LATER = new Date('2100-01-01T00:00:00Z');
  let nth = 0;
  const setup = async () => {
    const s = app.services;
    // One provider name per vendor instance: each simulator numbers its loads from 1, and the link is unique per provider.
    nth += 1;
    const provider = `simulator-credit-${nth}`;
    const sim = new FundingSimulator(fixedClock(NOW.toISOString()), { credit: true });
    const svc = new LoadService({ db, port: sim, credit: sim as Required<FundingSimulator>, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider });
    const party = uuidv7(NOW);
    await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('funding_account', $1, $3, $2)`, [party, `a:${party}`, provider]);
    const spy = vi.spyOn(sim as Required<FundingSimulator>, 'creditWallet');
    const body = { memberPartyId: party, amount: USD_100, method: 'card', paymentMethodId: 'pm_ok' };
    return { sim, svc, party, spy, body };
  };
  const caseRows = async (key: string) => (await db.query<{ status: string; payload: { attempt: number; reasonCode: string } }>(`select c.status, c.payload from ops.case c join ops.transfer t on c.dedupe_key = 'load-credit:' || t.id where t.idempotency_key = $1`, [key])).rows;

  it('credits first, then posts the single settle journal; a replay credits and posts nothing more', async () => {
    const t = await setup();
    const key = 'card-credit-0001';
    const view = await t.svc.request(t.party, t.body, key, NOW);
    expect(view.state).toBe('settled');
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(t.spy.mock.calls[0]![1]).toBe(`${key}:credit:1`);
    expect(t.spy.mock.calls[0]![0]).toMatchObject({ accountRef: `a:${t.party}`, amount: money(10_000n, 'USD') });
    expect(await journals(key)).toBe(1);
    await t.svc.request(t.party, t.body, key, NOW);
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(await journals(key)).toBe(1);
  });

  it('a refusal posts no journal, leaves the load submitted and opens one case; resolving it retries with :credit:2', async () => {
    const t = await setup();
    const key = 'card-credit-refuse';
    t.sim.failNext('ACCOUNT_UNAVAILABLE');
    const view = await t.svc.request(t.party, t.body, key, NOW);
    expect(view.state).not.toBe('settled');
    expect(await journals(key)).toBe(0);
    expect((await app.services.transfers.byKey(key))!.state).toBe('submitted');
    expect(await caseRows(key)).toMatchObject([{ status: 'open', payload: { reasonCode: 'ACCOUNT_UNAVAILABLE', attempt: 1 } }]);

    // While open the sweep does not credit again.
    const stale = await t.svc.stale(LATER, 0);
    for (const x of stale) await t.svc.applyVendorLoad((await t.svc.vendorLoadOf(x.id))!, LATER);
    expect(t.spy).toHaveBeenCalledTimes(1);

    await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'load-credit:' || $1`, [(await app.services.transfers.byKey(key))!.id]);
    for (const x of await t.svc.stale(LATER, 0)) await t.svc.applyVendorLoad((await t.svc.vendorLoadOf(x.id))!, LATER);
    expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:1`, `${key}:credit:2`]);
    expect((await app.services.transfers.byKey(key))!.state).toBe('settled');
    expect(await journals(key)).toBe(1);
    expect(await caseRows(key)).toHaveLength(1);
  });

  it('a pending credit posts nothing and the retry uses the same key; a vendor without the credit step posts as before', async () => {
    const t = await setup();
    t.sim.pendNext();
    const key = 'card-credit-pending';
    await t.svc.request(t.party, t.body, key, NOW);
    expect(await journals(key)).toBe(0);
    expect(await caseRows(key)).toEqual([]);
    for (const x of await t.svc.stale(LATER, 0)) await t.svc.applyVendorLoad((await t.svc.vendorLoadOf(x.id))!, LATER);
    expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:1`, `${key}:credit:1`]);
    expect(await journals(key)).toBe(1);
    expect((await app.services.transfers.byKey(key))!.state).toBe('settled');
  });

  it('a funder loading a member credits the MEMBER\'s vendor account, never the funder\'s; the funder having no account does not block; the member having none is NO_ACCOUNT', async () => {
    const t = await setup();
    const s = app.services;
    const funder = uuidv7(NOW);
    const member2 = uuidv7(NOW);
    const noAccount = uuidv7(NOW);
    const provider = (await db.query<{ p: string }>(`select provider as p from ops.external_ref where entity_id = $1 and entity_type = 'funding_account'`, [t.party])).rows[0]!.p;
    // The funder has an account too, to show it is never the one credited; the member's is what the ledger credits.
    await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('funding_account', $1, $2, 'a:funder'), ('funding_account', $3, $2, 'a:member')`, [funder, provider, member2]);
    const members = { forMember: async (id: string) => ({ funderPartyId: funder, status: 'active', id }) } as unknown as typeof s.memberships;
    const svc = new LoadService({ db, port: t.sim, credit: t.sim as Required<FundingSimulator>, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: members, flags: s.flags, provider });
    const body = (m: string) => ({ memberPartyId: m, amount: USD_100, method: 'card', paymentMethodId: 'pm_ok' });
    expect((await svc.request(funder, body(member2), 'funder-load-0001', NOW)).state).toBe('settled');
    expect(t.spy.mock.calls[0]![0]).toMatchObject({ accountRef: 'a:member' });
    expect(await journals('funder-load-0001')).toBe(1);

    // The member has no account ref: refused NO_ACCOUNT, no call, no journal.
    const before = t.spy.mock.calls.length;
    await svc.request(funder, body(noAccount), 'funder-load-0002', NOW);
    expect(t.spy.mock.calls.length).toBe(before);
    expect(await journals('funder-load-0002')).toBe(0);
    expect(await caseRows('funder-load-0002')).toMatchObject([{ status: 'open', payload: { reasonCode: 'NO_ACCOUNT' } }]);
  });

  it('an outage is PROVIDER_UNAVAILABLE and nothing posts; a request the vendor will never accept (an ILS load) opens one case and is not an error each cycle; NOT_SUCCEEDED after a succeeded read is pending, no case', async () => {
    const t = await setup();
    t.sim.outageNext();
    await expect(t.svc.request(t.party, t.body, 'card-credit-outage', NOW)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await journals('card-credit-outage')).toBe(0);
    expect(await caseRows('card-credit-outage')).toEqual([]);

    const ils = { ...t.body, amount: { minor: '10000', currency: 'ILS' } };
    await t.svc.request(t.party, ils, 'card-credit-ils01', NOW);
    expect(await caseRows('card-credit-ils01')).toMatchObject([{ status: 'open', payload: { reasonCode: 'VALIDATION_FAILED' } }]);
    expect(await journals('card-credit-ils01')).toBe(0);
    const ilsCalls = () => t.spy.mock.calls.filter((c) => String(c[1]).startsWith('card-credit-ils01')).length;
    const calls = ilsCalls();
    for (const x of await t.svc.stale(LATER, 0)) await t.svc.applyVendorLoad((await t.svc.vendorLoadOf(x.id))!, LATER);
    expect(ilsCalls()).toBe(calls);
    expect(await caseRows('card-credit-ils01')).toHaveLength(1);

    t.spy.mockResolvedValueOnce({ status: 'refused', reasonCode: 'NOT_SUCCEEDED' });
    await t.svc.request(t.party, t.body, 'card-credit-flap01', NOW);
    expect(await caseRows('card-credit-flap01')).toEqual([]);
    expect(await journals('card-credit-flap01')).toBe(0);
    for (const x of await t.svc.stale(LATER, 0)) await t.svc.applyVendorLoad((await t.svc.vendorLoadOf(x.id))!, LATER);
    expect(await journals('card-credit-flap01')).toBe(1);
  });

  describe('the member account is checked again at the credit, and a return before the journal opens a case (T-0742)', () => {
    const returnedCase = async (key: string) => (await db.query<{ kind: string; severity: string; status: string; payload: Record<string, unknown> }>(`select c.kind, c.severity, c.status, c.payload from ops.case c join ops.transfer t on c.dedupe_key = 'load-returned:' || t.id where t.idempotency_key = $1`, [key])).rows;

    it('a wallet account frozen after the first load is not credited: no credit call, no journal, one ACCOUNT_FROZEN case; once it is open and the case resolved, the retry credits', async () => {
      const t = await setup();
      const s = app.services;
      const provider = (await db.query<{ p: string }>(`select provider as p from ops.external_ref where entity_id = $1 and entity_type = 'funding_account'`, [t.party])).rows[0]!.p;
      const accounts = new FundingAccountSimulator();
      const ensured = await accounts.ensureAccount({ partyId: t.party, firstName: 'Test', lastName: 'Member', email: 'gate@example.test', mobile: '+14155552001' }, `funding-account:${t.party}`);
      if (!('accountRef' in ensured)) throw new Error('no account');
      await db.query(`update ops.external_ref set external_id = $3 where entity_id = $1 and entity_type = 'funding_account' and provider = $2`, [t.party, provider, ensured.accountRef]);
      const svc = new LoadService({ db, port: t.sim, credit: t.sim as Required<FundingSimulator>, fundingAccounts: accounts, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider });
      accounts.setStatus(ensured.accountRef, 'frozen');
      const key = 'card-frozen-0001';
      expect((await svc.request(t.party, t.body, key, NOW)).state).not.toBe('settled');
      expect(t.spy).not.toHaveBeenCalled();
      expect(await journals(key)).toBe(0);
      expect(await caseRows(key)).toMatchObject([{ status: 'open', payload: { reasonCode: 'ACCOUNT_FROZEN', attempt: 1 } }]);
      accounts.setStatus(ensured.accountRef, 'open');
      await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'load-credit:' || $1`, [(await s.transfers.byKey(key))!.id]);
      for (const x of await svc.stale(LATER, 0)) await svc.applyVendorLoad((await svc.vendorLoadOf(x.id))!, LATER);
      expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:2`]);
      expect(await journals(key)).toBe(1);
    });

    it('a return after the vendor credited the wallet but before our journal posted fails the load, reverses the hold only, and opens ONE high case; a repeat opens no second; no case when the vendor never credited', async () => {
      const t = await setup();
      const s = app.services;
      const provider = (await db.query<{ p: string }>(`select provider as p from ops.external_ref where entity_id = $1 and entity_type = 'funding_account'`, [t.party])).rows[0]!.p;
      let returned = false;
      let dieOnPost = true;
      const port: FundingPort = { createLoad: (i, k) => t.sim.createLoad(i, k), getLoad: async (id) => { const l = await t.sim.getLoad(id); return returned ? { ...l, status: 'failed', failureCode: 'RETURNED' } : l; }, refund: (i, k) => t.sim.refund(i, k), getRefund: (id) => t.sim.getRefund(id), parseWebhook: (h, b) => t.sim.parseWebhook(h, b) };
      const ledger = new Proxy(s.ledger, { get: (target, prop) => (prop === 'post' && dieOnPost ? async () => { dieOnPost = false; throw new Error('crash before the journal'); } : Reflect.get(target, prop, target)) }) as typeof s.ledger;
      const svc = new LoadService({ db, port, credit: t.sim as Required<FundingSimulator>, ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider });
      const key = 'card-credit-return1';
      await expect(svc.request(t.party, t.body, key, NOW)).rejects.toThrow('crash before the journal');
      const transfer = (await s.transfers.byKey(key))!;
      expect(transfer.state).toBe('submitted');
      expect(t.sim.creditCount((await svc.vendorLoadOf(transfer.id))!)).toBe(1);
      expect(await journals(key)).toBe(0);

      returned = true;
      for (const x of await svc.stale(LATER, 0)) await svc.applyVendorLoad((await svc.vendorLoadOf(x.id))!, LATER);
      for (const x of await svc.stale(LATER, 0)) await svc.applyVendorLoad((await svc.vendorLoadOf(x.id))!, LATER);
      expect((await s.transfers.byKey(key))!.state).toBe('failed');
      expect(await journals(key)).toBe(0);
      expect(await available(t.party)).toBe(0n);
      const rows = await returnedCase(key);
      expect(rows).toEqual([{ kind: 'load_returned_after_release', severity: 'high', status: 'open', payload: expect.objectContaining({ transferId: transfer.id, amount: { minor: '10000', currency: 'USD' }, failureCode: 'RETURNED', reasonCode: 'RETURNED', stage: 'before_journal' }) }]);
      expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/@|\+\d{8}/);
    });

    describe('a real credit step writes its outcome, and a later return reads it (T-0742)', () => {
      /** The outcome attempt 1 of a load recorded, read through the typed reader (empty when none). */
      const outcomes = async (key: string) => {
        const tr = (await app.services.transfers.byKey(key))!;
        const provider = (await db.query<{ p: string }>(`select provider as p from ops.external_ref where entity_id = $1 and entity_type = 'funding_account'`, [tr.toPartyId])).rows[0]!.p;
        const state = await creditAttemptState(db, { transferId: tr.id, provider, attempt: 1 });
        return state.outcome ? [state.outcome] : [];
      };
      /** The service over a vendor whose reads can be flipped to a return, with an injectable failure of the outcome write. */
      const build = async () => {
        const t = await setup();
        const s = app.services;
        const provider = (await db.query<{ p: string }>(`select provider as p from ops.external_ref where entity_id = $1 and entity_type = 'funding_account'`, [t.party])).rows[0]!.p;
        const ctl = { returned: false, dieOnOutcome: false, dieOnPost: false };
        const port: FundingPort = { createLoad: (i, k) => t.sim.createLoad(i, k), getLoad: async (id) => { const l = await t.sim.getLoad(id); return ctl.returned ? { ...l, status: 'failed', failureCode: 'RETURNED' } : l; }, refund: (i, k) => t.sim.refund(i, k), getRefund: (id) => t.sim.getRefund(id), parseWebhook: (h, b) => t.sim.parseWebhook(h, b) };
        const flaky = new Proxy(db, { get: (target, prop) => (prop === 'query' ? (async (text: string, params?: readonly unknown[]) => { if (ctl.dieOnOutcome && text.startsWith('insert') && params?.[0] === 'credit_outcome') { ctl.dieOnOutcome = false; throw new Error('outcome write failed'); } return (target.query as (t: string, p?: readonly unknown[]) => Promise<unknown>)(text, params); }) : Reflect.get(target, prop, target)) }) as typeof db;
        const ledger = new Proxy(s.ledger, { get: (target, prop) => (prop === 'post' && ctl.dieOnPost ? async () => { ctl.dieOnPost = false; throw new Error('crash before the journal'); } : Reflect.get(target, prop, target)) }) as typeof s.ledger;
        const svc = new LoadService({ db: flaky, port, credit: t.sim as Required<FundingSimulator>, ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider });
        const sweep = async () => { for (const x of await svc.stale(LATER, 0)) await svc.applyVendorLoad((await svc.vendorLoadOf(x.id))!, LATER); };
        return { ...t, svc, ctl, sweep, s };
      };

      it('(a) a refusal that opens no credit case (NOT_SUCCEEDED) writes a :refused outcome; a return then opens NO case', async () => {
        const t = await build();
        const key = 'real-refused-0001';
        t.spy.mockResolvedValueOnce({ status: 'refused', reasonCode: 'NOT_SUCCEEDED' });
        await t.svc.request(t.party, t.body, key, NOW);
        expect(await outcomes(key)).toEqual(['refused']);
        expect(await caseRows(key)).toEqual([]);
        t.ctl.returned = true;
        await t.sweep();
        expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
        expect(await returnedCase(key)).toEqual([]);
      });

      it('(b) a pending credit writes a :pending outcome; a return then opens the case', async () => {
        const t = await build();
        const key = 'real-pending-0001';
        t.sim.pendNext();
        await t.svc.request(t.party, t.body, key, NOW);
        expect(await outcomes(key)).toEqual(['pending']);
        t.ctl.returned = true;
        await t.sweep();
        expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
        expect(await returnedCase(key)).toMatchObject([{ status: 'open', payload: { stage: 'before_journal' } }]);
        expect(t.spy).toHaveBeenCalledTimes(1);
      });

      it('(c) the vendor credited and the outcome write failed: a return opens the case (crash window), and a healthy cycle instead replays the SAME key and writes the outcome', async () => {
        const t = await build();
        const key = 'real-window-0001';
        t.ctl.dieOnOutcome = true;
        await expect(t.svc.request(t.party, t.body, key, NOW)).rejects.toThrow('outcome write failed');
        expect(await outcomes(key)).toEqual([]);
        expect((await t.s.transfers.byKey(key))!.state).toBe('submitted');
        expect(t.sim.creditCount((await t.svc.vendorLoadOf((await t.s.transfers.byKey(key))!.id))!)).toBe(1);
        // A healthy next cycle: the same key, the outcome written, the one journal.
        await t.sweep();
        expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:1`, `${key}:credit:1`]);
        expect(await outcomes(key)).toEqual(['credited']);
        expect(await journals(key)).toBe(1);

        // And the other order: the window, then the return.
        const u = await build();
        const key2 = 'real-window-0002';
        u.ctl.dieOnOutcome = true;
        await expect(u.svc.request(u.party, u.body, key2, NOW)).rejects.toThrow('outcome write failed');
        u.ctl.returned = true;
        await u.sweep();
        expect((await u.s.transfers.byKey(key2))!.state).toBe('failed');
        expect(await returnedCase(key2)).toMatchObject([{ status: 'open', payload: { stage: 'before_journal' } }]);
        expect(u.spy).toHaveBeenCalledTimes(1);
      });

      describe('a credit refused NOT_SUCCEEDED and sent again under the same key is read as may-have-moved (T-0786, TST-WAL-003)', () => {
        const NOT_SUCCEEDED = { status: 'refused', reasonCode: 'NOT_SUCCEEDED' } as const;
        /** The `credit_resent` rows of a load, as `seq=value`. */
        const resentRows = async (key: string) => (await db.query<{ seq: number; value: string }>(`select m.seq, m.value from ops.workflow_marker m join ops.transfer t on m.subject_id = t.id where t.idempotency_key = $1 and m.kind = 'credit_resent' order by m.seq`, [key])).rows.map((r) => `${r.seq}=${r.value}`);

        it('(1) NOT_SUCCEEDED, then the same key credited, then the journal post throws, then a return: ONE before_journal case', async () => {
          const t = await build();
          const key = 'resent-case-0001';
          t.spy.mockResolvedValueOnce(NOT_SUCCEEDED);
          await t.svc.request(t.party, t.body, key, NOW);
          expect(await outcomes(key)).toEqual(['refused']);
          expect(await caseRows(key)).toEqual([]);
          t.ctl.dieOnPost = true;
          await expect(t.sweep()).rejects.toThrow('crash before the journal');
          expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:1`, `${key}:credit:1`]);
          expect(t.sim.creditCount((await t.svc.vendorLoadOf((await t.s.transfers.byKey(key))!.id))!)).toBe(1);
          expect(await outcomes(key)).toEqual(['refused']);
          expect(await journals(key)).toBe(0);
          t.ctl.returned = true;
          await t.sweep();
          expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
          expect(await outcomes(key)).toEqual(['refused']);
          expect(await returnedCase(key)).toMatchObject([{ kind: 'load_returned_after_release', status: 'open', payload: { stage: 'before_journal' } }]);
          expect(await caseRows(key)).toEqual([]);
          expect(t.spy).toHaveBeenCalledTimes(2);
        }, 120_000);

        it('(2) control: NOT_SUCCEEDED once and a return opens NO case and writes no credit_resent', async () => {
          const t = await build();
          const key = 'resent-ctrl-0001';
          t.spy.mockResolvedValueOnce(NOT_SUCCEEDED);
          await t.svc.request(t.party, t.body, key, NOW);
          t.ctl.returned = true;
          await t.sweep();
          expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
          expect(await returnedCase(key)).toEqual([]);
          expect(await resentRows(key)).toEqual([]);
          expect(t.spy).toHaveBeenCalledTimes(1);
        }, 120_000);

        it('(3) NOT_SUCCEEDED twice and then a return: ONE case, the same key both times, one credit_resent row', async () => {
          const t = await build();
          const key = 'resent-twice-001';
          t.spy.mockResolvedValueOnce(NOT_SUCCEEDED).mockResolvedValueOnce(NOT_SUCCEEDED);
          await t.svc.request(t.party, t.body, key, NOW);
          await t.sweep();
          expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:1`, `${key}:credit:1`]);
          expect(await outcomes(key)).toEqual(['refused']);
          expect(await caseRows(key)).toEqual([]);
          t.ctl.returned = true;
          await t.sweep();
          expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
          expect(await returnedCase(key)).toMatchObject([{ status: 'open', payload: { stage: 'before_journal' } }]);
          expect(await resentRows(key)).toEqual([`1=${key}:credit:1`]);
        }, 120_000);

        it('(4) a real refusal behaves as today: no returned case while its case is open; after resolve, attempt 2 begun, credited, a crash and a return opens one', async () => {
          const t = await build();
          const key = 'resent-real-0001';
          t.sim.failNext('ACCOUNT_UNAVAILABLE');
          await t.svc.request(t.party, t.body, key, NOW);
          expect(await caseRows(key)).toMatchObject([{ status: 'open', payload: { attempt: 1 } }]);
          t.ctl.returned = true;
          await t.sweep();
          expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
          expect(await returnedCase(key)).toEqual([]);
          expect(await resentRows(key)).toEqual([]);

          const u = await build();
          const key2 = 'resent-real-0002';
          u.sim.failNext('ACCOUNT_UNAVAILABLE');
          await u.svc.request(u.party, u.body, key2, NOW);
          await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'load-credit:' || $1`, [(await u.s.transfers.byKey(key2))!.id]);
          u.ctl.dieOnPost = true;
          await expect(u.sweep()).rejects.toThrow('crash before the journal');
          expect(u.spy.mock.calls.map((c) => c[1])).toEqual([`${key2}:credit:1`, `${key2}:credit:2`]);
          expect(await resentRows(key2)).toEqual([]);
          u.ctl.returned = true;
          await u.sweep();
          expect((await u.s.transfers.byKey(key2))!.state).toBe('failed');
          expect(await returnedCase(key2)).toMatchObject([{ status: 'open', payload: { stage: 'before_journal' } }]);
        }, 120_000);

        it('(5) two sweeps over the flap write ONE credit_resent row and ONE credit key, and the row is there before the second vendor call', async () => {
          const t = await build();
          const key = 'resent-sweep-001';
          t.spy.mockResolvedValueOnce(NOT_SUCCEEDED);
          await t.svc.request(t.party, t.body, key, NOW);
          expect(await resentRows(key)).toEqual([]);
          let seenAtCall: string[] | undefined;
          t.spy.mockImplementationOnce(async () => { seenAtCall = await resentRows(key); return { status: 'credited' as const }; });
          t.ctl.dieOnPost = true;
          await expect(t.sweep()).rejects.toThrow('crash before the journal');
          expect(seenAtCall).toEqual([`1=${key}:credit:1`]);
          await t.sweep();
          expect(await resentRows(key)).toEqual([`1=${key}:credit:1`]);
          expect(new Set(t.spy.mock.calls.map((c) => c[1]))).toEqual(new Set([`${key}:credit:1`]));
          expect(await journals(key)).toBe(1);
        }, 120_000);

        it('(model) 120 random sequences of vendor answers, crashes, resolves and a return match a reference model on calls, state, journals and the returned case', async () => {
          type Ans = 'credited' | 'pending' | 'flap' | 'real' | 'outage';
          type Step = { t: 'send'; a: Ans; die: boolean } | { t: 'resolve' } | { t: 'return' };
          let seed = 0x786;
          const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
          const answers: Ans[] = ['credited', 'pending', 'flap', 'real', 'outage', 'flap', 'flap'];
          const sim = (spy: { mockResolvedValueOnce(v: unknown): unknown; mockRejectedValueOnce(v: unknown): unknown }, a: Ans) => {
            if (a === 'pending') spy.mockResolvedValueOnce({ status: 'pending' });
            else if (a === 'flap') spy.mockResolvedValueOnce(NOT_SUCCEEDED);
            else if (a === 'real') spy.mockResolvedValueOnce({ status: 'refused', reasonCode: 'ACCOUNT_UNAVAILABLE' });
            else if (a === 'outage') spy.mockRejectedValueOnce(new FundingError('PROVIDER_UNAVAILABLE', 'down'));
          };
          for (let i = 0; i < 120; i++) {
            const steps: Step[] = [{ t: 'send', a: answers[rnd(answers.length)]!, die: rnd(4) === 0 }];
            for (let j = rnd(5); j > 0; j--) steps.push(rnd(10) < 7 ? { t: 'send', a: answers[rnd(answers.length)]!, die: rnd(3) === 0 } : { t: 'resolve' });
            if (rnd(3) > 0) steps.push({ t: 'return' });
            // The model: the records of the current attempt, the first outcome wins, a resend after a stored refusal is noted, a resolved case moves to the next attempt.
            const m = { attempt: 1, began: false, outcome: undefined as string | undefined, resent: false, caseOpen: false, state: 'submitted', journals: 0, returned: 0, calls: [] as string[] };
            const t = await build();
            const key = `resent-model-${String(i).padStart(3, '0')}`;
            let first = true;
            for (const st of steps) {
              if (st.t === 'send') {
                sim(t.spy as never, st.a);
                t.ctl.dieOnPost = st.die;
                try { if (first) await t.svc.request(t.party, t.body, key, NOW); else await t.sweep(); } catch { /* a scripted outage or crash */ }
                if (m.state === 'submitted' && !m.caseOpen) {
                  m.began = true;
                  if (m.outcome === 'refused') m.resent = true;
                  m.calls.push(`${key}:credit:${m.attempt}`);
                  if (st.a === 'credited') { m.outcome ??= 'credited'; if (!st.die) { m.state = 'settled'; m.journals = 1; } }
                  else if (st.a === 'pending') m.outcome ??= 'pending';
                  else if (st.a === 'flap') m.outcome ??= 'refused';
                  else if (st.a === 'real') { m.outcome ??= 'refused'; m.caseOpen = true; }
                }
                first = false;
              } else if (st.t === 'resolve') {
                const tr = await t.s.transfers.byKey(key);
                if (tr) await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'load-credit:' || $1`, [tr.id]);
                if (m.caseOpen) Object.assign(m, { caseOpen: false, attempt: m.attempt + 1, began: false, outcome: undefined, resent: false });
              } else {
                t.ctl.returned = true;
                t.ctl.dieOnPost = false;
                await t.sweep();
                if (m.state === 'submitted') { m.state = 'failed'; if (!m.caseOpen && m.began && (m.outcome !== 'refused' || m.resent)) m.returned = 1; }
              }
            }
            const where = JSON.stringify(steps);
            expect({ where, calls: t.spy.mock.calls.map((c) => c[1]) }).toEqual({ where, calls: m.calls });
            expect({ where, state: (await t.s.transfers.byKey(key))!.state, journals: await journals(key), returned: (await returnedCase(key)).length }).toEqual({ where, state: m.state, journals: m.journals, returned: m.returned });
          }
        }, 120_000);
      });
    });

    describe('characterization: the credit markers a real credit step leaves, byte for byte (T-0761)', () => {
      /** Every credit marker row of a load, as `type=external_id`, in a stable order. */
      const markers = async (key: string) => (await db.query<{ kind: string; seq: number; value: string }>(`select m.kind, m.seq, m.value from ops.workflow_marker m join ops.transfer t on m.subject_id = t.id where t.idempotency_key = $1 and m.kind in ('credit_began', 'credit_outcome') order by m.kind, m.seq`, [key])).rows.map((r) => `${r.kind}:${r.seq}=${r.value}`);
      const sweepOf = async (svc: { stale(n: Date, a: number): Promise<{ id: string }[]>; vendorLoadOf(id: string): Promise<string | undefined>; applyVendorLoad(l: string, n: Date): Promise<unknown> }) => { for (const x of await svc.stale(LATER, 0)) await svc.applyVendorLoad((await svc.vendorLoadOf(x.id))!, LATER); };
      const returnedCaseCount = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ops.case c join ops.transfer t on c.dedupe_key = 'load-returned:' || t.id where t.idempotency_key = $1`, [key])).rows[0]!.n;
      /** A service whose vendor reads a return once `ctl.returned` is set; the credit goes to the simulator. */
      const build = async () => {
        const t = await setup();
        const s = app.services;
        const provider = (await db.query<{ p: string }>(`select provider as p from ops.external_ref where entity_id = $1 and entity_type = 'funding_account'`, [t.party])).rows[0]!.p;
        const ctl = { returned: false };
        const port: FundingPort = { createLoad: (i, k) => t.sim.createLoad(i, k), getLoad: async (id) => { const l = await t.sim.getLoad(id); return ctl.returned ? { ...l, status: 'failed', failureCode: 'RETURNED' } : l; }, refund: (i, k) => t.sim.refund(i, k), getRefund: (id) => t.sim.getRefund(id), parseWebhook: (h, b) => t.sim.parseWebhook(h, b) };
        const svc = new LoadService({ db, port, credit: t.sim as Required<FundingSimulator>, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider });
        return { ...t, svc, ctl, s };
      };

      it('none: a load that never reached the vendor credit (no account) leaves no marker', async () => {
        const t = await build();
        await db.query(`delete from ops.external_ref where entity_type = 'funding_account' and entity_id = $1`, [t.party]);
        const key = 'char-none-00001';
        await t.svc.request(t.party, t.body, key, NOW);
        expect(await markers(key)).toEqual([]);
        expect(t.spy).not.toHaveBeenCalled();
        t.ctl.returned = true;
        await sweepOf(t.svc);
        expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
        expect(await returnedCaseCount(key)).toBe(0);
      });

      it('began: an outage after the marker leaves the marker alone; a return then opens the case; a healthy replay reuses the key and writes the outcome', async () => {
        const t = await build();
        const key = 'char-began-0001';
        t.sim.outageNext();
        await expect(t.svc.request(t.party, t.body, key, NOW)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
        expect(await markers(key)).toEqual([`credit_began:1=${key}:credit:1`]);
        await sweepOf(t.svc);
        expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:1`, `${key}:credit:1`]);
        expect(await markers(key)).toEqual([`credit_began:1=${key}:credit:1`, `credit_outcome:1=credited`]);
        expect(await journals(key)).toBe(1);

        const u = await build();
        const key2 = 'char-began-0002';
        u.sim.outageNext();
        await expect(u.svc.request(u.party, u.body, key2, NOW)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
        u.ctl.returned = true;
        await sweepOf(u.svc);
        expect((await u.s.transfers.byKey(key2))!.state).toBe('failed');
        expect(await returnedCaseCount(key2)).toBe(1);
        expect(u.spy).toHaveBeenCalledTimes(1);
      });

      it('credited: marker then a :credited outcome; a replay of the request adds no row and no call', async () => {
        const t = await build();
        const key = 'char-credited-1';
        await t.svc.request(t.party, t.body, key, NOW);
        const expected = [`credit_began:1=${key}:credit:1`, `credit_outcome:1=credited`];
        expect(await markers(key)).toEqual(expected);
        // T-0769: a credit writes no funding_credit row to ops.external_ref any more.
        expect((await db.query(`select 1 from ops.external_ref r join ops.transfer t on r.entity_id = t.id where t.idempotency_key = $1 and r.entity_type like 'funding_credit%'`, [key])).rows.length).toBe(0);
        await t.svc.request(t.party, t.body, key, NOW);
        await sweepOf(t.svc);
        expect(await markers(key)).toEqual(expected);
        expect(t.spy).toHaveBeenCalledTimes(1);
      });

      it('pending: a :pending outcome that stays first even when the replay is credited; a return opens the case', async () => {
        const t = await build();
        const key = 'char-pending-01';
        t.sim.pendNext();
        await t.svc.request(t.party, t.body, key, NOW);
        expect(await markers(key)).toEqual([`credit_began:1=${key}:credit:1`, `credit_outcome:1=pending`]);
        await sweepOf(t.svc);
        expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:1`, `${key}:credit:1`]);
        expect(await journals(key)).toBe(1);
        expect(await markers(key)).toEqual([`credit_began:1=${key}:credit:1`, `credit_outcome:1=pending`]);

        const u = await build();
        const key2 = 'char-pending-02';
        u.sim.pendNext();
        await u.svc.request(u.party, u.body, key2, NOW);
        u.ctl.returned = true;
        await sweepOf(u.svc);
        expect(await returnedCaseCount(key2)).toBe(1);
      });

      it('refused: a :refused outcome and one credit case; a return while the case is open opens no returned case', async () => {
        const t = await build();
        const key = 'char-refused-01';
        t.sim.failNext('ACCOUNT_UNAVAILABLE');
        await t.svc.request(t.party, t.body, key, NOW);
        expect(await markers(key)).toEqual([`credit_began:1=${key}:credit:1`, `credit_outcome:1=refused`]);
        expect(await caseRows(key)).toMatchObject([{ status: 'open', payload: { attempt: 1 } }]);
        t.ctl.returned = true;
        await sweepOf(t.svc);
        expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
        expect(await returnedCaseCount(key)).toBe(0);
      });

      it('retry after a refusal: the next attempt takes the next key and its own marker pair; the refused attempt stays final', async () => {
        const t = await build();
        const key = 'char-retry-0001';
        t.sim.failNext('ACCOUNT_UNAVAILABLE');
        await t.svc.request(t.party, t.body, key, NOW);
        await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'load-credit:' || $1`, [(await t.s.transfers.byKey(key))!.id]);
        await sweepOf(t.svc);
        expect(t.spy.mock.calls.map((c) => c[1])).toEqual([`${key}:credit:1`, `${key}:credit:2`]);
        expect(await markers(key)).toEqual([`credit_began:1=${key}:credit:1`, `credit_began:2=${key}:credit:2`, `credit_outcome:1=refused`, `credit_outcome:2=credited`]);
        expect(await journals(key)).toBe(1);
      });

      it('maybe-moved reads the NEXT attempt only: refused attempt 1 with its case resolved is no money moved; a begun attempt 2 is', async () => {
        const t = await build();
        const key = 'char-retry-0002';
        t.sim.failNext('ACCOUNT_UNAVAILABLE');
        await t.svc.request(t.party, t.body, key, NOW);
        await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'load-credit:' || $1`, [(await t.s.transfers.byKey(key))!.id]);
        t.ctl.returned = true;
        await sweepOf(t.svc);
        expect((await t.s.transfers.byKey(key))!.state).toBe('failed');
        expect(await returnedCaseCount(key)).toBe(0);

        const u = await build();
        const key2 = 'char-retry-0003';
        u.sim.failNext('ACCOUNT_UNAVAILABLE');
        await u.svc.request(u.party, u.body, key2, NOW);
        await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'load-credit:' || $1`, [(await u.s.transfers.byKey(key2))!.id]);
        u.sim.outageNext();
        await expect(sweepOf(u.svc)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
        expect(await markers(key2)).toEqual([`credit_began:1=${key2}:credit:1`, `credit_began:2=${key2}:credit:2`, `credit_outcome:1=refused`]);
        u.ctl.returned = true;
        await sweepOf(u.svc);
        expect(await returnedCaseCount(key2)).toBe(1);
      });
    });

    describe('fail() reads only our own credit records and never calls the vendor credit', () => {
      /** A returned ACH read over a transfer whose credit records we script: `markers` are the rows the credit step leaves. */
      const returnedWith = async (tag: string, markers: { began?: boolean; outcome?: 'credited' | 'pending' | 'refused'; openCase?: boolean }) => {
        const t = await setup();
        const s = app.services;
        const provider = (await db.query<{ p: string }>(`select provider as p from ops.external_ref where entity_id = $1 and entity_type = 'funding_account'`, [t.party])).rows[0]!.p;
        const port: FundingPort = { createLoad: (i, k) => t.sim.createLoad(i, k), getLoad: async (id) => ({ ...(await t.sim.getLoad(id)), status: 'failed', failureCode: 'RETURNED' }), refund: (i, k) => t.sim.refund(i, k), getRefund: (id) => t.sim.getRefund(id), parseWebhook: (h, b) => t.sim.parseWebhook(h, b) };
        const svc = new LoadService({ db, port, credit: t.sim as Required<FundingSimulator>, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider });
        const key = `ret-${tag}-0001`;
        const ach = await t.sim.createLoad({ customerId: t.party, method: 'ach', amount: money(10_000n, 'USD'), paymentMethodId: 'pm_ok' }, key);
        const tr = await svc.submit(await svc.begin({ payerPartyId: t.party, memberPartyId: t.party, method: 'ach', amount: money(10_000n, 'USD') }, key, NOW), NOW);
        await svc.link(tr, ach);
        const attempt = { transferId: tr.id, workflowId: key, provider, attempt: 1 };
        if (markers.began) await recordCreditBegan(db, attempt);
        if (markers.outcome) await recordCreditOutcome(db, { ...attempt, outcome: markers.outcome });
        if (markers.openCase) await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'load_credit_refused', $2, 'high', 'open', '{"attempt":1}', $3)`, [uuidv7(NOW), `load-credit:${tr.id}`, NOW]);
        t.spy.mockClear();
        const moved = await svc.applyVendorLoad(ach.loadId, LATER);
        return { t, key, state: moved?.state, cases: (await returnedCase(key)).length, calls: t.spy.mock.calls.length };
      };

      it.each([
        ['no marker', {}, 0],
        ['a refused outcome', { began: true, outcome: 'refused' }, 0],
        ['an open credit case', { began: true, outcome: 'credited', openCase: true }, 0],
        ['a credited outcome', { began: true, outcome: 'credited' }, 1],
        ['a pending outcome', { began: true, outcome: 'pending' }, 1],
        ['a crash between the call and its outcome (marker, no outcome)', { began: true }, 1],
      ] as const)('%s: the load fails, the vendor credit is never called, %i case(s)', async (name, markers, cases) => {
        const r = await returnedWith(name.replace(/\W+/g, '').slice(0, 12), markers as never);
        expect(r.state).toBe('failed');
        expect(r.calls).toBe(0);
        expect(r.cases).toBe(cases);
      });

      it('a near-miss suffix (refused_later) is not `refused`: it reads as may-have-moved, the load fails, no vendor call, one case', async () => {
        const r = await returnedWith('nearmiss', { began: true, outcome: 'refused_later' } as never);
        expect(r.state).toBe('failed');
        expect(r.calls).toBe(0);
        expect(r.cases).toBe(1);
      });

      it('a stored outcome suffix that is none of the three reads as may-have-moved: the load fails, no vendor call, one case', async () => {
        const r = await returnedWith('oddsuffix', { began: true, outcome: 'weird' } as never);
        expect(r.state).toBe('failed');
        expect(r.calls).toBe(0);
        expect(r.cases).toBe(1);
      });
    });
  });
});

describe('the typed credit-marker functions (T-0761)', () => {
  const fresh = () => ({ transferId: uuidv7(NOW), workflowId: `typed-${uuidv7(NOW)}`, provider: 'typed-marker-provider' });
  const read = (a: { transferId: string; provider: string }, attempt = 1) => creditAttemptState(db, { transferId: a.transferId, provider: a.provider, attempt });
  const stored = async (transferId: string) => (await db.query<{ kind: string; seq: number; value: string }>(`select kind, seq, value from ops.workflow_marker where subject_id = $1 order by kind, seq`, [transferId])).rows;
  const legacyRows = async (transferId: string) => (await db.query(`select 1 from ops.external_ref where entity_id = $1 and entity_type like 'funding_credit%'`, [transferId])).rows.length;

  it('no rows reads { began: false }', async () => {
    const a = fresh();
    expect(await read(a)).toEqual({ began: false, resent: false });
  });

  it('began only reads { began: true }, with no outcome key', async () => {
    const a = fresh();
    await recordCreditBegan(db, { ...a, attempt: 1 });
    expect(await read(a)).toEqual({ began: true, resent: false });
    expect(await stored(a.transferId)).toEqual([{ kind: 'credit_began', seq: 1, value: `${a.workflowId}:credit:1` }]);
    await recordCreditBegan(db, { ...a, attempt: 1 });
    expect(await stored(a.transferId)).toHaveLength(1);
  });

  it.each(['credited', 'pending', 'refused'] as const satisfies readonly CreditOutcome[])('began plus %s reads back typed and stores the same bytes', async (outcome) => {
    const a = fresh();
    await recordCreditBegan(db, { ...a, attempt: 1 });
    await recordCreditOutcome(db, { ...a, attempt: 1, outcome });
    expect(await read(a)).toEqual({ began: true, outcome, resent: false });
    expect(await stored(a.transferId)).toEqual([
      { kind: 'credit_began', seq: 1, value: creditKey(a.workflowId, 1) },
      { kind: 'credit_outcome', seq: 1, value: outcome },
    ]);
    expect(await legacyRows(a.transferId)).toBe(0);
  });

  it('an outcome with no marker is not a began attempt', async () => {
    const a = fresh();
    await recordCreditOutcome(db, { ...a, attempt: 1, outcome: 'credited' });
    expect(await read(a)).toEqual({ began: false, resent: false });
  });

  it('a stored suffix that is none of the three reads as pending', async () => {
    const a = fresh();
    await recordCreditBegan(db, { ...a, attempt: 1 });
    await db.query(`insert into ops.workflow_marker (kind, subject_id, seq, value) values ('credit_outcome', $1, 1, 'refused_later')`, [a.transferId]);
    expect(await read(a)).toEqual({ began: true, outcome: 'pending', resent: false });
  });

  it('a second outcome with another value keeps the first', async () => {
    const a = fresh();
    await recordCreditBegan(db, { ...a, attempt: 1 });
    await recordCreditOutcome(db, { ...a, attempt: 1, outcome: 'pending' });
    await recordCreditOutcome(db, { ...a, attempt: 1, outcome: 'credited' });
    expect(await read(a)).toEqual({ began: true, outcome: 'pending', resent: false });
    await recordCreditOutcome(db, { ...a, attempt: 1, outcome: 'refused' });
    expect((await stored(a.transferId)).filter((r) => r.kind === 'credit_outcome' && r.seq === 1)).toHaveLength(1);
  });

  it('attempts and transfers are separate: attempt 2 does not see attempt 1, another transfer sees nothing', async () => {
    const a = fresh();
    await recordCreditBegan(db, { ...a, attempt: 1 });
    await recordCreditOutcome(db, { ...a, attempt: 1, outcome: 'refused' });
    expect(await read(a, 2)).toEqual({ began: false, resent: false });
    // T-0769: the marker is keyed by the transfer id, which implies the provider, so the provider argument no longer scopes the read.
    expect(await read({ transferId: a.transferId, provider: 'other-provider' })).toEqual({ began: true, outcome: 'refused', resent: false });
    expect(await read({ transferId: uuidv7(NOW), provider: a.provider })).toEqual({ began: false, resent: false });
    await recordCreditBegan(db, { ...a, attempt: 2 });
    expect(await read(a, 2)).toEqual({ began: true, resent: false });
    expect(await read(a, 1)).toEqual({ began: true, outcome: 'refused', resent: false });
  });
});

describe('the credit_resent marker (T-0786)', () => {
  const fresh = () => ({ transferId: uuidv7(NOW), workflowId: `resent-${uuidv7(NOW)}`, provider: 'resent-provider' });
  const read = (a: { transferId: string; provider: string }, attempt = 1) => creditAttemptState(db, { transferId: a.transferId, provider: a.provider, attempt });
  const stored = async (transferId: string) => (await db.query<{ kind: string; seq: number; value: string }>(`select kind, seq, value from ops.workflow_marker where subject_id = $1 order by kind, seq`, [transferId])).rows;

  it('resent is false with no row and true with the row; the row is (credit_resent, transfer, attempt, the credit key)', async () => {
    const a = fresh();
    await recordCreditBegan(db, { ...a, attempt: 1 });
    await recordCreditOutcome(db, { ...a, attempt: 1, outcome: 'refused' });
    expect(await read(a)).toEqual({ began: true, outcome: 'refused', resent: false });
    await recordCreditResent(db, { ...a, attempt: 1 });
    expect(await read(a)).toEqual({ began: true, outcome: 'refused', resent: true });
    expect((await stored(a.transferId)).filter((r) => r.kind === 'credit_resent')).toEqual([{ kind: 'credit_resent', seq: 1, value: creditKey(a.workflowId, 1) }]);
  });

  it('writing it twice stores one row; another attempt and another transfer do not see it', async () => {
    const a = fresh();
    await recordCreditBegan(db, { ...a, attempt: 1 });
    await recordCreditResent(db, { ...a, attempt: 1 });
    await recordCreditResent(db, { ...a, attempt: 1 });
    expect((await stored(a.transferId)).filter((r) => r.kind === 'credit_resent')).toHaveLength(1);
    await recordCreditBegan(db, { ...a, attempt: 2 });
    expect(await read(a, 2)).toEqual({ began: true, resent: false });
    expect(await read({ transferId: uuidv7(NOW), provider: a.provider })).toEqual({ began: false, resent: false });
  });

  it('a resent row on an attempt with no outcome row (the crash between the marker and the answer) reads { began, resent: true } with no outcome key', async () => {
    const a = fresh();
    await recordCreditBegan(db, { ...a, attempt: 1 });
    await recordCreditResent(db, { ...a, attempt: 1 });
    expect(await read(a)).toEqual({ began: true, resent: true });
  });

  it('creditMayHaveMoved: refused + resent is may-have-moved; refused alone, and resent without a refusal outcome row, follow the old rule', async () => {
    const a = fresh();
    const transfer = { id: a.transferId, idempotencyKey: a.workflowId } as unknown as Transfer;
    await recordCreditBegan(db, { ...a, attempt: 1 });
    await recordCreditOutcome(db, { ...a, attempt: 1, outcome: 'refused' });
    expect(await creditMayHaveMoved({ db, provider: a.provider }, transfer, 'ld_1')).toBeUndefined();
    await recordCreditResent(db, { ...a, attempt: 1 });
    expect(await creditMayHaveMoved({ db, provider: a.provider }, transfer, 'ld_1')).toBe('ld_1');
  });
});

describe('the credit markers against a reference model (T-0769 differential: green on external_ref and on workflow_marker)', () => {
  type Op = { op: 'began' | 'pending' | 'credited' | 'refused'; attempt: number };
  /** The reference: first writer wins per (kind, attempt); an outcome without a began marker reads as not begun. */
  const model = (ops: Op[], attempt: number): { began: boolean; resent: boolean; outcome?: CreditOutcome } => {
    const began = new Set<number>();
    const out = new Map<number, CreditOutcome>();
    for (const o of ops) {
      if (o.op === 'began') began.add(o.attempt);
      else if (!out.has(o.attempt)) out.set(o.attempt, o.op);
    }
    if (!began.has(attempt)) return { began: false, resent: false };
    const outcome = out.get(attempt);
    return outcome ? { began: true, outcome, resent: false } : { began: true, resent: false };
  };
  it('400 random write sequences (1,600 reads) read back exactly as the model says, for every attempt', async () => {
    let seed = 0x7a69;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
    const kinds: Op['op'][] = ['began', 'pending', 'credited', 'refused'];
    for (let i = 0; i < 400; i++) {
      const a = { transferId: uuidv7(NOW), workflowId: `diff-${uuidv7(NOW)}`, provider: 'diff-provider' };
      const ops: Op[] = Array.from({ length: rnd(8) }, () => ({ op: kinds[rnd(4)]!, attempt: 1 + rnd(3) }));
      for (const o of ops) {
        if (o.op === 'began') await recordCreditBegan(db, { ...a, attempt: o.attempt });
        else await recordCreditOutcome(db, { ...a, attempt: o.attempt, outcome: o.op });
      }
      const states = await Promise.all([1, 2, 3, 4].map((n) => creditAttemptState(db, { transferId: a.transferId, provider: a.provider, attempt: n })));
      states.forEach((st, k) => expect(st).toEqual(model(ops, k + 1)));
    }
  }, 120_000);
});

describe('the failed-owner rule is enforced on the credit path (T-0763, TST-WAL-003, TST-WAL-002)', () => {
  const LATER = new Date('2100-01-01T00:00:00Z');
  let nth = 0;
  const setup = async () => {
    const s = app.services;
    nth += 1;
    const provider = `simulator-owner-${nth}`;
    const sim = new FundingSimulator(fixedClock(NOW.toISOString()), { credit: true });
    const svc = new LoadService({ db, port: sim, credit: sim as Required<FundingSimulator>, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider });
    const party = uuidv7(NOW);
    await s.accounts.provisionMember(party);
    await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('funding_account', $1, $3, $2)`, [party, `a:${party}`, provider]);
    const spy = vi.spyOn(sim as Required<FundingSimulator>, 'creditWallet');
    const body = { memberPartyId: party, amount: USD_100, method: 'card', paymentMethodId: 'pm_ok' };
    // T-0770: the owner marker is a workflow marker of kind `subaccount_owner:{provider}`, subject the party.
    const marker = (value: string, entityId = party, prov = provider) => db.query(`insert into ops.workflow_marker (kind, subject_id, seq, value) values ($1, $2, 0, $3)`, [ownerKind(prov), entityId, value]);
    const clear = () => db.query(`delete from ops.workflow_marker where kind like 'subaccount\\_owner:%' and subject_id = $1`, [party]);
    /** The worker sweep's own steps (stale, read the vendor, apply its state), without the worker package. */
    const sweep = async () => {
      for (const x of await svc.stale(LATER, 0)) {
        const vendorId = await svc.vendorLoadOf(x.id);
        if (!vendorId) continue; // another test's load, under another provider
        await applyVendorState(svc, x, await sim.getLoad(vendorId), x.idempotencyKey, LATER);
      }
    };
    return { sim, svc, party, spy, body, provider, marker, clear, sweep };
  };
  const ownerCases = async (party: string) => (await db.query<{ kind: string; severity: string; status: string; payload: Record<string, unknown> }>(`select kind, severity, status, payload from ops.case where dedupe_key = $1`, [ownerCaseKey(party)])).rows;
  const creditCases = async (key: string) => (await db.query(`select 1 from ops.case c join ops.transfer t on c.dedupe_key = 'load-credit:' || t.id where t.idempotency_key = $1`, [key])).rows.length;
  const creditMarkers = async (key: string) => (await db.query(`select 1 from ops.workflow_marker m join ops.transfer t on m.subject_id = t.id where t.idempotency_key = $1 and m.kind in ('credit_began', 'credit_outcome')`, [key])).rows.length;
  const settleJournals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey(key)])).rows[0]!.n;
  const balance = async (party: string) => (await app.services.accounts.purses(party)).find((p) => p.currency === 'USD')!.available.minor;

  it('a failed-owner load the vendor has taken is not credited: no vendor call, no journal, no credit marker, one owner case and no credit case; a replay and a sweep change nothing; once the marker is gone the sweep credits once', async () => {
    const t = await setup();
    const key = 'owner-fail-0001';
    await t.marker(ownerFailedMarker(t.party));
    const view = await t.svc.request(t.party, t.body, key, NOW);
    expect(view.state).not.toBe('settled');
    const tr = (await app.services.transfers.byKey(key))!;
    expect(tr.state).toBe('submitted');
    expect(t.spy).not.toHaveBeenCalled();
    expect(await settleJournals(key)).toBe(0);
    expect(await creditMarkers(key)).toBe(0);
    expect(await creditCases(key)).toBe(0);
    expect(await ownerCases(t.party)).toEqual([{ kind: OWNER_FAILED_CASE, severity: 'medium', status: 'open', payload: { partyId: t.party } }]);
    expect(await balance(t.party)).toBe(0n);

    // A second apply and the sweep, three cycles: nothing moves and nothing new opens.
    await t.svc.applyVendorLoad((await t.svc.vendorLoadOf(tr.id))!, LATER);
    await t.sweep();
    await t.sweep();
    expect(t.spy).not.toHaveBeenCalled();
    expect(await settleJournals(key)).toBe(0);
    expect(await creditMarkers(key)).toBe(0);
    expect(await creditCases(key)).toBe(0);
    expect(await ownerCases(t.party)).toHaveLength(1);
    expect((await app.services.transfers.byKey(key))!.state).toBe('submitted');

    // The owner marker is cleared (SQL: nothing in the code clears it today, see the card's open question): the next sweep credits.
    await t.clear();
    await t.sweep();
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(t.spy.mock.calls[0]![1]).toBe(`${key}:credit:1`);
    expect(await settleJournals(key)).toBe(1);
    expect((await app.services.transfers.byKey(key))!.state).toBe('settled');
    expect(await balance(t.party)).toBe(10_000n);
    expect(await ownerCases(t.party)).toHaveLength(1);
    await t.sweep();
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(await settleJournals(key)).toBe(1);
  });

  it('the owner case is the one sub-accounts.ts opened: an existing case is reused, not duplicated, and its fields are left alone', async () => {
    const t = await setup();
    await openCase(db, { kind: OWNER_FAILED_CASE, dedupeKey: ownerCaseKey(t.party), severity: 'medium', payload: { partyId: t.party }, now: NOW });
    await t.marker(ownerFailedMarker(t.party));
    await t.svc.request(t.party, t.body, 'owner-case-0001', NOW);
    await t.sweep();
    expect(await ownerCases(t.party)).toEqual([{ kind: OWNER_FAILED_CASE, severity: 'medium', status: 'open', payload: { partyId: t.party } }]);
  });

  it('a load the vendor still holds (ACH on hold) is not an owner case yet: nothing to credit, so no case', async () => {
    const t = await setup();
    await t.marker(ownerFailedMarker(t.party));
    await t.svc.request(t.party, { ...t.body, method: 'ach' }, 'owner-ach-00001', NOW);
    expect(await ownerCases(t.party)).toEqual([]);
    expect(t.spy).not.toHaveBeenCalled();
  });

  it.each([
    ['no marker at all (a platform or non-sub-account purse)', undefined],
    ['the owner marker for a different state (`o:{party}:ok`)', (p: string) => `o:${p}:ok`],
    ['a failed marker that names another party', () => `o:${uuidv7(NOW)}:failed`],
    ['a failed marker with a suffix', (p: string) => `${ownerFailedMarker(p)}:x`],
  ] as const)('%s credits exactly as before: one vendor call, one journal, no owner case', async (_name, value) => {
    const t = await setup();
    const key = `owner-ok-${(nth + 1000).toString()}`;
    if (value) await t.marker(value(t.party));
    const view = await t.svc.request(t.party, t.body, key, NOW);
    expect(view.state).toBe('settled');
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(t.spy.mock.calls[0]![1]).toBe(`${key}:credit:1`);
    expect(await settleJournals(key)).toBe(1);
    expect(await ownerCases(t.party)).toEqual([]);
  });

  it('with NO credit port (the app as wired today) a failed-owner load is not settled or journaled, opens one owner case, and settles normally once the marker is gone', async () => {
    const t = await setup();
    const s = app.services;
    const svc = new LoadService({ db, port: t.sim, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider: t.provider });
    const key = 'owner-noport-001';
    await t.marker(ownerFailedMarker(t.party));
    expect((await svc.request(t.party, t.body, key, NOW)).state).not.toBe('settled');
    expect((await s.transfers.byKey(key))!.state).toBe('submitted');
    expect(await settleJournals(key)).toBe(0);
    expect(await balance(t.party)).toBe(0n);
    expect(await ownerCases(t.party)).toHaveLength(1);
    expect(await creditCases(key)).toBe(0);
    expect(await creditMarkers(key)).toBe(0);
    for (const x of await svc.stale(LATER, 0)) if (await svc.vendorLoadOf(x.id)) await applyVendorState(svc, x, await t.sim.getLoad((await svc.vendorLoadOf(x.id))!), x.idempotencyKey, LATER);
    expect(await settleJournals(key)).toBe(0);
    expect(await ownerCases(t.party)).toHaveLength(1);
    await t.clear();
    for (const x of await svc.stale(LATER, 0)) if (await svc.vendorLoadOf(x.id)) await applyVendorState(svc, x, await t.sim.getLoad((await svc.vendorLoadOf(x.id))!), x.idempotencyKey, LATER);
    expect(await settleJournals(key)).toBe(1);
    expect(await balance(t.party)).toBe(10_000n);
  });

  it('the owner block comes before the account gate: a failed owner with NO funding account ref, or a frozen account, opens the owner case and NO load_credit_refused case', async () => {
    const noAccount = await setup();
    await db.query(`delete from ops.external_ref where entity_type = 'funding_account' and entity_id = $1`, [noAccount.party]);
    await noAccount.marker(ownerFailedMarker(noAccount.party));
    await noAccount.svc.request(noAccount.party, noAccount.body, 'owner-noacct-001', NOW);
    await noAccount.sweep();
    expect(await ownerCases(noAccount.party)).toHaveLength(1);
    expect(await creditCases('owner-noacct-001')).toBe(0);
    expect(noAccount.spy).not.toHaveBeenCalled();

    const t = await setup();
    const s = app.services;
    const accounts = new FundingAccountSimulator();
    const ensured = await accounts.ensureAccount({ partyId: t.party, firstName: 'Test', lastName: 'Member', email: 'owner-frozen@example.test', mobile: '+14155552002' }, `funding-account:${t.party}`);
    if (!('accountRef' in ensured)) throw new Error('no account');
    await db.query(`update ops.external_ref set external_id = $3 where entity_id = $1 and entity_type = 'funding_account' and provider = $2`, [t.party, t.provider, ensured.accountRef]);
    const svc = new LoadService({ db, port: t.sim, credit: t.sim as Required<FundingSimulator>, fundingAccounts: accounts, ledger: s.ledger, accounts: s.accounts, transfers: s.transfers, memberships: s.memberships, flags: s.flags, provider: t.provider });
    accounts.setStatus(ensured.accountRef, 'frozen');
    await t.marker(ownerFailedMarker(t.party));
    await svc.request(t.party, t.body, 'owner-frozen-001', NOW);
    expect(await ownerCases(t.party)).toHaveLength(1);
    expect(await creditCases('owner-frozen-001')).toBe(0);
    expect(await creditMarkers('owner-frozen-001')).toBe(0);
    expect(t.spy).not.toHaveBeenCalled();
  });

  it('a failed marker stored under another provider does not block this provider\'s credit', async () => {
    const t = await setup();
    const key = 'owner-prov-0001';
    await t.marker(ownerFailedMarker(t.party), t.party, 'some-other-provider');
    expect((await t.svc.request(t.party, t.body, key, NOW)).state).toBe('settled');
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(await ownerCases(t.party)).toEqual([]);
  });

  it('another member\'s failed owner does not block this member', async () => {
    const t = await setup();
    await t.marker(ownerFailedMarker(uuidv7(NOW)), uuidv7(NOW));
    expect((await t.svc.request(t.party, t.body, 'owner-other-0001', NOW)).state).toBe('settled');
  });
});

// The public surface of wallet/loads.ts (T-0764): the importers (app, institutions/ach, intents/service, the worker through
// @kesher/api/wallet/loads and the test files) keep importing every name from here, however the file is split. A move that drops
// or renames one fails here, not at some importer's runtime.
describe('the export surface of wallet/loads (T-0764)', () => {
  it('keeps every runtime export it had before the split', async () => {
    const mod = await import('./loads.ts');
    expect(Object.keys(mod).sort()).toEqual([
      'ACH_FLAG', 'FUNDING_PROVIDER', 'HELD_RECHECK_MS', 'HOLD_JOURNAL_KIND', 'INSTITUTION_DEPOSIT_JOURNAL_KIND', 'LOAD_JOURNAL_KIND', 'LOAD_METHODS',
      'LoadService', 'PURSE_CURRENCIES', 'RELEASE_JOURNAL_KIND', 'WALLET_FLAG', 'applyVendorState', 'creditAttemptState', 'creditKey', 'fundingAccountKey',
      'holdKey', 'loadState', 'recordCreditBegan', 'recordCreditOutcome', 'releaseKey', 'runLoad', 'settleKey',
    ]);
  });
});

// The order of the early returns in the vendor credit step (T-0766, TST-WAL-003; T-0763 put the owner block ahead of the no-credit-port
// return and the account gates). Every query and vendor call is recorded as a label, so a reorder of the kind/vendor guard, the owner block,
// the port guard, the credit-case check, the succeeded check, the account gates, the began marker or the vendor call changes a trace here.
describe('the order of the early returns in the credit step (T-0766)', () => {
  const party = uuidv7(NOW);
  const ref = 'acct_order_1';
  interface World {
    ownerFailed?: boolean;
    credit?: { status: string; attempt?: number };
    accountRef?: boolean;
    accountStatus?: string;
    /** The stored `credit_outcome` of the attempt (T-0786 reads it before the call). */
    storedOutcome?: string;
  }
  const run = async (w: World, o: { port?: boolean; kind?: string; vendor?: Partial<VendorLoad> | null; result?: { status: string; reasonCode?: string }; error?: unknown } = {}) => {
    const trace: string[] = [];
    const fake = {
      async query(text: string, params: readonly unknown[] = []) {
        let rows: unknown[] = [];
        if (text.includes('from ops.workflow_marker') && params[0] === ownerKind('p')) {
          trace.push('owner-markers');
          rows = w.ownerFailed ? [{ value: `o:${party}:failed` }] : [];
        } else if (text.includes('from ops.workflow_marker') && params[0] === 'credit_outcome') {
          trace.push('outcome-read');
          rows = w.storedOutcome === undefined ? [] : [{ value: w.storedOutcome }];
        } else if (text.includes("entity_type = 'funding_account'")) {
          trace.push('account-ref');
          rows = w.accountRef === false ? [] : [{ external_id: ref }];
        } else if (text.startsWith('select status, payload from ops.case')) {
          trace.push('credit-case');
          rows = w.credit ? [{ status: w.credit.status, payload: w.credit.attempt === undefined ? {} : { attempt: w.credit.attempt } }] : [];
        } else if (text.startsWith('insert into ops.case')) {
          trace.push(params[1] === OWNER_FAILED_CASE ? 'owner-case' : `credit-case-open:${String(params[1])}:${String(params[2])}:${(params[4] as { reasonCode?: string }).reasonCode ?? ''}:${(params[4] as { attempt?: number }).attempt ?? ''}`);
          rows = [{ id: 'row' }];
        } else if (text.startsWith('insert into ops.workflow_marker')) {
          trace.push(params[0] === 'credit_resent' ? `resent:${String(params[0])}:${String(params[2])}=${String(params[3])}` : params[0] === 'credit_outcome' ? `outcome:${String(params[0])}:${String(params[2])}=${String(params[3])}` : `began:${String(params[0])}:${String(params[2])}=${String(params[3])}`);
        } else {
          trace.push(`unexpected: ${text}`);
        }
        return { rows, rowCount: rows.length };
      },
      transaction: () => Promise.reject(new Error('no transaction expected')),
    };
    const port = {
      async creditWallet(_i: unknown, key: string) {
        trace.push(`vendor-call:${key}`);
        if (o.error !== undefined) throw o.error;
        return o.result ?? { status: 'credited' as const };
      },
    };
    const fundingAccounts = {
      async account() {
        trace.push('account-gate');
        return { status: w.accountStatus ?? 'open' };
      },
    };
    const svc = new LoadService({ db: fake, port: {} as FundingPort, ...(o.port === false ? {} : { credit: port as never }), fundingAccounts: fundingAccounts as never, ledger: {} as never, accounts: {} as never, transfers: {} as never, memberships: {} as never, flags: {} as never, provider: 'p' } as never);
    const transfer = { id: 'tr_1', kind: o.kind ?? 'load', toPartyId: party, idempotencyKey: 'order-key-0001', amount: money(10000n, 'USD') };
    const vendor = o.vendor === null ? undefined : { loadId: 'ld_1', status: 'succeeded', ...o.vendor };
    let proceed: boolean | undefined;
    let error: unknown;
    try {
      proceed = await (svc as unknown as { creditStep(t: unknown, v: unknown, n: Date): Promise<boolean> }).creditStep(transfer, vendor, NOW);
    } catch (e) {
      error = e;
    }
    return { proceed, error, trace, svc };
  };

  it('guard first: a deposit, or no vendor load, returns true before anything is read, owner failed or not', async () => {
    expect(await run({ ownerFailed: true }, { kind: 'deposit' })).toMatchObject({ proceed: true, trace: [] });
    expect(await run({ ownerFailed: true }, { vendor: null })).toMatchObject({ proceed: true, trace: [] });
  });

  it('owner block second: a failed owner stops the step with or without a credit port, ahead of the credit case, the succeeded check and the account', async () => {
    const stacked = { ownerFailed: true, credit: { status: 'open' }, accountRef: false };
    expect(await run(stacked, { vendor: { status: 'processing' } })).toMatchObject({ proceed: false, trace: ['owner-markers', 'owner-case'] });
    expect(await run(stacked, { port: false })).toMatchObject({ proceed: false, trace: ['owner-markers', 'owner-case'] });
    // An owner block is neither a credit nor a refusal: both counters the sweep report reads stay 0.
    const blocked = await run(stacked);
    expect(blocked.svc.refusedCount).toBe(0);
    expect(blocked.svc.creditedCount).toBe(0);
  });

  it('port guard third: a clean owner and no credit port returns true having read only the owner markers', async () => {
    expect(await run({ credit: { status: 'open' }, accountRef: false }, { port: false, vendor: { status: 'processing' } })).toMatchObject({ proceed: true, trace: ['owner-markers'] });
  });

  it('credit-case check fourth: an open (or investigating) case stops the step before the succeeded check and the account', async () => {
    for (const status of ['open', 'investigating']) {
      expect(await run({ credit: { status }, accountRef: false }, { vendor: { status: 'processing' } })).toMatchObject({ proceed: false, trace: ['owner-markers', 'credit-case'] });
    }
  });

  it('succeeded check fifth: a vendor load that has not succeeded stops the step before the account and writes no case', async () => {
    expect(await run({ accountRef: false }, { vendor: { status: 'processing' } })).toMatchObject({ proceed: false, trace: ['owner-markers', 'credit-case'] });
  });

  it('account gates sixth: no account ref opens NO_ACCOUNT, a blocked account opens ACCOUNT_FROZEN, both before the began marker and the vendor call', async () => {
    expect(await run({ accountRef: false })).toMatchObject({ proceed: false, trace: ['owner-markers', 'credit-case', 'account-ref', 'credit-case-open:load_credit_refused:load-credit:tr_1:NO_ACCOUNT:1'] });
    expect(await run({ accountStatus: 'frozen', credit: { status: 'resolved', attempt: 2 } })).toMatchObject({ proceed: false, trace: ['owner-markers', 'credit-case', 'account-ref', 'account-gate', 'credit-case-open:load_credit_refused:load-credit:tr_1:ACCOUNT_FROZEN:3'] });
  });

  it('began marker seventh, then the vendor call under the attempt key, then the outcome', async () => {
    const r = await run({});
    expect(r).toMatchObject({ proceed: true });
    expect(r.trace).toEqual(['owner-markers', 'credit-case', 'account-ref', 'account-gate', 'began:credit_began:1=order-key-0001:credit:1', 'outcome-read', 'vendor-call:order-key-0001:credit:1', 'outcome:credit_outcome:1=credited']);
    expect(r.svc.creditedCount).toBe(1);
    expect(r.svc.refusedCount).toBe(0);
  });

  it('counts a new refusal once on the service: NO_ACCOUNT bumps refusedCount, not creditedCount', async () => {
    const r = await run({ accountRef: false });
    expect(r.svc.refusedCount).toBe(1);
    expect(r.svc.creditedCount).toBe(0);
  });

  it('a refusal writes its outcome before it opens the credit case, and counts once (a mutant that opens the case first, or writes no outcome, fails)', async () => {
    const r = await run({}, { result: { status: 'refused', reasonCode: 'INSUFFICIENT_LIMIT' } });
    expect(r).toMatchObject({ proceed: false });
    expect(r.trace).toEqual([
      'owner-markers', 'credit-case', 'account-ref', 'account-gate', 'began:credit_began:1=order-key-0001:credit:1', 'outcome-read', 'vendor-call:order-key-0001:credit:1',
      'outcome:credit_outcome:1=refused', 'credit-case-open:load_credit_refused:load-credit:tr_1:INSUFFICIENT_LIMIT:1',
    ]);
    expect(r.svc.refusedCount).toBe(1);
    expect(r.svc.creditedCount).toBe(0);
  });

  it('a stored `refused` with no open case writes credit_resent after the began marker and BEFORE the vendor call; any other stored outcome writes none (T-0786)', async () => {
    const r = await run({ storedOutcome: 'refused' });
    expect(r.trace).toEqual(['owner-markers', 'credit-case', 'account-ref', 'account-gate', 'began:credit_began:1=order-key-0001:credit:1', 'outcome-read', 'resent:credit_resent:1=order-key-0001:credit:1', 'vendor-call:order-key-0001:credit:1', 'outcome:credit_outcome:1=credited']);
    for (const storedOutcome of ['pending', 'credited', 'refused_later']) expect((await run({ storedOutcome })).trace.some((x) => x.startsWith('resent:'))).toBe(false);
    // A crash between the marker and the call, or an outage on the call, leaves the marker: it is never taken back.
    const outage = await run({ storedOutcome: 'refused' }, { error: new FundingError('PROVIDER_UNAVAILABLE', 'vendor down') });
    expect(outage.trace.slice(-2)).toEqual(['resent:credit_resent:1=order-key-0001:credit:1', 'vendor-call:order-key-0001:credit:1']);
    // An open credit case stops the step before any read of the outcome (a refusal WITH a case takes the next key, not a resend).
    expect((await run({ storedOutcome: 'refused', credit: { status: 'open' } })).trace).toEqual(['owner-markers', 'credit-case']);
  });

  it('a refusal that carries no reason code is stored with the default REFUSED', async () => {
    const r = await run({}, { result: { status: 'refused' } });
    expect(r.trace.at(-1)).toBe('credit-case-open:load_credit_refused:load-credit:tr_1:REFUSED:1');
    expect(r.svc.refusedCount).toBe(1);
  });

  it('a `pending` vendor answer writes its outcome, opens no case and moves neither counter', async () => {
    const r = await run({}, { result: { status: 'pending' } });
    expect(r.proceed).toBe(false);
    expect(r.trace.at(-1)).toBe('outcome:credit_outcome:1=pending');
    expect(r.trace.some((t) => t.startsWith('credit-case-open'))).toBe(false);
    expect(r.svc.creditedCount).toBe(0);
    expect(r.svc.refusedCount).toBe(0);
  });

  it('NOT_SUCCEEDED is the vendor read flapping: its outcome is written as refused, no case opens and refusedCount does not move', async () => {
    const r = await run({}, { result: { status: 'refused', reasonCode: 'NOT_SUCCEEDED' } });
    expect(r.proceed).toBe(false);
    expect(r.trace.at(-1)).toBe('outcome:credit_outcome:1=refused');
    expect(r.trace.some((t) => t.startsWith('credit-case-open'))).toBe(false);
    expect(r.svc.refusedCount).toBe(0);
    expect(r.svc.creditedCount).toBe(0);
  });

  it('a provider outage on the credit call surfaces as the mapped DomainError, writes no outcome and no case', async () => {
    const raw = new FundingError('PROVIDER_UNAVAILABLE', 'vendor down');
    const r = await run({}, { error: raw });
    expect(r.error).not.toBe(raw);
    expect(r.error).toBeInstanceOf(DomainError);
    expect(r.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: 'Funding is temporarily unavailable; try again with the same key' });
    expect(r.trace.at(-1)).toBe('vendor-call:order-key-0001:credit:1');
    expect(r.svc.refusedCount).toBe(0);
  });
});

describe('creditMayHaveMoved reads the credit case before the attempt records (T-0766)', () => {
  const transfer = { id: 'tr_1', idempotencyKey: 'order-key-0001' } as unknown as Transfer;
  const dbWith = (caseStatus: string | undefined): Database => ({
    async query(text: string, params: readonly unknown[] = []) {
      const rows: unknown[] = text.startsWith('select status, payload from ops.case')
        ? caseStatus === undefined ? [] : [{ status: caseStatus, payload: { attempt: 0 } }]
        : [{ value: params[0] === 'credit_outcome' ? 'credited' : 'order-key-0001:credit:1' }];
      return { rows, rowCount: rows.length };
    },
  }) as unknown as Database;

  it('returns the vendor load id when no case is open and the attempt began and was credited', async () => {
    expect(await creditMayHaveMoved({ db: dbWith(undefined), provider: 'p' }, transfer, 'ld_1')).toBe('ld_1');
  });

  it('returns undefined while a credit case is open or investigating, whatever the attempt records say', async () => {
    expect(await creditMayHaveMoved({ db: dbWith('open'), provider: 'p' }, transfer, 'ld_1')).toBeUndefined();
    expect(await creditMayHaveMoved({ db: dbWith('investigating'), provider: 'p' }, transfer, 'ld_1')).toBeUndefined();
  });
});
