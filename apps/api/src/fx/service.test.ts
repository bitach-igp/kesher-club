// FX (T-0509, REQ-FX-001/002) end to end over PGlite and the FX simulator with real passkeys and
// step-up. TST-FX-001: a quote shows rate, markup and total and expires at +30 s; converting an expired
// quote answers QUOTE_EXPIRED and a fresh quote converts. TST-FX-002: a 0.75 % plan writes
// fx_markup_bps=75 on the journal, and fx_position and fee_income post, balanced per currency.
// TST-FX-003/004 (T-0513): quotes are priced from the club's published rate and carry its version, the
// journal too; a port rate past its 15 minutes refuses the quote with PROVIDER_UNAVAILABLE until the
// next one is published; a manual rate holds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { DEFAULT_FX_MARKUP_BPS } from '../billing/plans.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { runLoad } from '../wallet/loads.ts';
import { rateString, settleKey, type FxConversionView, type FxQuoteView } from './service.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;
let member = '';
let access = '';
let stepUpToken = '';

const call = (method: string, url: string, body?: unknown, h: Record<string, string> = {}) => dispatch(app, { method, url, headers: { authorization: `Bearer ${access}`, ...h }, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const quote = (from: { minor: string; currency: string }, to: string, key: string) => call('POST', '/v1/fx/quotes', { from, to }, { 'idempotency-key': key });
const convert = (quoteId: string, key: string, h: Record<string, string> = {}) => call('POST', '/v1/fx/conversions', { quoteId }, { 'idempotency-key': key, 'x-step-up': stepUpToken, ...h });
/** Moves the test clock and the simulators' clock together. */
const advance = (ms: number) => {
  host.clock.advance(ms);
  now = new Date(now.getTime() + ms);
};
const purse = async (currency: 'USD' | 'ILS') => (await app.services.accounts.purses(member)).find((p) => p.currency === currency)!.available.minor;
const systemBalance = async (type: string, currency: string) => BigInt((await db.query<{ b: string }>(`select coalesce(sum(p.amount_minor), 0)::text as b from ledger.posting p join ledger.account a on a.id = p.account_id where a.type = $1 and a.currency = $2`, [type, currency])).rows[0]!.b);

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost(fixedClock(NOW.toISOString()) as AdvanceableClock);
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now, flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'fx.enabled': true }) });
  const s = app.services;
  const started = await s.otp.start({ phone: '+972506000001', locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa', response: await device.register(r1.options!) });
  access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  member = principal.partyId;
  const su = await s.stepUp.start(principal);
  stepUpToken = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
  await runLoad(s.loads, { payerPartyId: member, memberPartyId: member, method: 'card', amount: money(50_000n, 'USD'), paymentMethodId: 'pm_ok' }, 'fx-fund-usd', now);
  // The worker's refresh job would do this: the club rate is the simulator's mid, published for 15 minutes.
  await s.rates.publishFromPort('USD/ILS', 3_710_000n, now);
}, 60_000);
afterAll(async () => db.close());

