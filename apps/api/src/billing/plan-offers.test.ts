// TST-BIL-001 the plans a member sees (T-0305, REQ-BIL-001): per plan, the version a new member joins on now in the
// chosen market, at its price per term with the monthly price rounded up; a proposed version is never listed, and
// once a second finance member approves it, it is the one offered. A market other than IL or US answers 422; signed
// out answers 401. A version made before T-0932 names no market and is listed by its currency.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { OfferedPlan } from './plan-catalogue.ts';

let db: TestDatabase;
let app: App;
let ben: string;
const NOW = new Date('2026-11-10T09:00:00Z');
const FINANCE_A = { partyId: uuidv7(NOW), role: 'finance', subject: 'finance-a' };
const FINANCE_B = { partyId: uuidv7(NOW), role: 'finance', subject: 'finance-b' };
const DATA = { 'esim.dataGb': { limit: '5', unit: 'gb' as const, period: 'month' as const } };
const plans = (market: string, token: string | undefined = ben) => dispatch(app, { method: 'GET', url: `/v1/plans?market=${market}`, headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: '', now: NOW });
const propose = async (planCode: string, market: 'IL' | 'US', minor: bigint, reason: string) =>
  (await app.services.planCatalogue.propose({ planCode, name: `${planCode} name`, market, priceMinor: minor, currency: market === 'IL' ? 'ILS' : 'USD', termMonths: 10, entitlements: DATA, fxMarkupBps: 75n, effectiveFrom: NOW, reason }, FINANCE_A, NOW)).version;

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  ben = (await app.services.tokens.issue({ partyId: uuidv7(NOW), deviceId: 'phone', roles: ['member'] })).accessToken;
  await app.services.planCatalogue.approve('demo-club-us', (await propose('demo-club-us', 'US', 4_900n, 'Demo price')).version, FINANCE_B, NOW);
  await app.services.planCatalogue.approve('demo-club-il', (await propose('demo-club-il', 'IL', 18_000n, 'Demo price')).version, FINANCE_B, NOW);
}, 60_000);
afterAll(async () => db.close());

describe('offered plans (TST-BIL-001, T-0305)', () => {
  it('lists the version offered now in the market, at its price, term and monthly price; a proposed one never', async () => {
    await propose('demo-club-us', 'US', 5_900n, 'Second year');
    const r = await plans('US');
    expect(r.status).toBe(200);
    expect((r.body as { items: OfferedPlan[] }).items).toEqual([
      { planCode: 'demo-club-us', name: 'demo-club-us name', version: 1, market: 'US', price: { minor: '4900', currency: 'USD' }, termMonths: 10, monthlyPrice: { minor: '490', currency: 'USD' }, entitlements: DATA, fxMarkupBps: 75 },
    ]);
    // No staff fields reach a member.
    expect(JSON.stringify(r.body)).not.toMatch(/proposedBy|reason|state/);
  });

  it('once a second finance member approves the newer version, it is the one offered', async () => {
    await app.services.planCatalogue.approve('demo-club-us', 2, FINANCE_B, NOW);
    expect((await plans('US')).body).toMatchObject({ items: [{ planCode: 'demo-club-us', version: 2, price: { minor: '5900', currency: 'USD' }, monthlyPrice: { minor: '590', currency: 'USD' } }] });
  });

  it('a market lists its own plans, a version made before T-0932 by its currency, and rounds the monthly price up', async () => {
    await app.services.plans.ensurePlan('legacy-il', 'Legacy Israel');
    await app.services.plans.createVersion({ planCode: 'legacy-il', price: money(10_001n, 'ILS'), termMonths: 12, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    const items = ((await plans('IL')).body as { items: OfferedPlan[] }).items;
    expect(items.map((p) => [p.planCode, p.price.minor, p.monthlyPrice.minor])).toEqual([
      ['demo-club-il', '18000', '1800'],
      ['legacy-il', '10001', '834'],
    ]);
  });

  it('a market other than IL or US answers 422; signed out answers 401', async () => {
    expect([(await plans('EU')).status, ((await plans('EU')).body as { code: string }).code]).toEqual([422, 'VALIDATION_FAILED']);
    expect((await plans('US', '')).status).toBe(401);
  });
});
