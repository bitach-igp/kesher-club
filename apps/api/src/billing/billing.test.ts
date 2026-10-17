// T-0302: plans, immutable versions, entitlement templates, can()/consume(), createMembership
// through the BillingPort, and /me/capabilities.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator } from '@kesher/ports';
import { makeRequest } from '../http.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { capabilitiesHandler, StaticFlags } from './capabilities.ts';
import { EntitlementService, periodStart } from './entitlements.ts';
import { MembershipService } from './memberships.ts';
import { PlanService } from './plans.ts';

let db: TestDatabase;
let plans: PlanService;
let entitlements: EntitlementService;
let memberships: MembershipService;
let billingSim: BillingSimulator;
const now = new Date('2026-11-01T10:00:00Z');
const CLUB = { 'esim.dataGb': { limit: '5', unit: 'gb' as const, period: 'month' as const }, 'p2p.monthlyLimitMinor': { limit: '500000', unit: 'minor' as const, period: 'month' as const }, 'concierge.calls': { limit: '3', unit: 'calls' as const, period: 'term' as const } };

beforeAll(async () => {
  db = await createTestDatabase();
  plans = new PlanService(db);
  entitlements = new EntitlementService(db, plans);
  billingSim = new BillingSimulator();
  memberships = new MembershipService(db, plans, billingSim);
  await plans.ensurePlan('club', 'Kesher Club');
  await plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: CLUB, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
}, 60_000);
afterAll(async () => db.close());

async function member(email = 'funder@example.com') {
  const memberPartyId = uuidv7();
  const m = await memberships.create({ idempotencyKey: `m-${memberPartyId}`, memberPartyId, funderPartyId: uuidv7(), funderEmail: email, planCode: 'club' }, now);
  return m;
}

describe('plans', () => {
  it('versions are append-only and the current version is the latest effective one', async () => {
    const v2 = await plans.createVersion({ planCode: 'club', price: money(5_900n, 'USD'), termMonths: 10, entitlements: { ...CLUB, 'esim.dataGb': { limit: '10', unit: 'gb', period: 'month' } }, effectiveFrom: new Date('2027-09-01T00:00:00Z') });
    expect(v2.version).toBe(2);
    expect((await plans.current('club', now)).version).toBe(1);
    expect((await plans.current('club', new Date('2027-09-02T00:00:00Z'))).version).toBe(2);
    await db.asRole('club_app', async (app) => expect(app.query(`update billing.plan_version set price_minor = 1`)).rejects.toMatchObject({ code: '42501' }));
    await expect(plans.createVersion({ planCode: 'club', price: money(1n, 'USD'), termMonths: 10, entitlements: { x: { limit: 'five', unit: 'count', period: 'none' } }, effectiveFrom: now })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('memberships', () => {
  it('creates a vendor customer + subscription once per key and pins the plan version and price', async () => {
    const memberPartyId = uuidv7();
    const funderPartyId = uuidv7();
    const input = { idempotencyKey: 'mem-1', memberPartyId, funderPartyId, funderEmail: 'f@example.com', planCode: 'club' };
    const a = await memberships.create(input, now);
    const b = await memberships.create(input, now);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ status: 'active', planVersion: 1, termMonths: 10, price: money(4_900n, 'USD') });
    const refs = await db.query<{ entity_type: string }>(`select entity_type from ops.external_ref where provider = 'stripe' and entity_id in ($1, $2)`, [a.id, funderPartyId]);
    expect(refs.rows.map((r) => r.entity_type).sort()).toEqual(['membership', 'party']);
    // Later price change does not touch the running membership.
    expect((await memberships.get(a.id))!.price).toEqual(money(4_900n, 'USD'));
  });

  it('maps a declined card to a 422 problem and an outage to 503', async () => {
    await expect(member('x@declined.example')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(member('x@outage.example')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('entitlements', () => {
  it('can() answers from the template and the period usage; consume() is idempotent and enforces the limit', async () => {
    const m = await member();
    expect(await entitlements.can(m, 'esim.dataGb', 5n, now)).toMatchObject({ allowed: true, remaining: 5n, limit: 5n, unit: 'gb', resetsAt: '2026-12-01T00:00:00.000Z' });
    expect((await entitlements.can(m, 'esim.dataGb', 6n, now)).allowed).toBe(false);
    const after = await entitlements.consume(m, 'esim.dataGb', 5n, 'order-1', now);
    expect(after.remaining).toBe(0n);
    await entitlements.consume(m, 'esim.dataGb', 5n, 'order-1', now); // replay: no second deduction, no error
    expect((await entitlements.can(m, 'esim.dataGb', 1n, now)).remaining).toBe(0n);
    await expect(entitlements.consume(m, 'esim.dataGb', 1n, 'order-2', now)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    // New month: credit resets.
    const dec = new Date('2026-12-02T10:00:00Z');
    expect((await entitlements.can(m, 'esim.dataGb', 5n, dec)).allowed).toBe(true);
    expect(periodStart('month', dec, new Date(m.createdAt))).toBe('2026-12-01');
  });

  it('term entitlements reset at the end of the term, not monthly; unknown keys and inactive memberships are refused', async () => {
    const m = await member();
    const d = await entitlements.can(m, 'concierge.calls', 1n, now);
    expect(d).toMatchObject({ allowed: true, limit: 3n, resetsAt: '2027-09-01T10:00:00.000Z' });
    expect((await entitlements.can(m, 'nope.key', 1n, now)).allowed).toBe(false);
    await memberships.setStatus(m.id, 'paused', now);
    expect((await entitlements.can({ ...m, status: 'paused' }, 'concierge.calls', 1n, now)).allowed).toBe(false);
  });
});

describe('GET /me/capabilities', () => {
  it('returns client-visible flags with registry defaults and the entitlement summary', async () => {
    const m = await member();
    const flags = new StaticFlags(undefined, { 'esim.airalo': true });
    const handler = capabilitiesHandler({ flags, memberships, entitlements });
    const res = await handler(makeRequest({ method: 'GET', path: '/me/capabilities', principal: { partyId: m.memberPartyId, roles: ['member'], sessionId: 's', deviceId: 'd' }, now }));
    expect(res.status).toBe(200);
    const body = res.body as { features: Record<string, boolean>; entitlements: Record<string, { remaining: string }>; membership: { status: string } };
    expect(body.features['esim.airalo']).toBe(true);
    expect(body.features['wallet.enabled']).toBe(false);
    expect(body.features['auth.passkey.primary']).toBe(true);
    expect(body.entitlements['esim.dataGb']).toMatchObject({ remaining: '5', unit: 'gb' });
    expect(body.membership).toEqual({ status: 'active', planCode: 'club' });
    expect(() => new StaticFlags(undefined, { 'made.up': true })).toThrow(/config\/flags\.json/);
    expect(new StaticFlags().isOn('does.not.exist')).toBe(false);
  });

  it('is 401 without a principal', async () => {
    const res = await capabilitiesHandler({ flags: new StaticFlags(), memberships, entitlements })(makeRequest({ method: 'GET', path: '/me/capabilities', now }));
    expect(res.status).toBe(401);
  });
});
