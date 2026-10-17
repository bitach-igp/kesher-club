// StripeBillingAdapter: BillingPort on Stripe Billing (T-0301). Customers, SetupIntents for the
// Payment Element (wallet buttons are a client-side Payment Element option, mirrored back in
// PaymentSheet.wallets), subscriptions with a fixed term via `cancel_at`, pause/resume through
// `pause_collection`, and webhooks verified with the Stripe-Signature scheme and deduped by event id.
// Idempotency: Stripe's Idempotency-Key header plus a local IdempotencyStore (same key, same result).
// Vendor ids only leave this adapter as `customerId` / `subscriptionId` for ops.external_ref.
import { money, type Currency, type Money } from '@kesher/domain';
import { BillingError, type BillingCustomer, type BillingEvent, type BillingPort, type Clock, IdempotencyStore, type PaymentSheet, type Subscription, type SubscriptionStatus, type WalletButtons } from '@kesher/ports';
import { int, isRecord, isoToUnix, str, StripeApiError, StripeClient, StripeTransportError, unixToIso } from './client.ts';
import { DEFAULT_TOLERANCE_SECONDS, headerValue, STRIPE_SIGNATURE_HEADER, verifyStripeSignature } from './signature.ts';

export interface StripeBillingOptions {
  /** Restricted or secret API key (sk_test_… / rk_test_… in sandbox). Never logged. */
  secretKey: string;
  /** Signing secret of the billing webhook endpoint (whsec_…). Never logged. */
  webhookSecret: string;
  /** Our plan codes → Stripe product ids (prices are created inline from the locked plan price). */
  planProducts: Record<string, string>;
  baseUrl?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  webhookToleranceSeconds?: number;
}

const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(['usd', 'ils']);

export class StripeBillingAdapter implements BillingPort {
  private readonly client: StripeClient;
  private readonly clock: Clock;
  private readonly idem = new IdempotencyStore<unknown>();
  private readonly events = new Map<string, BillingEvent>();
  private readonly webhookSecret: string;
  private readonly tolerance: number;
  private readonly planProducts: Record<string, string>;

  constructor(opts: StripeBillingOptions) {
    if (!opts.secretKey || !opts.webhookSecret) throw new Error('StripeBillingAdapter: secretKey and webhookSecret are required');
    this.client = new StripeClient({ secretKey: opts.secretKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.apiVersion ? { apiVersion: opts.apiVersion } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    this.webhookSecret = opts.webhookSecret;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.tolerance = opts.webhookToleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.planProducts = { ...opts.planProducts };
  }

  async createCustomer(input: { partyId: string; email: string }, idempotencyKey: string): Promise<BillingCustomer> {
    return (await this.idem.run(idempotencyKey, async () => {
      const c = await this.call(() => this.client.post('/v1/customers', { email: input.email, metadata: { partyId: input.partyId } }, idempotencyKey));
      const customerId = str(c['id']);
      if (!customerId) throw unexpected('customer without id');
      return { customerId, email: str(c['email']) ?? input.email } satisfies BillingCustomer;
    })) as BillingCustomer;
  }

  async createSetupSheet(customerId: string, wallets: WalletButtons): Promise<PaymentSheet> {
    const si = await this.call(
      () =>
        this.client.post('/v1/setup_intents', {
          customer: customerId,
          usage: 'off_session',
          payment_method_types: ['card'],
          // The Payment Element reads these back to set `wallets: { applePay, googlePay }`.
          metadata: { applePay: wallets.applePay ? 'auto' : 'never', googlePay: wallets.googlePay ? 'auto' : 'never' },
        }),
      { missing: () => new BillingError('UNKNOWN_CUSTOMER', customerId) },
    );
    const clientSecret = str(si['client_secret']);
    if (!clientSecret) throw unexpected('setup intent without client_secret');
    return { clientSecret, wallets: { applePay: wallets.applePay, googlePay: wallets.googlePay } };
  }

  async createSubscription(input: { customerId: string; planCode: string; price: Money; termMonths: number }, idempotencyKey: string): Promise<Subscription> {
    const product = this.planProducts[input.planCode];
    if (!product) throw new BillingError('UNKNOWN_PLAN', input.planCode);
    if (input.price.minor <= 0n || !Number.isInteger(input.termMonths) || input.termMonths <= 0) throw new BillingError('INVALID_STATE', 'Price and term must be positive');
    return (await this.idem.run(idempotencyKey, async () => {
      const start = this.clock.now();
      const termEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + input.termMonths, start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()));
      const termEndsAt = isoToUnix(termEnd);
      const s = await this.call(
        () =>
          this.client.post(
            '/v1/subscriptions',
            {
              customer: input.customerId,
              items: [{ price_data: { currency: input.price.currency.toLowerCase(), product, unit_amount: input.price.minor, recurring: { interval: 'month' } } }],
              cancel_at: termEndsAt,
              payment_behavior: 'error_if_incomplete',
              metadata: { planCode: input.planCode, termMonths: String(input.termMonths), termEndsAt: termEndsAt.toString() },
            },
            idempotencyKey,
          ),
        { missing: () => new BillingError('UNKNOWN_CUSTOMER', input.customerId) },
      );
      return mapSubscription(s);
    })) as Subscription;
  }

