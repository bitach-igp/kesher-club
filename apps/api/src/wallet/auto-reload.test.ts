// Auto-reload (T-0503, REQ-WAL-004) over HTTP and at the service. TST-WAL-004: threshold $50, target
// $200, balance $45 → one $155 load; a second pass within 24 h creates nothing; a failed load does not
// retry inside the window (the worker job that drives it is tested in apps/worker).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { isPgError } from '../db.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { WINDOW_MS, type AutoReloadView } from './auto-reload.ts';
import { runLoad } from './loads.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-02T09:00:00Z');
let now = NOW;
let member = '';
let access = '';
let stepUpToken = '';
let usdWallet = '';
let ilsWallet = '';

const usd = (minor: string) => ({ minor, currency: 'USD' });
const RULE = { threshold: usd('5000'), target: usd('20000'), method: 'card', paymentMethodId: 'pm_saved_1' };
const call = (method: string, url: string, body?: unknown, h: Record<string, string> = {}) => dispatch(app, { method, url, headers: { authorization: `Bearer ${access}`, ...h }, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const put = (body: unknown, account = usdWallet, h: Record<string, string> = {}) => call('POST', `/v1/accounts/${account}/auto-reload`, body, { 'idempotency-key': 'auto-reload-rule-1', 'x-step-up': stepUpToken, ...h });
const get = (account = usdWallet) => call('GET', `/v1/accounts/${account}/auto-reload`);
const available = async () => (await app.services.accounts.purses(member)).find((p) => p.currency === 'USD')!.available.minor;

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost(fixedClock(NOW.toISOString()) as AdvanceableClock);
  app = createApp({ db, registry: host.registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
  const s = app.services;
  const started = await s.otp.start({ phone: '+12125550101', locale: 'en' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Dana' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Dana', response: await device.register(r1.options!) });
  access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  member = principal.partyId;
  const su = await s.stepUp.start(principal);
  stepUpToken = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
  const purses = await s.accounts.purses(member);
  usdWallet = purses.find((p) => p.currency === 'USD')!.id;
  ilsWallet = purses.find((p) => p.currency === 'ILS')!.id;
}, 60_000);
afterAll(async () => db.close());

describe('/accounts/{id}/auto-reload', () => {
  it('404 before a rule exists; setting one needs a fresh step-up and a key; the body is validated against the purse', async () => {
    expect((await get()).status).toBe(404);
    expect((await put(RULE, usdWallet, { 'x-step-up': '' })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await put(RULE, usdWallet, { 'idempotency-key': 'x' })).status).toBe(422);
    expect((await put({ ...RULE, target: usd('5000') })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await put({ ...RULE, threshold: { minor: '5000', currency: 'ILS' } })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await put({ ...RULE, method: 'ach' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await put({ ...RULE, paymentMethodId: '' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await put({ ...RULE, enabled: 'yes' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await put(RULE, '11111111-1111-7111-8111-111111111111')).status).toBe(404);
    expect((await get()).status).toBe(404);
  });

  it('sets, reads, replaces and disables the rule; a disabled app answers FEATURE_OFF', async () => {
    const r = await put(RULE);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ accountId: usdWallet, currency: 'USD', enabled: true, threshold: usd('5000'), target: usd('20000'), method: 'card', paymentMethodId: 'pm_saved_1' });
    expect((await get()).body).toEqual(r.body);
    expect((await put({ ...RULE, target: usd('30000'), method: 'apple_pay' })).body).toMatchObject({ target: usd('30000'), method: 'apple_pay' });
    expect((await put({ ...RULE, enabled: false })).body).toMatchObject({ enabled: false, target: usd('20000') });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.auto_reload where party_id = $1`, [member])).rows[0]).toEqual({ n: 1 });
    // An ILS rule is separate.
    expect((await put({ threshold: { minor: '10000', currency: 'ILS' }, target: { minor: '50000', currency: 'ILS' }, method: 'card', paymentMethodId: 'pm_saved_1' }, ilsWallet)).body).toMatchObject({ accountId: ilsWallet, currency: 'ILS' });

    const off = createApp({ db, registry: new SimulatorHost().registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now, flags: new StaticFlags() });
    const rule = (await app.services.autoReload.byAccount(usdWallet))!;
    await expect(off.services.autoReload.set(member, usdWallet, RULE, now)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    expect(await app.services.autoReload.byAccount(usdWallet)).toEqual(rule);
  });

  it('TST-WAL-004: $45 below a $50 threshold loads $155 to the $200 target once; the window then holds, and the view says until when', async () => {
    const s = app.services;
    await put(RULE);
    await runLoad(s.loads, { payerPartyId: member, memberPartyId: member, method: 'card', amount: money(4_500n, 'USD'), paymentMethodId: 'pm_ok' }, 'seed-45', now);
    expect(await available()).toBe(4_500n);

    const rule = (await s.autoReload.byAccount(usdWallet))!;
    expect(await s.autoReload.due(now)).toContainEqual(rule);
    const a = await s.autoReload.attempt(rule, now);
    expect(a).toMatchObject({ outcome: 'loaded', available: money(4_500n, 'USD'), run: { workflowId: `auto-reload:${rule.id}:${now.getTime()}`, transfer: { state: 'settled', amount: money(15_500n, 'USD'), toPartyId: member } } });
    expect(await available()).toBe(20_000n);
    expect((await get()).body).toMatchObject({ lastAttemptAt: now.toISOString(), nextEligibleAt: new Date(now.getTime() + WINDOW_MS).toISOString() });

    // Spent back down inside the window: nothing more, however the rule is reached.
    await db.query(`update ops.account_balance set balance_minor = balance_minor + 18000 where account_id = $1`, [usdWallet]);
    expect(await available()).toBe(2_000n);
    now = new Date(NOW.getTime() + WINDOW_MS - 60_000);
    expect(await s.autoReload.due(now)).not.toContainEqual(expect.objectContaining({ id: rule.id }));
    expect(await s.autoReload.attempt((await s.autoReload.byAccount(usdWallet))!, now)).toMatchObject({ outcome: 'in_window' });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where kind = 'load' and to_party_id = $1`, [member])).rows[0]).toEqual({ n: 2 });

    // The window passes: eligible again, and loaded again to the target.
    now = new Date(NOW.getTime() + WINDOW_MS);
    const again = await s.autoReload.attempt((await s.autoReload.byAccount(usdWallet))!, now);
    expect(again).toMatchObject({ outcome: 'loaded', run: { transfer: { amount: money(18_000n, 'USD') } } });
    expect(await available()).toBe(20_000n);
    // A day on, the test's bearer and step-up have expired: the service answers for the view.
    const v: AutoReloadView = await s.autoReload.get(member, usdWallet, now);
    expect(v.nextEligibleAt).toBe(new Date(now.getTime() + WINDOW_MS).toISOString());
  });

  it('above the threshold nothing is claimed; a decline claims the window and is not retried inside it', async () => {
    const s = app.services;
    now = new Date(NOW.getTime() + 3 * WINDOW_MS);
    expect(await s.autoReload.attempt((await s.autoReload.byAccount(usdWallet))!, now)).toMatchObject({ outcome: 'above_threshold' });
    expect((await s.autoReload.byAccount(usdWallet))!.lastAttemptAt).toBe(new Date(NOW.getTime() + WINDOW_MS).toISOString());

    await s.autoReload.set(member, usdWallet, { ...RULE, paymentMethodId: 'pm_declined' }, now);
    await db.query(`update ops.account_balance set balance_minor = balance_minor + 19000 where account_id = $1`, [usdWallet]);
    expect(await available()).toBe(1_000n);
    const failed = await s.autoReload.attempt((await s.autoReload.byAccount(usdWallet))!, now);
    expect(failed).toMatchObject({ outcome: 'failed', run: { transfer: { state: 'failed', failureCode: 'DECLINED' } } });
    expect(await available()).toBe(1_000n);
    expect(await s.autoReload.get(member, usdWallet, now)).toMatchObject({ lastAttemptAt: now.toISOString(), nextEligibleAt: new Date(now.getTime() + WINDOW_MS).toISOString() });
    now = new Date(now.getTime() + WINDOW_MS - 1);
    expect(await s.autoReload.attempt((await s.autoReload.byAccount(usdWallet))!, now)).toMatchObject({ outcome: 'in_window' });
    expect(await s.autoReload.due(now)).not.toContainEqual(expect.objectContaining({ accountId: usdWallet }));
    now = new Date(now.getTime() + 1);
    expect(await s.autoReload.due(now)).toContainEqual(expect.objectContaining({ accountId: usdWallet }));
  });

  it('every row a US app writes carries US: the rule, its loads, a webhook and an add-on order (T-0027)', async () => {
    const rules = await db.query<{ market: string }>('select distinct market from ops.auto_reload');
    expect(rules.rows).toEqual([{ market: 'US' }]);
    const loads = await db.query<{ market: string }>(`select distinct market from ops.transfer where kind = 'load'`);
    expect(loads.rows).toEqual([{ market: 'US' }]);
    await app.services.inbound.record({ provider: 'simulator', eventId: 'evt-us-app', signatureOk: true, payload: {}, receivedAt: now });
    expect((await db.query<{ market: string }>(`select market from ops.inbound_event where event_id = 'evt-us-app'`)).rows).toEqual([{ market: 'US' }]);
    await db.query(`insert into addons.catalogue_item (sku, kind, provider, vendor_sku, title, attributes, cost_minor, price_minor, currency, synced_at) values ('esim:simulator:US-1GB', 'esim', 'simulator', 'US-1GB', 'US 1 GB', '{}', 100, 150, 'USD', now())`);
    const order = await app.services.orders.create({ idempotencyKey: 'order-us-app', memberPartyId: member, sku: 'esim:simulator:US-1GB' }, now);
    expect((await db.query<{ market: string }>('select market from addons.addon_order where id = $1', [order.id])).rows).toEqual([{ market: 'US' }]);
    const err = await db.query(`insert into ops.auto_reload (id, party_id, account_id, currency, enabled, threshold_minor, target_minor, method, payment_method_id, created_at, updated_at) values ($1, $2, $3, 'USD', true, 1, 2, 'card', 'pm', now(), now())`, [uuidv7(), member, uuidv7()]).catch((e: unknown) => e);
    expect(isPgError(err, '23514')).toBe(true);
  });

  it('the auto-reload job sees only this market\'s rules (T-0028)', async () => {
    const [ilAccount, ilRule] = [uuidv7(), uuidv7()];
    await db.query(`insert into ledger.account (id, type, currency, normal_side) values ($1, 'fee_income', 'ILS', 'C')`, [ilAccount]);
    await db.query(`insert into ops.auto_reload (id, party_id, account_id, currency, enabled, threshold_minor, target_minor, method, payment_method_id, created_at, updated_at, market) values ($1, $2, $3, 'ILS', true, 1, 2, 'card', 'pm', now(), now(), 'IL')`, [ilRule, uuidv7(), ilAccount]);
    const due = await app.services.autoReload.due(new Date(now.getTime() + 30 * 86_400_000));
    expect(due.length).toBeGreaterThan(0);
    expect(due.map((r) => r.id)).not.toContain(ilRule);
    const all = await db.query<{ id: string }>('select id from ops.auto_reload where enabled');
    expect(all.rows.map((r) => r.id)).toContain(ilRule);
  });

});