describe('TST-FX-001: quotes lock for 30 s', () => {
  it('a $100 → ₪ quote carries the rate, the markup and the total and expires at +30 s; the same key is the same quote', async () => {
    const r = await quote({ minor: '10000', currency: 'USD' }, 'ILS', 'fx-quote-1');
    expect(r.status).toBe(201);
    const q = r.body as FxQuoteView;
    // $100 × 3.71 = ₪371.00 gross; 0.75 % = ₪2.78 markup (half-up); the member receives ₪368.22.
    expect(q).toEqual({ quoteId: expect.any(String), from: { minor: '10000', currency: 'USD' }, total: { minor: '36822', currency: 'ILS' }, markup: { minor: '278', currency: 'ILS' }, markupBps: Number(DEFAULT_FX_MARKUP_BPS), rate: '3.710000', rateVersion: 1, expiresAt: new Date(NOW.getTime() + 30_000).toISOString() });
    expect(rateString(269_542n)).toBe('0.269542');
    expect((await quote({ minor: '10000', currency: 'USD' }, 'ILS', 'fx-quote-1')).body).toEqual(q);
    // Validation and the balance.
    expect((await quote({ minor: '10000', currency: 'USD' }, 'USD', 'fx-quote-same')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await quote({ minor: '0', currency: 'USD' }, 'ILS', 'fx-quote-zero')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await quote({ minor: '100000', currency: 'USD' }, 'ILS', 'fx-quote-poor')).body).toMatchObject({ code: 'INSUFFICIENT_FUNDS', available: '50000' });
    expect((await quote({ minor: '100', currency: 'ILS' }, 'USD', 'fx-quote-noils')).body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('converting an expired quote answers QUOTE_EXPIRED and moves nothing; a fresh quote converts once, under the step-up', async () => {
    const q = (await quote({ minor: '10000', currency: 'USD' }, 'ILS', 'fx-quote-2')).body as FxQuoteView;
    advance(30_001);
    const late = await convert(q.quoteId, 'fx-convert-late');
    expect(late.body).toMatchObject({ status: 409, code: 'QUOTE_EXPIRED', quoteId: q.quoteId });
    expect(await purse('USD')).toBe(50_000n);
    expect(await purse('ILS')).toBe(0n);
    expect(await app.services.transfers.byKey('fx-convert-late')).toBeUndefined();
    expect((await convert('fxq_nope', 'fx-convert-ghost')).body).toMatchObject({ code: 'QUOTE_EXPIRED' });

    const fresh = (await quote({ minor: '10000', currency: 'USD' }, 'ILS', 'fx-quote-3')).body as FxQuoteView;
    expect(fresh.quoteId).not.toBe(q.quoteId);
    expect((await convert(fresh.quoteId, 'fx-convert-1', { 'x-step-up': '' })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const c = await convert(fresh.quoteId, 'fx-convert-1');
    expect(c.status).toBe(201);
    expect(c.body).toEqual({ conversionId: expect.any(String), quoteId: fresh.quoteId, from: { minor: '10000', currency: 'USD' }, total: { minor: '36822', currency: 'ILS' }, status: 'settled' });
    expect(await purse('USD')).toBe(40_000n);
    expect(await purse('ILS')).toBe(36_822n);
    // Again with the same key: the same conversion, nothing more moves. The quote is spent for any other key.
    expect((await convert(fresh.quoteId, 'fx-convert-1')).body).toEqual(c.body);
    expect((await convert(fresh.quoteId, 'fx-convert-again')).body).toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(await purse('USD')).toBe(40_000n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey('fx-convert-1')])).rows[0]).toEqual({ n: 1 });
  });
});

describe('TST-FX-002: the markup on the journal', () => {
  it('a 0.75 % plan writes fx_markup_bps=75 on the journal; fx_position and fee_income post, balanced per currency', async () => {
    const t = (await app.services.transfers.byKey('fx-convert-1'))!;
    expect(t).toMatchObject({ kind: 'fx', state: 'settled', fromPartyId: member, toPartyId: member, amount: money(10_000n, 'USD') });
    const j = (await db.query<{ kind: string; metadata: Record<string, unknown> }>(`select kind, metadata from ledger.journal where id = $1`, [t.journalId])).rows[0]!;
    expect(j.kind).toBe('fx');
    expect(j.metadata).toMatchObject({ fx_markup_bps: 75, fx_rate_version: 1, rate: '3.710000', rateScaled: '3710000', from: { minor: '10000', currency: 'USD' }, total: { minor: '36822', currency: 'ILS' }, markup: { minor: '278', currency: 'ILS' }, vendor: { rate: '3.710000', total: { minor: '37100', currency: 'ILS' } } });
    const postings = (await db.query<{ type: string; currency: string; amount_minor: string }>(`select a.type::text, p.currency::text, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id where p.journal_id = $1 order by p.currency::text, a.type::text`, [t.journalId])).rows;
    expect(postings).toEqual([
      { type: 'fee_income', currency: 'ILS', amount_minor: '-278' },
      { type: 'fx_position', currency: 'ILS', amount_minor: '37100' },
      { type: 'wallet', currency: 'ILS', amount_minor: '-36822' },
      { type: 'fx_position', currency: 'USD', amount_minor: '-10000' },
      { type: 'wallet', currency: 'USD', amount_minor: '10000' },
    ]);
    expect(await systemBalance('fee_income', 'ILS')).toBe(-278n);
    expect(await systemBalance('fx_position', 'ILS')).toBe(37_100n);
    expect(await systemBalance('fx_position', 'USD')).toBe(-10_000n);
  });

  it('the plan\'s own markup wins over the default: a 1.25 % plan writes 125', async () => {
    const s = app.services;
    await s.plans.ensurePlan('premium', 'Premium');
    await s.plans.createVersion({ planCode: 'premium', price: money(9_900n, 'USD'), termMonths: 12, entitlements: {}, fxMarkupBps: 125n, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    const m = await s.memberships.create({ idempotencyKey: `m-fx-${member}`, memberPartyId: member, funderPartyId: member, funderEmail: 'f@example.com', planCode: 'premium' }, now);
    await s.memberships.setStatus(m.id, 'active', now);
    expect(await s.fx.markupFor(member)).toBe(125n);
    const q = (await quote({ minor: '10000', currency: 'USD' }, 'ILS', 'fx-quote-premium')).body as FxQuoteView;
    // ₪371.00 gross; 1.25 % = ₪4.64 (half-up from 4.6375); ₪366.36 received.
    expect(q).toMatchObject({ markupBps: 125, markup: { minor: '464', currency: 'ILS' }, total: { minor: '36636', currency: 'ILS' } });
    const c = (await convert(q.quoteId, 'fx-convert-premium')).body as FxConversionView;
    expect(c.status).toBe('settled');
    const t = (await s.transfers.byKey('fx-convert-premium'))!;
    const meta = (await db.query<{ metadata: Record<string, unknown> }>(`select metadata from ledger.journal where id = $1`, [t.journalId])).rows[0]!.metadata;
    expect(meta['fx_markup_bps']).toBe(125);
    expect(await purse('ILS')).toBe(36_822n + 36_636n);
    // The other way round, with the shekels: the pair's inverse rate.
    const back = (await quote({ minor: '37100', currency: 'ILS' }, 'USD', 'fx-quote-back')).body as FxQuoteView;
    expect(back).toMatchObject({ rate: '0.269542', from: { minor: '37100', currency: 'ILS' } });
    await s.memberships.setStatus(m.id, 'cancelled', now);
    expect(await s.fx.markupFor(member)).toBe(DEFAULT_FX_MARKUP_BPS);
  });

  it('an FX outage leaves the conversion retryable under the same key; the flag off answers FEATURE_OFF', async () => {
    const q = (await quote({ minor: '999999', currency: 'USD' }, 'ILS', 'fx-quote-outage')).body;
    expect(q).toMatchObject({ code: 'INSUFFICIENT_FUNDS' }); // the outage fixture is larger than the purse; fund it
    await runLoad(app.services.loads, { payerPartyId: member, memberPartyId: member, method: 'card', amount: money(1_000_000n, 'USD'), paymentMethodId: 'pm_ok' }, 'fx-fund-big', now);
    const q2 = (await quote({ minor: '999999', currency: 'USD' }, 'ILS', 'fx-quote-outage-2')).body as FxQuoteView;
    const r = await convert(q2.quoteId, 'fx-convert-outage');
    expect(r.body).toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    const t = (await app.services.transfers.byKey('fx-convert-outage'))!;
    expect(t.state).toBe('submitted');
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey('fx-convert-outage')])).rows[0]).toEqual({ n: 0 });

    const off = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now, identity: app.services.identity, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
    await expect(off.services.fx.quote(member, { from: { minor: '100', currency: 'USD' }, to: 'ILS' }, 'fx-off-1', now)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
  });
});

describe('TST-FX-003/004: the club rate behind every quote', () => {
  it('a port rate past its 15 minutes refuses the quote with PROVIDER_UNAVAILABLE and creates nothing; the next published rate prices the next quote and reaches the journal', async () => {
    const s = app.services;
    const later = new Date(NOW.getTime() + 16 * 60_000);
    await expect(s.fx.quote(member, { from: { minor: '10000', currency: 'USD' }, to: 'ILS' }, 'fx-stale-1', later)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const v2 = (await s.rates.publishFromPort('USD/ILS', 3_800_000n, later))!;
    const q = await s.fx.quote(member, { from: { minor: '10000', currency: 'USD' }, to: 'ILS' }, 'fx-stale-2', later);
    // $100 × 3.80 = ₪380.00 gross; 0.75 % = ₪2.85; ₪377.15 received, from rate version 2.
    expect(q).toMatchObject({ rate: '3.800000', rateVersion: v2.version, total: { minor: '37715', currency: 'ILS' }, markup: { minor: '285', currency: 'ILS' } });
    const c = await s.fx.convert(member, { quoteId: q.quoteId }, 'fx-stale-2-convert', later);
    expect(c.status).toBe('settled');
    const t = (await s.transfers.byKey('fx-stale-2-convert'))!;
    const meta = (await db.query<{ metadata: Record<string, unknown> }>(`select metadata from ledger.journal where id = $1`, [t.journalId])).rows[0]!.metadata;
    // The member got the club rate; the vendor filled at its own 3.71, and the journal says both.
    expect(meta).toMatchObject({ fx_rate_version: v2.version, fx_rate_id: v2.id, rate: '3.800000', vendor: { rate: '3.710000' } });
    // A manual rate holds past any window: finance sets 3.70 and a quote a day later uses it.
    const fin = { partyId: uuidv7(later), role: 'finance', subject: 'auth0|finance-a' };
    const proposed = await s.rates.propose('USD/ILS', 3_700_000n, fin, 'Fixing', later);
    await s.rates.approve(proposed.rate.id, { partyId: uuidv7(later), role: 'finance' }, later);
    const dayLater = new Date(later.getTime() + 24 * 60 * 60_000);
    expect(await s.fx.quote(member, { from: { minor: '10000', currency: 'USD' }, to: 'ILS' }, 'fx-manual-1', dayLater)).toMatchObject({ rate: '3.700000', rateVersion: proposed.rate.version, total: { minor: '36722', currency: 'ILS' } });
  });
});
