// AiraloEsimAdapter: EsimPort on the Airalo Partner API v2 (T-0710, REQ-ESIM-001).
//   GET  /v2/packages?filter[type]=local&filter[country]=IL   -> EsimPackage[] (cost: USD minor units)
//   POST /v2/orders   (package_id, quantity=1, type=sim)      -> EsimOrder (LPA + iOS 17.4 universal link)
//   GET  /v2/sims/{iccid}/usage                                -> EsimUsage (MB)
//   POST /v2/orders/topups (package_id, iccid)                -> then usage
// Airalo has no idempotency header, so mutating calls are guarded by a local IdempotencyStore keyed
// by the workflow's key (also sent as the order `description` for reconciliation). No retries here.
import type { Currency } from '@kesher/domain';
import { type Clock, EsimError, type EsimOrder, type EsimPackage, type EsimPort, type EsimUsage, IdempotencyStore } from '@kesher/ports';
import { AiraloApiError, AiraloClient, AiraloTransportError, isRecord, num, str } from './client.ts';
import { decimalToMinor } from './money.ts';

export interface AiraloEsimOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Airalo bills partners in USD; override only if the contract says otherwise. */
  currency?: Currency;
}

const MB_PER_GB = 1024;

/** iOS 17.4+ one-tap install (REQ-ESIM-001); Android reads the QR derived from the same LPA string. */
export const appleInstallUrl = (lpa: string): string => `https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(lpa)}`;

export class AiraloEsimAdapter implements EsimPort {
  private readonly client: AiraloClient;
  private readonly currency: Currency;
  private readonly orders = new IdempotencyStore<EsimOrder>();
  private readonly topUps = new IdempotencyStore<EsimUsage>();

  constructor(opts: AiraloEsimOptions) {
    this.client = new AiraloClient({ clientId: opts.clientId, clientSecret: opts.clientSecret, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.clock ? { clock: opts.clock } : {}) });
    this.currency = opts.currency ?? 'USD';
  }

  async listPackages(country: string): Promise<EsimPackage[]> {
    const body = await this.call(() => this.client.get('/v2/packages', { 'filter[type]': 'local', 'filter[country]': country, limit: '100' }));
    const out: EsimPackage[] = [];
    for (const entry of listOf(body['data'])) {
      const countryCode = str(entry['country_code']) ?? country;
      if (countryCode.toUpperCase() !== country.toUpperCase()) continue;
      for (const operator of listOf(entry['operators'])) {
        for (const pkg of listOf(operator['packages'])) {
          const mapped = this.mapPackage(pkg, countryCode.toUpperCase());
          if (mapped) out.push(mapped);
        }
      }
    }
    return out;
  }

  async order(sku: string, idempotencyKey: string): Promise<EsimOrder> {
    return this.orders.run(idempotencyKey, async () => {
      const body = await this.call(() => this.client.post('/v2/orders', { package_id: sku, quantity: '1', type: 'sim', description: idempotencyKey }), {
        unknownSku: sku,
      });
      const data = isRecord(body['data']) ? body['data'] : undefined;
      const sim = data ? listOf(data['sims'])[0] : undefined;
      const orderId = data ? idString(data['id']) : undefined;
      const iccid = sim ? str(sim['iccid']) : undefined;
      if (!data || !orderId || !sim || !iccid) throw unexpected('order without id/sims/iccid');
      const lpa = lpaOf(sim);
      return { orderId, sku: str(data['package_id']) ?? sku, iccid, lpa, installUrl: appleInstallUrl(lpa) };
    });
  }

  async topUp(iccid: string, sku: string, idempotencyKey: string): Promise<EsimUsage> {
    return this.topUps.run(idempotencyKey, async () => {
      await this.call(() => this.client.post('/v2/orders/topups', { package_id: sku, iccid, description: idempotencyKey }), { unknownSku: sku, unknownIccid: iccid });
      return this.getUsage(iccid);
    });
  }

  async getUsage(iccid: string): Promise<EsimUsage> {
    const body = await this.call(() => this.client.get(`/v2/sims/${encodeURIComponent(iccid)}/usage`), { unknownIccid: iccid });
    const data = isRecord(body['data']) ? body['data'] : undefined;
    const total = data ? num(data['total']) : undefined;
    const remaining = data ? num(data['remaining']) : undefined;
    const expiresAt = data ? toIso(data['expired_at']) : undefined;
    if (total === undefined || remaining === undefined || !expiresAt) throw unexpected('usage without total/remaining/expired_at');
    return { iccid, usedMb: Math.max(0, total - remaining), totalMb: total, expiresAt };
  }

  private mapPackage(pkg: Record<string, unknown>, country: string): EsimPackage | undefined {
    const sku = str(pkg['id']);
    const amountMb = num(pkg['amount']);
    const days = num(pkg['day']);
    if (!sku || pkg['is_unlimited'] === true || amountMb === undefined || amountMb <= 0 || days === undefined || days <= 0) return undefined;
    let cost;
    try {
      cost = decimalToMinor(pkg['price'], this.currency);
    } catch {
      throw unexpected(`package ${sku} price`);
    }
    return { sku, country, dataGb: amountMb / MB_PER_GB, days, cost };
  }

  /** Runs one vendor call and maps vendor failures to EsimError. Never retries. */
  private async call(fn: () => Promise<Record<string, unknown>>, map: { unknownSku?: string; unknownIccid?: string } = {}): Promise<Record<string, unknown>> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof EsimError) throw e;
      if (e instanceof AiraloTransportError) throw new EsimError('PROVIDER_UNAVAILABLE', e.message);
      if (e instanceof AiraloApiError) {
        if (e.isOutage) throw new EsimError('PROVIDER_UNAVAILABLE', `Airalo ${e.status}`);
        if (map.unknownSku && e.hasFieldError('package_id')) throw new EsimError('UNKNOWN_SKU', `Unknown SKU ${map.unknownSku}`);
        if (map.unknownIccid && (e.status === 404 || e.hasFieldError('iccid'))) throw new EsimError('UNKNOWN_ICCID', `Unknown ICCID ${map.unknownIccid}`);
        if (map.unknownSku && e.status === 404) throw new EsimError('UNKNOWN_SKU', `Unknown SKU ${map.unknownSku}`);
        // 401/403/422 we did not anticipate: refuse rather than guess (constitution art. 6).
        throw new EsimError('PROVIDER_UNAVAILABLE', `Airalo refused the request (${e.status})`);
      }
      throw new EsimError('PROVIDER_UNAVAILABLE', 'Unexpected failure talking to Airalo');
    }
  }
}

const unexpected = (what: string): EsimError => new EsimError('PROVIDER_UNAVAILABLE', `Unexpected Airalo response: ${what}`);
const listOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const idString = (v: unknown): string | undefined => (typeof v === 'number' && Number.isInteger(v) ? String(v) : str(v));

/** The LPA activation string: Airalo's `qrcode` holds it; otherwise it is `LPA:1$<smdp>$<matching_id>`. */
function lpaOf(sim: Record<string, unknown>): string {
  const qr = str(sim['qrcode']);
  if (qr && qr.startsWith('LPA:1$')) return qr;
  const smdp = str(sim['lpa']);
  const matchingId = str(sim['matching_id']);
  if (smdp && matchingId) return `LPA:1$${smdp}$${matchingId}`;
  throw unexpected('sim without an LPA activation code');
}

/** Airalo timestamps are "YYYY-MM-DD HH:mm:ss" in UTC; ISO strings pass through. */
function toIso(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(normalised);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
