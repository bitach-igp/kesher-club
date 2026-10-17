// CoverGeniusInsuranceAdapter: InsurancePort on the XCover Partner API (T-0720, REQ-INSR-001).
//   POST /quotes/                 one policy type per quote -> InsuranceQuote (disclosures attached)
//   POST /bookings/{quoteId}/     confirm (bind) the quote package -> Policy
//   POST /bookings/{id}/cancel/   cancel -> Policy (cancelled)
//   GET  /bookings/{id}/          read -> Policy
// XCover's quote package id becomes our quoteId and, once confirmed, the policyId (same string).
// Disclosures: licensed entity and commission wording are fixed (constructor, approved by compliance);
// the policy wording URL is the quote's `pds_url` from the vendor. A quote without it is refused, so
// no checkout screen can ever show a quote without the three disclosures.
import { applyBps, type Currency, type Money } from '@kesher/domain';
import { addMs, type Clock, IdempotencyStore, InsuranceError, type InsurancePort, type InsuranceQuote, type Policy } from '@kesher/ports';
import { isRecord, str, XCoverApiError, XCoverClient, XCoverTransportError } from './client.ts';
import { decimalToMinor } from './money.ts';

export interface CoverGeniusProduct {
  /** XCover policy type, e.g. "travel_il_v1" / "gadget_protection". */
  policyType: string;
  policyTypeVersion?: number;
  /** Our commission share of the premium, used when the quote does not state `partner_commission`. */
  commissionBps: bigint;
}

export interface CoverGeniusInsuranceOptions {
  partnerCode: string;
  apiKey: string;
  apiSecret: string;
  /** Our product codes → XCover policy types. Unknown codes are refused before any vendor call. */
  products: Record<string, CoverGeniusProduct>;
  /** Fixed, compliance-approved wording. The policy wording URL always comes from the quote. */
  disclosures: { licensedEntity: string; commissionDisclosure: string };
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Quote currency requested from XCover. */
  currency?: Currency;
  /** How long a quote stays bindable when XCover does not say (its own expiry wins). */
  quoteTtlMs?: number;
}

const DEFAULT_QUOTE_TTL_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const SUPPORTED: ReadonlySet<string> = new Set(['USD', 'ILS']);

export class CoverGeniusInsuranceAdapter implements InsurancePort {
  private readonly client: XCoverClient;
  private readonly clock: Clock;
  private readonly products: Record<string, CoverGeniusProduct>;
  private readonly disclosures: { licensedEntity: string; commissionDisclosure: string };
  private readonly currency: Currency;
  private readonly quoteTtlMs: number;
  private readonly binds = new IdempotencyStore<Policy>();
  private readonly cancels = new IdempotencyStore<Policy>();
  /** Quotes this instance issued: product code, member and expiry, for bind-time checks. No PII. */
  private readonly quotes = new Map<string, { product: string; memberId: string; expiresAt: string }>();

