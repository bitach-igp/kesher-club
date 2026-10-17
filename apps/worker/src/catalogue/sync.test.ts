// TST-MKT-002: prices come from price rules (cost + margin, floor, .99 rounding), never
// hard-coded. Given a cost change in the catalogue sync, the price updates at the next sync.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { EsimSimulator, InsuranceSimulator, type EsimPackage, type EsimPort } from '@kesher/ports';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { CatalogueSync } from './sync.ts';

let db: TestDatabase;
let sync: CatalogueSync;

beforeAll(async () => {
  db = await createTestDatabase();
  sync = new CatalogueSync(db, () => new Date('2026-11-01T03:00:00Z'));
  await sync.addRule({ kind: 'esim', provider: 'simulator', skuPattern: /^IL-/, marginBps: 2_500n, floor: money(999n, 'USD'), roundTo99: true, priority: 10 });
  await sync.addRule({ kind: 'insurance', provider: 'simulator', skuPattern: /.*/, marginBps: 0n, floor: money(0n, 'USD'), roundTo99: false, priority: 10 });
}, 60_000);
afterAll(async () => db.close());

/** A vendor whose costs we can change between syncs. */
class MutableEsim implements EsimPort {
  constructor(private readonly inner: EsimSimulator, public costOverride: Record<string, bigint> = {}) {}
  async listPackages(country: string): Promise<EsimPackage[]> {
    return (await this.inner.listPackages(country)).map((p) => (this.costOverride[p.sku] !== undefined ? { ...p, cost: money(this.costOverride[p.sku]!, 'USD') } : p));
  }
  order(sku: string, key: string) {
    return this.inner.order(sku, key);
  }
  topUp(iccid: string, sku: string, key: string) {
    return this.inner.topUp(iccid, sku, key);
  }
  getUsage(iccid: string) {
    return this.inner.getUsage(iccid);
  }
}

describe('catalogue sync (REQ-MKT-002)', () => {
  it('prices every vendor package by rule and records cost, price and the rule', async () => {
    const r = await sync.syncEsim('simulator', new EsimSimulator());
    expect(r.seen).toBe(4);
    expect(r.priced).toBe(4);
    expect(r.unpriced).toEqual([]);
    const row = await db.query<{ cost_minor: string; price_minor: string; price_rule_id: string | null; attributes: { dataGb: number } }>(`select cost_minor::text as cost_minor, price_minor::text as price_minor, price_rule_id, attributes from addons.catalogue_item where sku = 'esim:simulator:IL-5GB-30D'`);
    expect(row.rows[0]).toMatchObject({ cost_minor: '950', price_minor: '1199', attributes: { dataGb: 5 } }); // $9.50 + 25% = $11.875 → $11.99
    expect(row.rows[0]!.price_rule_id).toBeTruthy();
  });

  it('a cost change at the vendor changes the price at the next sync (TST-MKT-002)', async () => {
    const vendor = new MutableEsim(new EsimSimulator(), { 'IL-5GB-30D': 1_200n });
    const r = await sync.syncEsim('simulator', vendor);
    expect(r.changed).toEqual([{ sku: 'esim:simulator:IL-5GB-30D', from: 1199n, to: 1599n }]); // $12 + 25% = $15 → $15.99
    expect((await db.query<{ price_minor: string }>(`select price_minor::text as price_minor from addons.catalogue_item where sku = 'esim:simulator:IL-5GB-30D'`)).rows[0]).toEqual({ price_minor: '1599' });
  });

  it('packages the vendor dropped are deactivated, not deleted; unpriced packages are reported', async () => {
    const vendor = new MutableEsim(new EsimSimulator());
    vendor.listPackages = async () => [{ sku: 'IL-5GB-30D', country: 'IL', dataGb: 5, days: 30, cost: money(950n, 'USD') }, { sku: 'US-1GB-7D', country: 'IL', dataGb: 1, days: 7, cost: money(300n, 'USD') }];
    const r = await sync.syncEsim('simulator', vendor);
    expect(r.deactivated).toBe(3);
    expect(r.unpriced).toEqual(['US-1GB-7D']);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from addons.catalogue_item where provider = 'simulator' and kind = 'esim' and active`)).rows[0]).toEqual({ n: 1 });
    expect((await db.query<{ n: number }>(`select count(*)::int as n from addons.catalogue_item where provider = 'simulator' and kind = 'esim'`)).rows[0]).toEqual({ n: 4 });
  });

  it('insurance products are priced from premium − commission and keep the disclosures in the catalogue', async () => {
    const r = await sync.syncInsurance('simulator', new InsuranceSimulator(), [{ vendorSku: 'gadget', title: 'Gadget cover', days: 30 }]);
    expect(r.priced).toBe(1);
    const row = await db.query<{ cost_minor: string; price_minor: string; attributes: { disclosures: { licensedEntity: string } } }>(`select cost_minor::text as cost_minor, price_minor::text as price_minor, attributes from addons.catalogue_item where sku = 'insurance:simulator:gadget'`);
    expect(row.rows[0]).toMatchObject({ cost_minor: '399', price_minor: '399' }); // $4.99 premium − 20% commission = $3.99 cost; 0% margin, no rounding
    expect(row.rows[0]!.attributes.disclosures.licensedEntity).toContain('XCover');
  });

  it('the app role cannot write price rules', async () => {
    await db.asRole('club_app', async (app) => expect(app.query(`update addons.price_rule set margin_bps = 0`)).rejects.toMatchObject({ code: '42501' }));
  });
});
