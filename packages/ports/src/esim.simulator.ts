// Stateful eSIM simulator. Deterministic fixtures:
//   sku "IL-FAIL" -> PROVIDER_UNAVAILABLE (exercise degraded banners)
//   setUsage() lets the control panel push usage to trigger low-data alerts.

import { money } from '@kesher/domain';
import { EsimError, type EsimOrder, type EsimPackage, type EsimPort, type EsimUsage } from './esim.ts';

const CATALOGUE: EsimPackage[] = [
  { sku: 'IL-5GB-30D', country: 'IL', dataGb: 5, days: 30, cost: money(950n, 'USD') },
  { sku: 'IL-10GB-30D', country: 'IL', dataGb: 10, days: 30, cost: money(1600n, 'USD') },
  { sku: 'IL-20GB-30D', country: 'IL', dataGb: 20, days: 30, cost: money(2600n, 'USD') },
  { sku: 'IL-FAIL', country: 'IL', dataGb: 1, days: 7, cost: money(100n, 'USD') },
];

export class EsimSimulator implements EsimPort {
  private readonly orders = new Map<string, EsimOrder>();
  private readonly usage = new Map<string, EsimUsage>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date('2026-11-01T00:00:00Z')) {}

  async listPackages(country: string): Promise<EsimPackage[]> {
    return CATALOGUE.filter((p) => p.country === country);
  }

  async order(sku: string, idempotencyKey: string): Promise<EsimOrder> {
    const prior = this.orders.get(idempotencyKey);
    if (prior) return prior;
    const pkg = CATALOGUE.find((p) => p.sku === sku);
    if (!pkg) throw new EsimError('UNKNOWN_SKU', `Unknown SKU ${sku}`);
    if (sku === 'IL-FAIL') throw new EsimError('PROVIDER_UNAVAILABLE', 'Simulated outage');
    const n = ++this.seq;
    const iccid = `8997200000000${String(n).padStart(6, '0')}`;
    const lpa = `LPA:1$sim.kesher.example$ACT-${n}`;
    const order: EsimOrder = {
      orderId: `sim_order_${n}`,
      sku,
      iccid,
      lpa,
      installUrl: `https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(lpa)}`,
    };
    this.orders.set(idempotencyKey, order);
    const expires = new Date(this.now().getTime() + pkg.days * 86_400_000).toISOString();
    this.usage.set(iccid, { iccid, usedMb: 0, totalMb: pkg.dataGb * 1024, expiresAt: expires });
    return order;
  }

  async topUp(iccid: string, sku: string, idempotencyKey: string): Promise<EsimUsage> {
    const u = this.usage.get(iccid);
    if (!u) throw new EsimError('UNKNOWN_ICCID', `Unknown ICCID ${iccid}`);
    const pkg = CATALOGUE.find((p) => p.sku === sku);
    if (!pkg) throw new EsimError('UNKNOWN_SKU', `Unknown SKU ${sku}`);
    const key = `topup:${idempotencyKey}`;
    if (!this.orders.has(key)) {
      this.orders.set(key, { orderId: key, sku, iccid, lpa: '', installUrl: '' });
      u.totalMb += pkg.dataGb * 1024;
    }
    return { ...u };
  }

  async getUsage(iccid: string): Promise<EsimUsage> {
    const u = this.usage.get(iccid);
    if (!u) throw new EsimError('UNKNOWN_ICCID', `Unknown ICCID ${iccid}`);
    return { ...u };
  }

  /** Control-panel hook. */
  setUsage(iccid: string, usedMb: number): void {
    const u = this.usage.get(iccid);
    if (u) u.usedMb = usedMb;
  }
}
