// StripeFundingAdapter: FundingPort on Stripe PaymentIntents (T-0301, REQ-WAL-002/003). Card,
// Apple Pay and Google Pay are `card` payment methods (the wallet shows up as card.wallet.type);
// ACH is `us_bank_account` and lands `on_hold` for 3 business days; RTP is not offered by Stripe
// and is refused with UNSUPPORTED_METHOD. Idempotency: Stripe's Idempotency-Key plus a local
// IdempotencyStore. Webhooks: Stripe-Signature verified, deduped by event id, amount cross-checked
// against the load this adapter created when it knows it. Refunds (REQ-WAL-005) are Stripe Refunds
// against the PaymentIntent; a refund Stripe refuses comes back `failed` with its failure_reason.
import { money, type Currency, type Money } from '@kesher/domain';
import { addBusinessDays, type Clock, FundingError, type FundingMethod, type FundingPort, IdempotencyStore, type Load, type LoadStatus, type Refund, type RefundStatus } from '@kesher/ports';
import { int, isRecord, str, StripeApiError, StripeClient, StripeTransportError } from './client.ts';
import { DEFAULT_TOLERANCE_SECONDS, headerValue, STRIPE_SIGNATURE_HEADER, verifyStripeSignature } from './signature.ts';

export interface StripeFundingOptions {
  /** Restricted or secret API key. Never logged. */
  secretKey: string;
  /** Signing secret of the funding webhook endpoint. Never logged. */
  webhookSecret: string;
  baseUrl?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  achHoldBusinessDays?: number;
  webhookToleranceSeconds?: number;
}

const ACH_HOLD_BUSINESS_DAYS = 3;
const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(['usd', 'ils']);
const METHODS: ReadonlySet<string> = new Set(['card', 'apple_pay', 'google_pay', 'ach', 'rtp']);

export class StripeFundingAdapter implements FundingPort {
  private readonly client: StripeClient;
  private readonly clock: Clock;
  private readonly idem = new IdempotencyStore<Load>();
  private readonly refundIdem = new IdempotencyStore<Refund>();
  private readonly events = new Map<string, { eventId: string; load: Load }>();
  /** Loads created by this instance, for the webhook amount cross-check. Holds no PII. */
  private readonly known = new Map<string, { amount: Money; method: FundingMethod; holdUntil?: string }>();
  private readonly webhookSecret: string;
  private readonly tolerance: number;
  private readonly achHoldDays: number;