  async pause(subscriptionId: string, idempotencyKey: string): Promise<Subscription> {
    return (await this.idem.run(idempotencyKey, async () => {
      const current = await this.get(subscriptionId);
      if (current.status !== 'active' && current.status !== 'past_due') throw new BillingError('INVALID_STATE', `Cannot pause a ${current.status} subscription`);
      const s = await this.call(() => this.client.post(`/v1/subscriptions/${enc(subscriptionId)}`, { pause_collection: { behavior: 'void' } }, idempotencyKey), this.subMissing(subscriptionId));
      return mapSubscription(s);
    })) as Subscription;
  }

  async resume(subscriptionId: string, idempotencyKey: string): Promise<Subscription> {
    return (await this.idem.run(idempotencyKey, async () => {
      const current = await this.get(subscriptionId);
      if (current.status !== 'paused') throw new BillingError('INVALID_STATE', `Cannot resume a ${current.status} subscription`);
      // An empty string unsets `pause_collection` (Stripe's convention for clearing a hash).
      const s = await this.call(() => this.client.post(`/v1/subscriptions/${enc(subscriptionId)}`, { pause_collection: '' }, idempotencyKey), this.subMissing(subscriptionId));
      return mapSubscription(s);
    })) as Subscription;
  }

  async cancel(subscriptionId: string, at: 'now' | 'period_end', idempotencyKey: string): Promise<Subscription> {
    return (await this.idem.run(idempotencyKey, async () => {
      const current = await this.get(subscriptionId);
      if (current.status === 'cancelled') throw new BillingError('INVALID_STATE', 'Already cancelled');
      const s =
        at === 'now'
          ? await this.call(() => this.client.delete(`/v1/subscriptions/${enc(subscriptionId)}`, idempotencyKey), this.subMissing(subscriptionId))
          : await this.call(() => this.client.post(`/v1/subscriptions/${enc(subscriptionId)}`, { cancel_at_period_end: true }, idempotencyKey), this.subMissing(subscriptionId));
      return mapSubscription(s);
    })) as Subscription;
  }

  async get(subscriptionId: string): Promise<Subscription> {
    const s = await this.call(() => this.client.get(`/v1/subscriptions/${enc(subscriptionId)}`), this.subMissing(subscriptionId));
    return mapSubscription(s);
  }

  async parseWebhook(headers: Record<string, string>, rawBody: string): Promise<BillingEvent> {
    const failure = verifyStripeSignature({
      header: headerValue(headers, STRIPE_SIGNATURE_HEADER),
      rawBody,
      secret: this.webhookSecret,
      nowSeconds: Math.floor(this.clock.now().getTime() / 1000),
      toleranceSeconds: this.tolerance,
    });
    if (failure) throw new BillingError('BAD_SIGNATURE', `Webhook signature invalid (${failure})`);
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new BillingError('BAD_SIGNATURE', 'Webhook body is not JSON');
    }
    if (!isRecord(event) || !isRecord(event['data']) || !isRecord(event['data']['object'])) throw unexpected('webhook event shape');
    const eventId = str(event['id']);
    const type = str(event['type']);
    if (!eventId || !type) throw unexpected('webhook event without id/type');
    const prior = this.events.get(eventId);
    if (prior) return prior;
    const object = event['data']['object'];
    const mapped = this.mapEvent(eventId, type, object);
    this.events.set(eventId, mapped);
    return mapped;
  }

  private mapEvent(eventId: string, type: string, object: Record<string, unknown>): BillingEvent {
    switch (type) {
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const amount = int(object['amount_paid']);
        const currency = toCurrency(object['currency']);
        if (amount === undefined || !currency) throw unexpected('invoice without amount_paid/currency');
        return { eventId, type: 'invoice.paid', subscriptionId: invoiceSubscription(object), amount: money(amount, currency) };
      }
      case 'invoice.payment_failed': {
        const attempt = int(object['attempt_count']);
        return { eventId, type: 'invoice.payment_failed', subscriptionId: invoiceSubscription(object), attempt: attempt === undefined ? 1 : Number(attempt) };
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
      case 'customer.subscription.created':
        return { eventId, type: 'subscription.updated', subscription: mapSubscription(object) };
      default:
        // Fail secure: an event type this adapter does not understand is refused, not swallowed.
        throw new BillingError('INVALID_STATE', `Unhandled Stripe event type ${type}`);
    }
  }

  private subMissing(id: string) {
    return { missing: () => new BillingError('UNKNOWN_SUBSCRIPTION', id) };
  }

  /** Runs one vendor call and maps vendor failures to BillingError. Never retries. */
  private async call(fn: () => Promise<Record<string, unknown>>, map: { missing?: () => BillingError } = {}): Promise<Record<string, unknown>> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BillingError) throw e;
      if (e instanceof StripeTransportError) throw new BillingError('PROVIDER_UNAVAILABLE', e.message);
      if (e instanceof StripeApiError) {
        if (e.isOutage) throw new BillingError('PROVIDER_UNAVAILABLE', `Stripe ${e.status} ${e.type}`);
        if (e.isMissing && map.missing) throw map.missing();
        if (e.type === 'card_error') throw new BillingError('CARD_DECLINED', e.declineCode ?? e.code ?? 'card_declined');
        if (e.code === 'idempotency_key_in_use' || e.type === 'idempotency_error') throw new BillingError('INVALID_STATE', 'Idempotency key reused with different parameters');
        throw new BillingError('INVALID_STATE', `Stripe refused the request (${e.code ?? e.type})`);
      }
      throw new BillingError('PROVIDER_UNAVAILABLE', 'Unexpected failure talking to Stripe');
    }
  }
}

