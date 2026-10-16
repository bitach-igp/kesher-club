// TST-MKT-001: all add-ons follow the addon_order lifecycle and post cost, price and commission.
// Given a $25 eSIM with $20 cost: addon_payable $20 and fee_income $5.
// TST-ESIM-002: the monthly data credit applies automatically at checkout. Given a 5 GB credit,
// when buying 5 GB, the price is $0.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator } from '@kesher/ports';
import { EntitlementService } from '../billing/entitlements.ts';
import { MembershipService } from '../billing/memberships.ts';
import { PlanService } from '../billing/plans.ts';
import { AccountService } from '../ledger/accounts.ts';
import { PostgresLedger } from '../ledger/post.ts';
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

async function member(withMembership = true) {
  const memberPartyId = uuidv7();
  await accounts.provisionMember(memberPartyId);
  // Fund the wallet with $100 so charges clear.
  const wallet = await accounts.memberAccount(memberPartyId, 'wallet', 'USD');
  const partner = await accounts.systemAccount('partner_settlement', 'USD');
  await ledger.post({ idempotencyKey: `fund:${memberPartyId}`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: 10_000n }, { accountId: wallet, currency: 'USD', amountMinor: -10_000n }] });
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
});
