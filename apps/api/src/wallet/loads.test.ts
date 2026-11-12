// Loads (T-0501, REQ-WAL-002; T-0502, REQ-WAL-003) end to end. TST-WAL-002: a $100 Apple Pay load posts
// partner_settlement → wallet on success; requires_action returns the client secret and stores it
// nowhere; the webhook settles or fails the transfer once; the workflow id is the Idempotency-Key, and
// so is the vendor pull's key. An ACH load is held in pending until the bank's hold date (TST-WAL-003's
// release job is tested in the worker). TST-WAL-006: a load names the purse it credits; into the other
// currency it converts at the club rate, priced once, and a missing or stale rate refuses it before the
// vendor is asked. Over the funding simulator and PGlite with a real passkey and step-up.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { FundingAccountError, FundingAccountSimulator, FundingError, FundingSimulator, fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock, type FundingPort, type Load as VendorLoad } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { FakeStripe, StripeFundingAdapter } from '@kesher/adapters';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { HELD_RECHECK_MS, holdKey, loadState, LoadService, releaseKey, runLoad, settleKey, type LoadView } from './loads.ts';

const seedTransfer = (db: { query: (t: string, p?: readonly unknown[]) => Promise<unknown> }, f: { id: string; kind: string; state: string; market: string; at: Date }) =>
  db.query(
    `insert into ops.transfer (id, idempotency_key, kind, to_party_id, amount_minor, currency, state, hold_releases_at, market, created_at, updated_at) values ($1, $2, $3, $4, 100, 'USD', $5, $6, $7, $6, $6)`,
    [f.id, `seed-${f.id}`, f.kind, f.id, f.state, f.at, f.market],
  );

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

  it('a credited load the vendor now says failed is left alone (a return after release is T-0705)', async () => {
    const t = await newTransfer('avl-late-0001', 'v:intent-2');
    const ok = svcOver(async () => vendor({ loadId: 'v:intent-2', status: 'succeeded' }));
    await ok.applyVendorLoad('v:intent-2', NOW);
    const late = svcOver(async () => vendor({ loadId: 'v:intent-2', status: 'failed', failureCode: 'RETURNED' }));
    expect(await late.applyVendorLoad('v:intent-2', NOW)).toMatchObject({ id: t.id, state: 'settled' });
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
});
