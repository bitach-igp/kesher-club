// TST-MKT-001: all add-ons follow the addon_order lifecycle and post cost, price and commission.
// Given a $25 eSIM with $20 cost: addon_payable $20 and fee_income $5.
// TST-ESIM-002: the monthly data credit applies automatically at checkout. Given a 5 GB credit,
// when buying 5 GB, the price is $0.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { createApp, type App } from '../app.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { dispatch } from '../server.ts';
import { EntitlementService } from '../billing/entitlements.ts';
import { MembershipService } from '../billing/memberships.ts';
import { PlanService } from '../billing/plans.ts';
import { AccountService } from '../ledger/accounts.ts';
import { PostgresLedger } from '../ledger/post.ts';
import { isPgError } from '../db.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { CreditService } from './credit.ts';
import { AddonOrderService } from './orders.ts';
import { applyRule, pickRule, roundUpTo99, type PriceRule } from './pricing.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
let accounts: AccountService;
let orders: AddonOrderService;
let memberships: MembershipService;
let entitlements: EntitlementService;
const now = new Date('2026-11-01T10:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  const plans = new PlanService(db);
  entitlements = new EntitlementService(db, plans);
  memberships = new MembershipService(db, plans, new BillingSimulator());
  orders = new AddonOrderService(db, ledger, accounts, new CreditService(entitlements));
  await plans.ensurePlan('club', 'Club');
  await plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: { 'esim.dataGb': { limit: '5', unit: 'gb', period: 'month' } }, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  await db.query(`insert into addons.catalogue_item (sku, kind, provider, vendor_sku, title, attributes, cost_minor, price_minor, currency, synced_at) values
    ('esim:airalo:IL-5GB-30D', 'esim', 'airalo', 'IL-5GB-30D', 'Israel 5 GB / 30 days', '{"dataGb": 5, "days": 30, "country": "IL"}', 2000, 2500, 'USD', now()),
    ('esim:airalo:IL-10GB-30D', 'esim', 'airalo', 'IL-10GB-30D', 'Israel 10 GB / 30 days', '{"dataGb": 10, "days": 30, "country": "IL"}', 3200, 3999, 'USD', now()),
    ('insurance:cover-genius:gadget', 'insurance', 'cover-genius', 'gadget', 'Gadget cover 30 days', '{}', 400, 499, 'USD', now())`);
}, 60_000);
afterAll(async () => db.close());

async function member(withMembership = true, fundMinor = 10_000n) {
  const memberPartyId = uuidv7();
  await accounts.provisionMember(memberPartyId);
  // Fund the wallet (default $100) so charges clear.
  const wallet = await accounts.memberAccount(memberPartyId, 'wallet', 'USD');
  const partner = await accounts.systemAccount('partner_settlement', 'USD');
  if (fundMinor > 0n) await ledger.post({ idempotencyKey: `fund:${memberPartyId}`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: fundMinor }, { accountId: wallet, currency: 'USD', amountMinor: -fundMinor }] });
  const membership = withMembership ? await memberships.create({ idempotencyKey: `m:${memberPartyId}`, memberPartyId, funderPartyId: uuidv7(), funderEmail: 'f@example.com', planCode: 'club' }, now) : undefined;
  return { memberPartyId, membership, wallet };
}

const balance = async (type: 'addon_payable' | 'fee_income') => -(await ledger.balance(await accounts.systemAccount(type, 'USD'), 'USD'));

describe('price rules (REQ-MKT-002)', () => {
  const rule: PriceRule = { id: 'r1', kind: 'esim', provider: 'airalo', skuPattern: /^IL-/, marginBps: 2_500n, floor: money(999n, 'USD'), roundTo99: true, priority: 10 };
  it('price = max(floor, cost × (1 + margin)) rounded up to .99', () => {
    expect(applyRule(money(2000n, 'USD'), rule)).toEqual(money(2599n, 'USD')); // $20 + 25% = $25 → $25.99
    expect(applyRule(money(100n, 'USD'), rule)).toEqual(money(999n, 'USD')); // floor
    expect(applyRule(money(2000n, 'USD'), { ...rule, roundTo99: false })).toEqual(money(2500n, 'USD'));
    expect(roundUpTo99(2500n)).toBe(2599n);
    expect(roundUpTo99(2599n)).toBe(2599n);
    expect(roundUpTo99(1n)).toBe(99n);
  });
  it('the lowest-priority matching rule wins', () => {
    const general = { ...rule, id: 'g', skuPattern: /.*/, priority: 100, marginBps: 1_000n };
    expect(pickRule([general, rule], 'esim', 'airalo', 'IL-5GB-30D')?.id).toBe('r1');
    expect(pickRule([general, rule], 'esim', 'airalo', 'US-5GB-30D')?.id).toBe('g');
    expect(pickRule([general, rule], 'esim', 'holafly', 'IL-5GB-30D')).toBeUndefined();
  });
});

