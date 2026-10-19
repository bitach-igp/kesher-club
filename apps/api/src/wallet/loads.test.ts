// Loads (T-0501, REQ-WAL-002; T-0502, REQ-WAL-003) end to end. TST-WAL-002: a $100 Apple Pay load posts
// partner_settlement → wallet on success; requires_action returns the client secret and stores it
// nowhere; the webhook settles or fails the transfer once; the workflow id is the Idempotency-Key, and
// so is the vendor pull's key. An ACH load is held in pending until the bank's hold date (TST-WAL-003's
// release job is tested in the worker). TST-WAL-006: a load names the purse it credits; into the other
// currency it converts at the club rate, priced once, and a missing or stale rate refuses it before the
// vendor is asked. Over the funding simulator and PGlite with a real passkey and step-up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { FundingError, fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock, type FundingPort, type Load as VendorLoad } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { holdKey, loadState, LoadService, releaseKey, settleKey, type LoadView } from './loads.ts';

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