  constructor(opts: StripeFundingOptions) {
    if (!opts.secretKey || !opts.webhookSecret) throw new Error('StripeFundingAdapter: secretKey and webhookSecret are required');
    this.client = new StripeClient({ secretKey: opts.secretKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.apiVersion ? { apiVersion: opts.apiVersion } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    this.webhookSecret = opts.webhookSecret;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.tolerance = opts.webhookToleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.achHoldDays = opts.achHoldBusinessDays ?? ACH_HOLD_BUSINESS_DAYS;
  }

  async createLoad(input: { customerId: string; method: FundingMethod; amount: Money; paymentMethodId?: string }, idempotencyKey: string): Promise<Load> {
    if (input.amount.minor <= 0n) throw new FundingError('VALIDATION_FAILED', 'Amount must be positive');
    if (input.method === 'rtp') throw new FundingError('UNSUPPORTED_METHOD', 'RTP is not available through Stripe');
    if (!METHODS.has(input.method)) throw new FundingError('UNSUPPORTED_METHOD', String(input.method));
    if (!input.paymentMethodId) throw new FundingError('VALIDATION_FAILED', 'paymentMethodId is required');
    return this.idem.run(idempotencyKey, async () => {
      const holdUntil = input.method === 'ach' ? addBusinessDays(this.clock.now(), this.achHoldDays).toISOString() : undefined;
      const pi = await this.call(() =>
        this.client.post(
          '/v1/payment_intents',
          {
            amount: input.amount.minor,
            currency: input.amount.currency.toLowerCase(),
            customer: input.customerId,
            payment_method: input.paymentMethodId,
            payment_method_types: [input.method === 'ach' ? 'us_bank_account' : 'card'],
            confirm: true,
            off_session: true,
            metadata: { method: input.method, loadKey: idempotencyKey, ...(holdUntil ? { holdUntil } : {}) },
          },
          idempotencyKey,
        ),
      );
      const load = mapPaymentIntent(pi, { method: input.method, ...(holdUntil ? { holdUntil } : {}) });
      this.known.set(load.loadId, { amount: load.amount, method: load.method, ...(holdUntil ? { holdUntil } : {}) });
      return load;
    });
  }

  async getLoad(loadId: string): Promise<Load> {
    const pi = await this.call(() => this.client.get(`/v1/payment_intents/${encodeURIComponent(loadId)}`), { missing: () => new FundingError('UNKNOWN_LOAD', loadId) });
    return mapPaymentIntent(pi, this.known.get(loadId));
  }

  async refund(input: { loadId: string; amount: Money }, idempotencyKey: string): Promise<Refund> {
    if (input.amount.minor <= 0n) throw new FundingError('VALIDATION_FAILED', 'Refund amount must be positive');
    return this.refundIdem.run(idempotencyKey, async () => {
      const r = await this.call(() => this.client.post('/v1/refunds', { payment_intent: input.loadId, amount: input.amount.minor, metadata: { refundKey: idempotencyKey } }, idempotencyKey), {
        missing: () => new FundingError('UNKNOWN_LOAD', input.loadId),
      });
      return mapRefund(r, input.loadId);
    });
  }

  async getRefund(refundId: string): Promise<Refund> {
    const r = await this.call(() => this.client.get(`/v1/refunds/${encodeURIComponent(refundId)}`), { missing: () => new FundingError('UNKNOWN_REFUND', refundId) });
    return mapRefund(r);
  }

  async parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; load: Load }> {
    const failure = verifyStripeSignature({
      header: headerValue(headers, STRIPE_SIGNATURE_HEADER),
      rawBody,
      secret: this.webhookSecret,
      nowSeconds: Math.floor(this.clock.now().getTime() / 1000),
      toleranceSeconds: this.tolerance,
    });
    if (failure) throw new FundingError('BAD_SIGNATURE', `Webhook signature invalid (${failure})`);
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new FundingError('BAD_SIGNATURE', 'Webhook body is not JSON');
    }
    if (!isRecord(event) || !isRecord(event['data']) || !isRecord(event['data']['object'])) throw unexpected('webhook event shape');
    const eventId = str(event['id']);
    const type = str(event['type']);
    if (!eventId || !type) throw unexpected('webhook event without id/type');
    const prior = this.events.get(eventId);
    if (prior) return prior;
    if (!type.startsWith('payment_intent.')) throw new FundingError('VALIDATION_FAILED', `Unhandled Stripe event type ${type}`);
    const object = event['data']['object'];
    const knownId = str(object['id']);
    const known = knownId ? this.known.get(knownId) : undefined;
    const load = mapPaymentIntent(object, known);
    if (known && (known.amount.minor !== load.amount.minor || known.amount.currency !== load.amount.currency)) throw new FundingError('VALIDATION_FAILED', 'Webhook amount differs from the load');
    const out = { eventId, load };
    this.events.set(eventId, out);
    return out;
  }

  /** Runs one vendor call and maps vendor failures to FundingError. Never retries. */
  private async call(fn: () => Promise<Record<string, unknown>>, map: { missing?: () => FundingError } = {}): Promise<Record<string, unknown>> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FundingError) throw e;
      if (e instanceof StripeTransportError) throw new FundingError('PROVIDER_UNAVAILABLE', e.message);
      if (e instanceof StripeApiError) {
        if (e.isOutage) throw new FundingError('PROVIDER_UNAVAILABLE', `Stripe ${e.status} ${e.type}`);
        if (e.isMissing && map.missing) throw map.missing();
        if (e.type === 'card_error') throw new FundingError('DECLINED', e.declineCode ?? e.code ?? 'declined');
        throw new FundingError('VALIDATION_FAILED', `Stripe refused the request (${e.code ?? e.type})`);
      }
      throw new FundingError('PROVIDER_UNAVAILABLE', 'Unexpected failure talking to Stripe');
    }
  }
}