const enc = (id: string): string => encodeURIComponent(id);
const unexpected = (what: string): BillingError => new BillingError('PROVIDER_UNAVAILABLE', `Unexpected Stripe response: ${what}`);

function toCurrency(v: unknown): Currency | undefined {
  const c = str(v)?.toLowerCase();
  return c && SUPPORTED_CURRENCIES.has(c) ? (c.toUpperCase() as Currency) : undefined;
}

function invoiceSubscription(invoice: Record<string, unknown>): string {
  // Pre-2025 API versions: `subscription`; 2025-03-31+: `parent.subscription_details.subscription`.
  const direct = str(invoice['subscription']) ?? (isRecord(invoice['subscription']) ? str(invoice['subscription']['id']) : undefined);
  if (direct) return direct;
  const parent = invoice['parent'];
  if (isRecord(parent) && isRecord(parent['subscription_details'])) {
    const s = parent['subscription_details']['subscription'];
    const id = str(s) ?? (isRecord(s) ? str(s['id']) : undefined);
    if (id) return id;
  }
  throw unexpected('invoice without subscription');
}

function mapStatus(s: Record<string, unknown>): SubscriptionStatus {
  if (isRecord(s['pause_collection'])) return 'paused';
  switch (str(s['status'])) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'canceled':
      return 'cancelled';
    case 'incomplete':
    case 'incomplete_expired':
      return 'incomplete';
    default:
      throw unexpected(`subscription status ${String(s['status'])}`);
  }
}

/** Maps a Stripe subscription object to the port's Subscription. Unknown shapes fail secure. */
export function mapSubscription(s: Record<string, unknown>): Subscription {
  const subscriptionId = str(s['id']);
  const customerId = str(s['customer']) ?? (isRecord(s['customer']) ? str(s['customer']['id']) : undefined);
  if (!subscriptionId || !customerId) throw unexpected('subscription without id/customer');
  const items = isRecord(s['items']) && Array.isArray(s['items']['data']) ? (s['items']['data'] as unknown[]) : [];
  const item = items.find(isRecord);
  const priceObj = item && isRecord(item['price']) ? item['price'] : undefined;
  const unitAmount = priceObj ? int(priceObj['unit_amount']) : undefined;
  const currency = priceObj ? toCurrency(priceObj['currency']) : undefined;
  if (unitAmount === undefined || !currency) throw unexpected('subscription item without unit_amount/currency');
  const metadata = isRecord(s['metadata']) ? s['metadata'] : {};
  const planCode = str(metadata['planCode']) ?? (priceObj ? str(priceObj['product']) : undefined);
  if (!planCode) throw unexpected('subscription without planCode');
  const periodEnd = int(s['current_period_end']) ?? (item ? int(item['current_period_end']) : undefined);
  if (periodEnd === undefined) throw unexpected('subscription without current_period_end');
  const termEndsAt = int(metadata['termEndsAt']);
  const cancelAtUnix = int(s['cancel_at']);
  const startDate = int(s['start_date']) ?? int(s['created']);
  let termMonths: number | undefined = int(metadata['termMonths']) !== undefined ? Number(int(metadata['termMonths'])) : undefined;
  if (termMonths === undefined && startDate !== undefined && (termEndsAt ?? cancelAtUnix) !== undefined) {
    const a = new Date(Number(startDate) * 1000);
    const b = new Date(Number(termEndsAt ?? cancelAtUnix) * 1000);
    termMonths = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  }
  if (termMonths === undefined || termMonths < 0) throw unexpected('subscription without a term');
  const status = mapStatus(s);
  const currentPeriodEnd = unixToIso(periodEnd);
  let cancelAt: string | undefined;
  if (status === 'cancelled') cancelAt = int(s['canceled_at']) !== undefined ? unixToIso(int(s['canceled_at'])!) : undefined;
  else if (s['cancel_at_period_end'] === true) cancelAt = currentPeriodEnd;
  else if (cancelAtUnix !== undefined && cancelAtUnix !== termEndsAt) cancelAt = unixToIso(cancelAtUnix);
  return {
    subscriptionId,
    customerId,
    planCode,
    status,
    price: money(unitAmount, currency),
    termMonths,
    currentPeriodEnd,
    ...(cancelAt ? { cancelAt } : {}),
  };
}