  constructor(opts: CoverGeniusInsuranceOptions) {
    if (!opts.disclosures.licensedEntity.trim()) throw new Error('CoverGeniusInsuranceAdapter: disclosures.licensedEntity is required');
    if (!/commission/i.test(opts.disclosures.commissionDisclosure)) throw new Error('CoverGeniusInsuranceAdapter: disclosures.commissionDisclosure must disclose the commission');
    this.client = new XCoverClient({ partnerCode: opts.partnerCode, apiKey: opts.apiKey, apiSecret: opts.apiSecret, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.clock ? { clock: opts.clock } : {}) });
    this.clock = opts.clock ?? { now: () => new Date() };
    this.products = { ...opts.products };
    this.disclosures = { ...opts.disclosures };
    this.currency = opts.currency ?? 'USD';
    this.quoteTtlMs = opts.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  }

  async quote(input: { product: string; memberId: string; market: 'US' | 'IL'; startsAt: string; days: number }): Promise<InsuranceQuote> {
    const product = this.products[input.product];
    if (!product) throw new InsuranceError('UNKNOWN_PRODUCT', input.product);
    const start = new Date(input.startsAt);
    if (Number.isNaN(start.getTime()) || !Number.isInteger(input.days) || input.days <= 0) throw new InsuranceError('UNKNOWN_PRODUCT', 'Invalid cover period');
    const end = addMs(start, input.days * DAY_MS);
    const body = await this.call(
      () =>
        this.client.post('/quotes/', {
          request: [
            {
              policy_type: product.policyType,
              ...(product.policyTypeVersion !== undefined ? { policy_type_version: product.policyTypeVersion } : {}),
              policy_start_date: start.toISOString(),
              policy_end_date: end.toISOString(),
              // Least data (art. 9): our member id is the only identifier XCover gets at quote time.
              customer_external_id: input.memberId,
            },
          ],
          currency: this.currency,
          customer_country: input.market,
          customer_language: 'en',
        }),
      { badRequest: () => new InsuranceError('UNKNOWN_PRODUCT', `XCover refused policy type ${product.policyType}`) },
    );
    const quoteId = str(body['id']);
    const currency = str(body['currency']);
    const q = firstQuote(body);
    if (!quoteId || !currency || !q) throw unexpected('quote package without id/currency/quotes');
    if (!SUPPORTED.has(currency)) throw unexpected(`currency ${currency}`);
    const premium = toMoney(q['price'], currency as Currency, 'price');
    const stated = q['partner_commission'];
    const commission: Money = stated !== undefined && stated !== null ? toMoney(stated, currency as Currency, 'partner_commission') : applyBps(premium, product.commissionBps);
    if (commission.minor < 0n || commission.minor > premium.minor) throw unexpected('commission outside the premium');
    const pdsUrl = str(q['pds_url']) ?? (isRecord(q['content']) ? str(q['content']['pds_url']) : undefined);
    if (!pdsUrl || !/^https:\/\//.test(pdsUrl)) throw unexpected('quote without an https pds_url (policy wording)');
    const vendorExpiry = isoOf(body['expires_at'] ?? q['expires_at']);
    const expiresAt = vendorExpiry ?? addMs(this.clock.now(), this.quoteTtlMs).toISOString();
    const benefits = Array.isArray(q['benefits']) ? q['benefits'].filter(isRecord).map((b) => str(b['description'])).filter((d): d is string => !!d) : [];
    const coverageSummary = benefits.length > 0 ? benefits : [str(q['policy_name']) ?? product.policyType];
    this.quotes.set(quoteId, { product: input.product, memberId: input.memberId, expiresAt });
    return {
      quoteId,
      product: input.product,
      premium,
      commission,
      coverageSummary,
      disclosures: { licensedEntity: this.disclosures.licensedEntity, policyWordingUrl: pdsUrl, commissionDisclosure: this.disclosures.commissionDisclosure },
      expiresAt,
    };
  }

  async bind(quoteId: string, idempotencyKey: string): Promise<Policy> {
    return this.binds.run(idempotencyKey, async () => {
      const local = this.quotes.get(quoteId);
      if (local && this.clock.now().getTime() > Date.parse(local.expiresAt)) throw new InsuranceError('QUOTE_EXPIRED', 'Quote expired');
      const body = await this.call(() => this.client.post(`/bookings/${encodeURIComponent(quoteId)}/`, local ? { policyholder: { external_id: local.memberId } } : {}), {
        missing: () => new InsuranceError('UNKNOWN_QUOTE', quoteId),
        badRequest: (e) => (e.mentions(/expired/i) ? new InsuranceError('QUOTE_EXPIRED', 'Quote expired') : new InsuranceError('INVALID_STATE', e.message)),
      });
      return mapBooking(body, quoteId);
    });
  }

  async cancel(policyId: string, idempotencyKey: string): Promise<Policy> {
    return this.cancels.run(idempotencyKey, async () => {
      const body = await this.call(() => this.client.post(`/bookings/${encodeURIComponent(policyId)}/cancel/`, {}), {
        missing: () => new InsuranceError('UNKNOWN_POLICY', policyId),
        badRequest: (e) => new InsuranceError('INVALID_STATE', e.message),
      });
      const policy = mapBooking(body, policyId);
      if (policy.status !== 'cancelled') throw unexpected('cancel reply not CANCELLED');
      return policy;
    });
  }

  async getPolicy(policyId: string): Promise<Policy> {
    const body = await this.call(() => this.client.get(`/bookings/${encodeURIComponent(policyId)}/`), { missing: () => new InsuranceError('UNKNOWN_POLICY', policyId) });
    return mapBooking(body, policyId);
  }

  /** Runs one vendor call and maps vendor failures to InsuranceError. Never retries. */
  private async call(fn: () => Promise<Record<string, unknown>>, map: { missing?: () => InsuranceError; badRequest?: (e: XCoverApiError) => InsuranceError } = {}): Promise<Record<string, unknown>> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof InsuranceError) throw e;
      if (e instanceof XCoverTransportError) throw new InsuranceError('PROVIDER_UNAVAILABLE', e.message);
      if (e instanceof XCoverApiError) {
        if (e.isOutage) throw new InsuranceError('PROVIDER_UNAVAILABLE', `XCover ${e.status}`);
        if (e.status === 404 && map.missing) throw map.missing();
        if ((e.status === 400 || e.status === 409 || e.status === 422) && map.badRequest) throw map.badRequest(e);
        throw new InsuranceError('PROVIDER_UNAVAILABLE', `XCover refused the request (${e.status})`);
      }
      throw new InsuranceError('PROVIDER_UNAVAILABLE', 'Unexpected failure talking to XCover');
    }
  }
}