const unexpected = (what: string): FundingError => new FundingError('PROVIDER_UNAVAILABLE', `Unexpected Stripe response: ${what}`);

function toCurrency(v: unknown): Currency | undefined {
  const c = str(v)?.toLowerCase();
  return c && SUPPORTED_CURRENCIES.has(c) ? (c.toUpperCase() as Currency) : undefined;
}

function methodOf(pi: Record<string, unknown>, hint: FundingMethod | undefined): FundingMethod {
  const metadata = isRecord(pi['metadata']) ? pi['metadata'] : {};
  const m = str(metadata['method']) ?? hint;
  if (m && METHODS.has(m)) return m as FundingMethod;
  // No metadata (a PaymentIntent not created by us): infer from payment_method_types.
  const types = Array.isArray(pi['payment_method_types']) ? (pi['payment_method_types'] as unknown[]) : [];
  if (types.includes('us_bank_account')) return 'ach';
  if (types.includes('card')) return 'card';
  throw unexpected('payment intent without a recognisable method');
}

/** Maps a Stripe Refund to the port's Refund. Unknown statuses fail secure. */
export function mapRefund(r: Record<string, unknown>, loadHint?: string): Refund {
  const refundId = str(r['id']);
  const amount = int(r['amount']);
  const currency = toCurrency(r['currency']);
  const loadId = str(r['payment_intent']) ?? loadHint;
  if (!refundId || amount === undefined || !currency || !loadId) throw unexpected('refund without id/amount/currency/payment_intent');
  const vendorStatus = str(r['status']);
  let status: RefundStatus;
  switch (vendorStatus) {
    case 'succeeded':
      status = 'succeeded';
      break;
    case 'pending':
    case 'requires_action':
      status = 'pending';
      break;
    case 'failed':
    case 'canceled':
      status = 'failed';
      break;
    default:
      throw unexpected(`refund status ${String(vendorStatus)}`);
  }
  const failureCode = status === 'failed' ? (str(r['failure_reason']) ?? 'refund_failed') : undefined;
  return { refundId, loadId, amount: money(amount, currency), status, ...(failureCode ? { failureCode } : {}) };
}

/** Maps a Stripe PaymentIntent to the port's Load. Unknown statuses fail secure. */
export function mapPaymentIntent(pi: Record<string, unknown>, known?: { method: FundingMethod; holdUntil?: string }): Load {
  const loadId = str(pi['id']);
  const amount = int(pi['amount']);
  const currency = toCurrency(pi['currency']);
  if (!loadId || amount === undefined || !currency) throw unexpected('payment intent without id/amount/currency');
  const method = methodOf(pi, known?.method);
  const metadata = isRecord(pi['metadata']) ? pi['metadata'] : {};
  const holdUntil = method === 'ach' ? (str(metadata['holdUntil']) ?? known?.holdUntil) : undefined;
  const vendorStatus = str(pi['status']);
  let status: LoadStatus;
  switch (vendorStatus) {
    case 'succeeded':
      status = 'succeeded';
      break;
    case 'processing':
      status = method === 'ach' ? 'on_hold' : 'processing';
      break;
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
    case 'requires_capture':
      status = 'requires_action';
      break;
    case 'canceled':
      status = 'failed';
      break;
    default:
      throw unexpected(`payment intent status ${String(vendorStatus)}`);
  }
  const lastError = isRecord(pi['last_payment_error']) ? pi['last_payment_error'] : undefined;
  const failureCode = lastError ? (str(lastError['decline_code']) ?? str(lastError['code'])) : undefined;
  const clientSecret = status === 'requires_action' ? str(pi['client_secret']) : undefined;
  return {
    loadId,
    method,
    amount: money(amount, currency),
    status,
    ...(holdUntil && status !== 'failed' ? { holdUntil } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(failureCode ? { failureCode } : {}),
  };
}
