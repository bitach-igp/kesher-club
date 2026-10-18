// P2P limits (T-0505, REQ-PAY-002). TST-PAY-002: ₪1,200 against ₪1,000 remaining → LIMIT_EXCEEDED
// carrying the remaining amount, the lower of the plan's entitlement and the risk tier; usage is this
// month's sends that did not fail; a staff tier change moves the cap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator } from '@kesher/ports';
import { EntitlementService } from '../billing/entitlements.ts';
import { MembershipService } from '../billing/memberships.ts';
import { PlanService } from '../billing/plans.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { TransferService } from '../transfers/service.ts';
import { P2P_ENTITLEMENT, P2pLimitService } from './limits.ts';

let db: TestDatabase;
let limits: P2pLimitService;
let memberships: MembershipService;
let transfers: TransferService;
const NOW = new Date('2026-11-10T09:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  const plans = new PlanService(db);
  memberships = new MembershipService(db, plans, new BillingSimulator());
  transfers = new TransferService(db);
  limits = new P2pLimitService(db, memberships, new EntitlementService(db, plans), plans);
  await plans.ensurePlan('club', 'Kesher Club');
  await plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: { [P2P_ENTITLEMENT]: { limit: '250000', unit: 'minor', period: 'month' } }, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  await plans.ensurePlan('basic', 'Basic');
  await plans.createVersion({ planCode: 'basic', price: money(900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
}, 60_000);
afterAll(async () => db.close());

const sent = async (from: string, minor: bigint, state: 'settled' | 'failed' | 'submitted' = 'settled', at = NOW) => {
  const t = await transfers.create({ idempotencyKey: `p2p-${from}-${minor}-${state}-${at.getTime()}`, kind: 'p2p', fromPartyId: from, toPartyId: uuidv7(at), amount: money(minor, 'ILS') }, at);
  await transfers.apply(t.id, 'submit', at);
  if (state === 'settled') await transfers.apply(t.id, 'settle', at);
  if (state === 'failed') await transfers.apply(t.id, 'fail', at, { failureCode: 'x' });
  return t;
};

describe('TST-PAY-002', () => {
  it('a member without a plan entitlement is bound by the risk tier: new is ₪1,000 a month', async () => {
    const p = uuidv7(NOW);
    const d = await limits.decide(p, money(120_000n, 'ILS'), NOW);
    expect(d).toMatchObject({ allowed: false, tier: 'new', limitedBy: 'risk', remaining: money(100_000n, 'ILS'), risk: { limit: money(100_000n, 'ILS'), used: money(0n, 'ILS') } });
    expect(d.entitlement).toBeUndefined();
    await expect(limits.check(p, money(120_000n, 'ILS'), NOW)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', extra: { remaining: '100000', currency: 'ILS', limitedBy: 'risk' } });
    expect((await limits.check(p, money(100_000n, 'ILS'), NOW)).allowed).toBe(true);
  });

  it('this month\'s sends count against the tier, failed ones and last month\'s do not; a basic plan adds no cap', async () => {
    const p = uuidv7(NOW);
    const m = await memberships.create({ idempotencyKey: `m-basic-${p}`, memberPartyId: p, funderPartyId: p, funderEmail: 'b@example.com', planCode: 'basic' }, NOW);
    await memberships.setStatus(m.id, 'active', NOW);
    await sent(p, 40_000n);
    await sent(p, 30_000n, 'submitted');
    await sent(p, 50_000n, 'failed');
    await sent(p, 90_000n, 'settled', new Date('2026-10-20T09:00:00Z'));
    const d = await limits.decide(p, money(30_000n, 'ILS'), NOW);
    expect(d).toMatchObject({ allowed: true, limitedBy: 'risk', remaining: money(30_000n, 'ILS'), risk: { used: money(70_000n, 'ILS') } });
    expect(d.entitlement).toBeUndefined();
    await expect(limits.check(p, money(30_001n, 'ILS'), NOW)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', extra: { remaining: '30000' } });
    // USD is its own cap.
    expect((await limits.decide(p, money(30_000n, 'USD'), NOW)).remaining).toEqual(money(30_000n, 'USD'));
  });

  it('the lower of entitlement and tier wins: ₪1,200 against ₪1,000 remaining is refused with ₪1,000', async () => {
    const p = uuidv7(NOW);
    const m = await memberships.create({ idempotencyKey: `m-club-${p}`, memberPartyId: p, funderPartyId: p, funderEmail: 'c@example.com', planCode: 'club' }, NOW);
    await memberships.setStatus(m.id, 'active', NOW);
    // Plan: ₪2,500 a month; tier new: ₪1,000. The tier binds.
    let d = await limits.decide(p, money(120_000n, 'ILS'), NOW);
    expect(d).toMatchObject({ allowed: false, limitedBy: 'risk', remaining: money(100_000n, 'ILS'), entitlement: { limit: money(250_000n, 'ILS'), remaining: money(250_000n, 'ILS') } });
    await expect(limits.check(p, money(120_000n, 'ILS'), NOW)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', extra: { remaining: '100000', limitedBy: 'risk' } });

    // Trusted tier: ₪20,000; now the plan's ₪2,500 binds, less what the plan already recorded.
    await limits.setTier(p, 'trusted', 'staff:ops-1', 'long-standing member', NOW);
    await limits.consume(p, money(150_000n, 'ILS'), `usage-${p}-1`, NOW);
    await limits.consume(p, money(150_000n, 'ILS'), `usage-${p}-1`, NOW); // the same key records nothing more
    d = await limits.decide(p, money(120_000n, 'ILS'), NOW);
    expect(d).toMatchObject({ allowed: false, tier: 'trusted', limitedBy: 'entitlement', remaining: money(100_000n, 'ILS'), entitlement: { remaining: money(100_000n, 'ILS') }, risk: { limit: money(2_000_000n, 'ILS') } });
    await expect(limits.check(p, money(120_000n, 'ILS'), NOW)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', extra: { remaining: '100000', limitedBy: 'entitlement' } });
    expect((await limits.check(p, money(100_000n, 'ILS'), NOW)).allowed).toBe(true);
    await expect(limits.setTier(p, 'standard', 'staff:ops-1', '  ', NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await limits.tierOf(p)).toBe('trusted');
  });
});