describe('addon_order lifecycle (REQ-MKT-001)', () => {
  it('a $25 eSIM with $20 cost posts addon_payable $20 and fee_income $5 (TST-MKT-001)', async () => {
    const { memberPartyId, wallet } = await member(false);
    const payableBefore = await balance('addon_payable');
    const feeBefore = await balance('fee_income');
    const o = await orders.create({ idempotencyKey: 'o-1', memberPartyId, sku: 'esim:airalo:IL-5GB-30D' }, now);
    expect(o).toMatchObject({ state: 'charged', cost: money(2000n, 'USD'), price: money(2500n, 'USD'), credit: money(0n, 'USD') });
    expect((await balance('addon_payable')) - payableBefore).toBe(2000n);
    expect((await balance('fee_income')) - feeBefore).toBe(500n);
    expect(-(await ledger.balance(wallet, 'USD'))).toBe(7_500n);
    const again = await orders.create({ idempotencyKey: 'o-1', memberPartyId, sku: 'esim:airalo:IL-5GB-30D' }, now);
    expect(again.id).toBe(o.id);
    expect((await db.query(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [`addon:${o.id}:charge`])).rows[0]).toEqual({ n: 1 });
  });

  it('with a 5 GB credit, buying 5 GB costs $0 and the club absorbs the cost (TST-ESIM-002)', async () => {
    const { memberPartyId, membership, wallet } = await member();
    const feeBefore = await balance('fee_income');
    const o = await orders.create({ idempotencyKey: 'o-2', memberPartyId, membership, sku: 'esim:airalo:IL-5GB-30D' }, now);
    expect(o).toMatchObject({ state: 'charged', listPrice: money(2500n, 'USD'), credit: money(2500n, 'USD'), price: money(0n, 'USD') });
    expect(-(await ledger.balance(wallet, 'USD'))).toBe(10_000n);
    expect((await balance('fee_income')) - feeBefore).toBe(-2000n); // subsidy: fee_income debited by the cost
    expect((await entitlements.can(membership!, 'esim.dataGb', 1n, now)).remaining).toBe(0n);
    // A second 5 GB this month is charged in full.
    const o2 = await orders.create({ idempotencyKey: 'o-3', memberPartyId, membership, sku: 'esim:airalo:IL-5GB-30D' }, now);
    expect(o2.price).toEqual(money(2500n, 'USD'));
  });

  it('a 10 GB purchase with a 5 GB credit is half price', async () => {
    const { memberPartyId, membership } = await member();
    const o = await orders.create({ idempotencyKey: 'o-4', memberPartyId, membership, sku: 'esim:airalo:IL-10GB-30D' }, now);
    expect(o).toMatchObject({ listPrice: money(3999n, 'USD'), credit: money(1999n, 'USD'), price: money(2000n, 'USD') });
  });

  it('fulfilment states and a failure refund to source with the credit restored (SEQ-10 compensation)', async () => {
    const { memberPartyId, membership, wallet } = await member();
    const o = await orders.create({ idempotencyKey: 'o-5', memberPartyId, membership, sku: 'esim:airalo:IL-10GB-30D' }, now);
    await orders.transition(o.id, 'fulfilling', now);
    await expect(orders.transition(o.id, 'charged', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const failed = await orders.transition(o.id, 'failed', now, { failureCode: 'PROVIDER_UNAVAILABLE' });
    expect(failed.failureCode).toBe('PROVIDER_UNAVAILABLE');
    const refunded = await orders.refund(o.id, now, 'vendor outage');
    expect(refunded.state).toBe('refunded');
    expect(refunded.refundJournalId).toBeTruthy();
    expect(-(await ledger.balance(wallet, 'USD'))).toBe(10_000n);
    expect((await entitlements.can(membership!, 'esim.dataGb', 5n, now)).remaining).toBe(5n);
    await expect(orders.refund(o.id, now, 'twice')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const events = await db.query<{ to_state: string }>('select to_state from addons.addon_order_event where order_id = $1 order by id', [o.id]);
    expect(events.rows.map((e) => e.to_state)).toEqual(['created', 'charged', 'fulfilling', 'failed', 'refunded']);
  });

  it('insurance needs acknowledged disclosures before payment (REQ-INSR-001) and unknown SKUs are 404', async () => {
    const { memberPartyId } = await member(false);
    await expect(orders.create({ idempotencyKey: 'o-6', memberPartyId, sku: 'insurance:cover-genius:gadget' }, now)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const o = await orders.create({ idempotencyKey: 'o-7', memberPartyId, sku: 'insurance:cover-genius:gadget', disclosuresAcknowledged: true }, now);
    expect(o.state).toBe('charged');
    await expect(orders.create({ idempotencyKey: 'o-8', memberPartyId, sku: 'nope' }, now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('records the market of the API that placed the order; the database refuses an order without one (T-0027)', async () => {
    const { memberPartyId } = await member(false);
    const us = await new AddonOrderService(db, ledger, accounts, new CreditService(entitlements), 'US').create({ idempotencyKey: 'o-market-us', memberPartyId, sku: 'esim:airalo:IL-5GB-30D' }, now);
    const il = await orders.create({ idempotencyKey: 'o-market-il', memberPartyId, sku: 'esim:airalo:IL-5GB-30D' }, now);
    const r = await db.query<{ id: string; market: string }>('select id, market from addons.addon_order where id = any($1)', [[us.id, il.id]]);
    expect(Object.fromEntries(r.rows.map((x) => [x.id, x.market]))).toEqual({ [us.id]: 'US', [il.id]: 'IL' });
    const err = await db
      .query(`insert into addons.addon_order (id, idempotency_key, member_party_id, sku, kind, provider, state, cost_minor, price_minor, list_price_minor, currency) values ($1, 'o-market-none', $2, 'esim:airalo:IL-5GB-30D', 'esim', 'airalo', 'created', 2000, 2500, 2500, 'USD')`, [uuidv7(), memberPartyId])
      .catch((e: unknown) => e);
    expect(isPgError(err, '23514')).toBe(true);
  });
});

describe('a funds check, a validated quantity and a request-bound key (T-0542, F12)', () => {
  const sku = 'esim:airalo:IL-5GB-30D';
  const orderRows = async (memberPartyId: string) => (await db.query<{ n: number }>(`select count(*)::int as n from addons.addon_order where member_party_id = $1`, [memberPartyId])).rows[0]!.n;
  const chargeJournals = async () => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key like 'addon:%:charge'`)).rows[0]!.n;

  it('an empty wallet cannot order an eSIM: INSUFFICIENT_FUNDS, no order, no charge, no credit consumed', async () => {
    const { memberPartyId, membership, wallet } = await member(true, 0n);
    const journalsBefore = await chargeJournals();
    // 10 GB with a 5 GB credit still costs money: the check is on the price after credit.
    await expect(orders.create({ idempotencyKey: 'f-1-empty', memberPartyId, membership, sku: 'esim:airalo:IL-10GB-30D' }, now)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await orderRows(memberPartyId)).toBe(0);
    expect(await chargeJournals()).toBe(journalsBefore);
    expect(-(await ledger.balance(wallet, 'USD'))).toBe(0n);
    expect((await entitlements.can(membership!, 'esim.dataGb', 1n, now)).remaining).toBe(5n); // the credit was not spent
  });

  it('a wallet short by one cent is refused; exactly the price is enough; a fully credited order needs no funds', async () => {
    const short = await member(false, 2_499n);
    await expect(orders.create({ idempotencyKey: 'f-2-short', memberPartyId: short.memberPartyId, sku }, now)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const exact = await member(false, 2_500n);
    expect(await orders.create({ idempotencyKey: 'f-2-exact', memberPartyId: exact.memberPartyId, sku }, now)).toMatchObject({ state: 'charged' });
    expect(-(await ledger.balance(exact.wallet, 'USD'))).toBe(0n);
    const credited = await member(true, 0n);
    expect(await orders.create({ idempotencyKey: 'f-2-free', memberPartyId: credited.memberPartyId, membership: credited.membership, sku }, now)).toMatchObject({ state: 'charged', price: money(0n, 'USD') });
  });

  it('the quantity is an integer from 1 to 10: 1.5, 0, -1, 11, NaN and a string are VALIDATION_FAILED, not a 500, and leave nothing behind', async () => {
    const { memberPartyId } = await member(false);
    for (const [i, quantity] of [1.5, 0, -1, 11, Number.NaN, '2' as unknown as number].entries()) {
      await expect(orders.create({ idempotencyKey: `f-3-q-${i}`, memberPartyId, sku, quantity }, now)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await orderRows(memberPartyId)).toBe(0);
    expect(await orders.create({ idempotencyKey: 'f-3-ten', memberPartyId, sku, quantity: 1 }, now)).toMatchObject({ state: 'charged' });
  });

  it('a key finds its order only for the same member, sku and quantity; anything else is IDEMPOTENCY_CONFLICT', async () => {
    const a = await member(false);
    const b = await member(false);
    const first = await orders.create({ idempotencyKey: 'f-4-key', memberPartyId: a.memberPartyId, sku, quantity: 2 }, now);
    expect((await orders.create({ idempotencyKey: 'f-4-key', memberPartyId: a.memberPartyId, sku, quantity: 2 }, now)).id).toBe(first.id);
    await expect(orders.create({ idempotencyKey: 'f-4-key', memberPartyId: b.memberPartyId, sku, quantity: 2 }, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(orders.create({ idempotencyKey: 'f-4-key', memberPartyId: a.memberPartyId, sku: 'esim:airalo:IL-10GB-30D', quantity: 2 }, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(orders.create({ idempotencyKey: 'f-4-key', memberPartyId: a.memberPartyId, sku, quantity: 1 }, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // The other member got nothing and was charged nothing.
    expect(await orderRows(b.memberPartyId)).toBe(0);
    expect(-(await ledger.balance(b.wallet, 'USD'))).toBe(10_000n);
  });
});

describe('replays, races and a re-checked charge (T-0548, follow-up of T-0542)', () => {
  const sku = 'esim:airalo:IL-5GB-30D';
  const chargeJournal = async (id: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [`addon:${id}:charge`])).rows[0]!.n;

  it('an order left in created by a crash is charged when its key is replayed, once', async () => {
    const { memberPartyId } = await member(false, 10_000n);
    const crash = vi.spyOn(orders, 'charge').mockRejectedValueOnce(new Error('crashed before the charge'));
    await expect(orders.create({ idempotencyKey: 'r-1-crash', memberPartyId, sku }, now)).rejects.toThrow('crashed');
    crash.mockRestore();
    const stuck = (await orders.byKey('r-1-crash'))!;
    expect(stuck.state).toBe('created');
    expect(await chargeJournal(stuck.id)).toBe(0);
    const replay = await orders.create({ idempotencyKey: 'r-1-crash', memberPartyId, sku }, now);
    expect(replay).toMatchObject({ id: stuck.id, state: 'charged' });
    expect(await chargeJournal(stuck.id)).toBe(1);
    expect((await orders.create({ idempotencyKey: 'r-1-crash', memberPartyId, sku }, now)).state).toBe('charged');
    expect(await chargeJournal(stuck.id)).toBe(1);
  });

  it('funds that drained between create and charge are re-checked: the charge is refused, the order stays created, nothing posts', async () => {
    const { memberPartyId, wallet } = await member(false, 2_500n);
    const crash = vi.spyOn(orders, 'charge').mockRejectedValueOnce(new Error('crashed before the charge'));
    await expect(orders.create({ idempotencyKey: 'r-2-drain', memberPartyId, sku }, now)).rejects.toThrow('crashed');
    crash.mockRestore();
    const stuck = (await orders.byKey('r-2-drain'))!;
    // Another purchase spends the wallet.
    const partner = await accounts.systemAccount('partner_settlement', 'USD');
    await ledger.post({ idempotencyKey: 'r-2-spend', kind: 'p2p', postings: [{ accountId: wallet, currency: 'USD', amountMinor: 2_500n }, { accountId: partner, currency: 'USD', amountMinor: -2_500n }] });
    await expect(orders.create({ idempotencyKey: 'r-2-drain', memberPartyId, sku }, now)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect((await orders.get(stuck.id))!.state).toBe('created');
    expect(await chargeJournal(stuck.id)).toBe(0);
  });

  it('two creates racing on one key: the loser, finding the unique key taken, returns the winner\'s order and never makes a second', async () => {
    const { memberPartyId } = await member(false, 10_000n);
    const first = await orders.create({ idempotencyKey: 'r-3-race', memberPartyId, sku }, now);
    // The loser did not see the winner's row on its first read.
    const real = orders.byKey.bind(orders);
    const seen = vi.spyOn(orders, 'byKey').mockImplementationOnce(async () => undefined).mockImplementation(real);
    const second = await orders.create({ idempotencyKey: 'r-3-race', memberPartyId, sku }, now);
    seen.mockRestore();
    expect(second.id).toBe(first.id);
    expect((await db.query(`select 1 from addons.addon_order where idempotency_key = 'r-3-race'`)).rows).toHaveLength(1);
    expect(await chargeJournal(first.id)).toBe(1);
  });

  it('a charge that posted but never moved the order is finished on replay, even though the wallet no longer holds the price', async () => {
    const { memberPartyId, wallet } = await member(false, 2_500n);
    const crash = vi.spyOn(orders, 'transition').mockRejectedValueOnce(new Error('crashed after the journal'));
    await expect(orders.create({ idempotencyKey: 'r-6-paid', memberPartyId, sku }, now)).rejects.toThrow('crashed');
    crash.mockRestore();
    const stuck = (await orders.byKey('r-6-paid'))!;
    expect(stuck.state).toBe('created');
    expect(await chargeJournal(stuck.id)).toBe(1);
    expect(-(await ledger.balance(wallet, 'USD'))).toBe(0n); // the price has left the wallet already
    const replay = await orders.create({ idempotencyKey: 'r-6-paid', memberPartyId, sku }, now);
    expect(replay).toMatchObject({ id: stuck.id, state: 'charged' });
    expect(await chargeJournal(stuck.id)).toBe(1);
  });

  it('two callers charging one created order both end on the charged order, with one journal', async () => {
    const { memberPartyId } = await member(false, 10_000n);
    const crash = vi.spyOn(orders, 'charge').mockRejectedValueOnce(new Error('crashed before the charge'));
    await expect(orders.create({ idempotencyKey: 'r-7-two', memberPartyId, sku }, now)).rejects.toThrow('crashed');
    crash.mockRestore();
    const stuck = (await orders.byKey('r-7-two'))!;
    const [a, b] = await Promise.all([orders.charge(stuck.id, now), orders.charge(stuck.id, now)]);
    expect([a.state, b.state]).toEqual(['charged', 'charged']);
    expect(await chargeJournal(stuck.id)).toBe(1);
  });

  it('a replay does not spend the credit again', async () => {
    const { memberPartyId, membership } = await member(true, 10_000n);
    const crash = vi.spyOn(orders, 'charge').mockRejectedValueOnce(new Error('crashed before the charge'));
    await expect(orders.create({ idempotencyKey: 'r-8-credit', memberPartyId, membership, sku: 'esim:airalo:IL-10GB-30D' }, now)).rejects.toThrow('crashed');
    crash.mockRestore();
    const afterCreate = (await entitlements.can(membership!, 'esim.dataGb', 1n, now)).remaining;
    await orders.create({ idempotencyKey: 'r-8-credit', memberPartyId, membership, sku: 'esim:airalo:IL-10GB-30D' }, now);
    await orders.create({ idempotencyKey: 'r-8-credit', memberPartyId, membership, sku: 'esim:airalo:IL-10GB-30D' }, now);
    expect((await entitlements.can(membership!, 'esim.dataGb', 1n, now)).remaining).toBe(afterCreate);
  });

  it('the top quantity, 10, orders and is priced for ten', async () => {
    const { memberPartyId } = await member(false, 50_000n);
    const o = await orders.create({ idempotencyKey: 'r-4-ten', memberPartyId, sku, quantity: 10 }, now);
    expect(o).toMatchObject({ state: 'charged', quantity: 10, price: money(25_000n, 'USD') });
  });

  it('a refused order leaves nothing for the vendor: no row, no event queued for it', async () => {
    const { memberPartyId } = await member(false, 0n);
    const before = (await db.query<{ n: number }>(`select count(*)::int as n from ops.outbox`)).rows[0]!.n;
    await expect(orders.create({ idempotencyKey: 'r-5-empty', memberPartyId, sku }, now)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ops.outbox`)).rows[0]!.n).toBe(before);
  });
});

describe('POST /addon-orders needs a step-up like every money route (T-0542)', () => {
  const T = new Date('2026-11-10T09:00:00Z');
  let app: App;
  let access = '';
  let stepUp = '';
  let partyId = '';

  beforeAll(async () => {
    app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => T, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
    const s = app.services;
    const started = await s.otp.start({ phone: '+972501000042', locale: 'he' });
    const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
    const device = new SimPasskeyDevice();
    const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa' });
    const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa', response: await device.register(r1.options!) });
    access = r2.tokens!.accessToken;
    const principal = await s.tokens.verifyAccess(access);
    partyId = principal.partyId;
    const su = await s.stepUp.start(principal);
    stepUp = (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken;
    await accounts.provisionMember(partyId);
    const wallet = await accounts.memberAccount(partyId, 'wallet', 'USD');
    const partner = await accounts.systemAccount('partner_settlement', 'USD');
    await ledger.post({ idempotencyKey: `fund:http:${partyId}`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: 10_000n }, { accountId: wallet, currency: 'USD', amountMinor: -10_000n }] });
  }, 60_000);

  const order = (body: Record<string, unknown>, key: string, headers: Record<string, string> = {}) =>
    dispatch(app, { method: 'POST', url: '/v1/addon-orders', headers: { authorization: `Bearer ${access}`, 'idempotency-key': key, ...headers }, rawBody: JSON.stringify(body), now: T });
  const orderCount = async () => (await db.query<{ n: number }>(`select count(*)::int as n from addons.addon_order where member_party_id = $1`, [partyId])).rows[0]!.n;

  it('without a step-up token it answers 401 STEP_UP_REQUIRED and creates nothing; with one it orders', async () => {
    const denied = await order({ sku: 'esim:airalo:IL-5GB-30D' }, 'http-1-no-stepup');
    expect(denied.body).toMatchObject({ status: 401, code: 'STEP_UP_REQUIRED' });
    expect(await orderCount()).toBe(0);
    const ok = await order({ sku: 'esim:airalo:IL-5GB-30D' }, 'http-1-with-stepup', { 'x-step-up': stepUp });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ sku: 'esim:airalo:IL-5GB-30D', state: 'charged' });
  });

  it('a bad quantity over HTTP is 422 VALIDATION_FAILED, including 0 (not silently 1) and a string', async () => {
    const before = await orderCount();
    for (const [i, quantity] of [0, -1, 1.5, 11, '2'].entries()) {
      const r = await order({ sku: 'esim:airalo:IL-5GB-30D', quantity }, `http-2-badqty-${i}`, { 'x-step-up': stepUp });
      expect(r.body).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    }
    expect(await orderCount()).toBe(before);
  });

  it('an empty wallet over HTTP is 422 INSUFFICIENT_FUNDS', async () => {
    // Spend whatever the wallet holds on $25 eSIMs (however many earlier tests ordered), then there is nothing left.
    const left = (await accounts.purses(partyId)).find((p) => p.currency === 'USD')!.available.minor;
    expect(left >= 2_500n && left <= 25_000n).toBe(true);
    const drain = await order({ sku: 'esim:airalo:IL-5GB-30D', quantity: Number(left / 2_500n) }, 'http-3-drain-wallet', { 'x-step-up': stepUp });
    expect(drain.status).toBe(201);
    const r = await order({ sku: 'esim:airalo:IL-5GB-30D' }, 'http-3-empty-wallet', { 'x-step-up': stepUp });
    expect(r.body).toMatchObject({ status: 422, code: 'INSUFFICIENT_FUNDS' });
  });
});