const unexpected = (what: string): InsuranceError => new InsuranceError('PROVIDER_UNAVAILABLE', `Unexpected XCover response: ${what}`);

function toMoney(v: unknown, currency: Currency, field: string): Money {
  try {
    return decimalToMinor(v, currency);
  } catch {
    throw unexpected(`${field} is not a 2-decimal amount`);
  }
}

function isoOf(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** XCover returns the quotes of a package as an object keyed by quote id (or a list). We request one. */
function firstQuote(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const quotes = body['quotes'];
  if (Array.isArray(quotes)) return quotes.find(isRecord);
  if (isRecord(quotes)) return Object.values(quotes).find(isRecord);
  return undefined;
}

/** Maps an XCover booking (confirmed quote package) to the port's Policy. Unknown statuses fail secure. */
export function mapBooking(body: Record<string, unknown>, fallbackId: string): Policy {
  const id = str(body['id']) ?? fallbackId;
  const q = firstQuote(body);
  if (!q) throw unexpected('booking without quotes');
  const vendorStatus = (str(body['status']) ?? str(q['status']) ?? '').toUpperCase();
  let status: Policy['status'];
  if (vendorStatus === 'CONFIRMED' || vendorStatus === 'ACTIVE') status = 'active';
  else if (vendorStatus === 'CANCELLED' || vendorStatus === 'CANCELED') status = 'cancelled';
  else throw unexpected(`booking status ${vendorStatus || '(none)'}`);
  const startsAt = isoOf(q['policy_start_date']);
  const endsAt = isoOf(q['policy_end_date']);
  const certificateUrl = str(body['pdf_url']) ?? str(q['certificate_url']) ?? str(q['pdf_url']);
  if (!startsAt || !endsAt) throw unexpected('booking without policy dates');
  if (!certificateUrl || !/^https:\/\//.test(certificateUrl)) throw unexpected('booking without an https certificate url');
  return { policyId: id, quoteId: id, status, startsAt, endsAt, certificateUrl };
}
