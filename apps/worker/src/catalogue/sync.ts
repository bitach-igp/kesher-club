// Catalogue sync (T-0702, REQ-MKT-002): pulls vendor packages through the ports, prices each one
// with the active price rules, and upserts addons.catalogue_item. A cost change at the vendor
// changes the price at the next sync; nothing is hard-coded. Items the vendor stopped offering
// are deactivated, never deleted (orders reference them).
import { money, uuidv7, type Currency } from '@kesher/domain';
import type { EsimPort, InsurancePort } from '@kesher/ports';
import type { Database } from '@kesher/api/db';
import { priceFor, type PriceRule } from '@kesher/api/addons/pricing';

export interface SyncReport {
  provider: string;
  kind: 'esim' | 'insurance';
  seen: number;
  priced: number;
  unpriced: string[];
  deactivated: number;
  changed: { sku: string; from: bigint; to: bigint }[];
}

export interface InsuranceProduct {
  vendorSku: string;
  title: string;
  /** Standard quote inputs used to price the catalogue entry (30 days). */
  days: number;
}

export class CatalogueSync {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async rules(): Promise<PriceRule[]> {
    const r = await this.db.query<{ id: string; kind: PriceRule['kind']; provider: string; sku_pattern: string; margin_bps: number; floor_minor: string; currency: Currency; round_to_99: boolean; priority: number }>('select * from addons.price_rule where active order by priority');
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, provider: x.provider, skuPattern: new RegExp(x.sku_pattern), marginBps: BigInt(x.margin_bps), floor: money(BigInt(x.floor_minor), x.currency), roundTo99: x.round_to_99, priority: x.priority }));
  }

  async syncEsim(provider: string, port: EsimPort, countries: readonly string[] = ['IL']): Promise<SyncReport> {
    const rules = await this.rules();
    const report: SyncReport = { provider, kind: 'esim', seen: 0, priced: 0, unpriced: [], deactivated: 0, changed: [] };
    const seenSkus: string[] = [];
    for (const country of countries) {
      for (const pkg of await port.listPackages(country)) {
        report.seen += 1;
        const priced = priceFor(rules, 'esim', provider, pkg.sku, pkg.cost);
        if (!priced) {
          report.unpriced.push(pkg.sku);
          continue;
        }
        const sku = `esim:${provider}:${pkg.sku}`;
        seenSkus.push(sku);
        await this.upsert(report, { sku, kind: 'esim', provider, vendorSku: pkg.sku, title: `${pkg.country} ${pkg.dataGb} GB / ${pkg.days} days`, attributes: { dataGb: pkg.dataGb, days: pkg.days, country: pkg.country }, costMinor: pkg.cost.minor, priceMinor: priced.price.minor, currency: pkg.cost.currency, ruleId: priced.rule.id });
      }
    }
    report.deactivated = await this.deactivateMissing('esim', provider, seenSkus);
    return report;
  }

  async syncInsurance(provider: string, port: InsurancePort, products: readonly InsuranceProduct[]): Promise<SyncReport> {
    const rules = await this.rules();
    const report: SyncReport = { provider, kind: 'insurance', seen: 0, priced: 0, unpriced: [], deactivated: 0, changed: [] };
    const seenSkus: string[] = [];
    for (const p of products) {
      report.seen += 1;
      const q = await port.quote({ product: p.vendorSku, memberId: 'catalogue', market: 'IL', startsAt: this.clock().toISOString(), days: p.days });
      // Cost to us is the premium less our commission; the rule prices on top of that cost.
      const cost = money(q.premium.minor - q.commission.minor, q.premium.currency);
      const priced = priceFor(rules, 'insurance', provider, p.vendorSku, cost);
      if (!priced) {
        report.unpriced.push(p.vendorSku);
        continue;
      }
      const sku = `insurance:${provider}:${p.vendorSku}`;
      seenSkus.push(sku);
      await this.upsert(report, { sku, kind: 'insurance', provider, vendorSku: p.vendorSku, title: p.title, attributes: { days: p.days, coverage: q.coverageSummary, disclosures: q.disclosures }, costMinor: cost.minor, priceMinor: priced.price.minor, currency: cost.currency, ruleId: priced.rule.id });
    }
    report.deactivated = await this.deactivateMissing('insurance', provider, seenSkus);
    return report;
  }

  private async upsert(report: SyncReport, item: { sku: string; kind: string; provider: string; vendorSku: string; title: string; attributes: Record<string, unknown>; costMinor: bigint; priceMinor: bigint; currency: Currency; ruleId: string }): Promise<void> {
    const prior = await this.db.query<{ price_minor: string }>('select price_minor::text as price_minor from addons.catalogue_item where sku = $1', [item.sku]);
    await this.db.query(
      `insert into addons.catalogue_item (sku, kind, provider, vendor_sku, title, attributes, cost_minor, price_minor, currency, price_rule_id, active, synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)
       on conflict (sku) do update set title = excluded.title, attributes = excluded.attributes, cost_minor = excluded.cost_minor, price_minor = excluded.price_minor,
         currency = excluded.currency, price_rule_id = excluded.price_rule_id, active = true, synced_at = excluded.synced_at`,
      [item.sku, item.kind, item.provider, item.vendorSku, item.title, JSON.stringify(item.attributes), item.costMinor.toString(), item.priceMinor.toString(), item.currency, item.ruleId, this.clock()],
    );
    report.priced += 1;
    const before = prior.rows[0] ? BigInt(prior.rows[0].price_minor) : undefined;
    if (before !== undefined && before !== item.priceMinor) report.changed.push({ sku: item.sku, from: before, to: item.priceMinor });
  }

  private async deactivateMissing(kind: string, provider: string, seen: readonly string[]): Promise<number> {
    const r = await this.db.query(`update addons.catalogue_item set active = false, synced_at = $3 where kind = $1 and provider = $2 and active and not (sku = any($4::text[]))`, [kind, provider, this.clock(), seen]);
    return r.rowCount;
  }

  /** Seeds a rule (admin/ops action; rules are read-only for the app role). */
  async addRule(rule: Omit<PriceRule, 'id'>): Promise<string> {
    const id = uuidv7();
    await this.db.query('insert into addons.price_rule (id, kind, provider, sku_pattern, margin_bps, floor_minor, currency, round_to_99, priority) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [id, rule.kind, rule.provider, rule.skuPattern.source, Number(rule.marginBps), rule.floor.minor.toString(), rule.floor.currency, rule.roundTo99, rule.priority]);
    return id;
  }
}
