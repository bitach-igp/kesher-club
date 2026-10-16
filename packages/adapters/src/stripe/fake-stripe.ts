// In-memory fake of the handful of Stripe endpoints the adapters call. It speaks Stripe's wire shape
// (form-encoded requests, JSON objects with `object`, `error` envelopes, Idempotency-Key replay,
// Stripe-Signature webhooks) so the contract suites exercise the real request/response mapping.
// Deterministic fixtures (test only; never ship):
//   customer email ending "@declined.example" -> 402 card_error on subscription create
//   customer email ending "@outage.example"   -> 503 api_error on customer create
//   payment_method "pm_card_declined"         -> 402 card_error (generic_decline)
//   payment_method "pm_outage"                -> 503 api_error
//   payment_method "pm_card_3ds"              -> PaymentIntent requires_action
//   payment_method "pm_us_bank_ok"            -> PaymentIntent processing (ACH)
//   any other "pm_card_*" / "pm_us_bank_*"    -> succeeded / processing; unknown pm -> 400 resource_missing
// Control hooks: failInvoice(), payInvoice(), settlePaymentIntent() return signed webhooks.
import type { Clock } from '@kesher/ports';
import { signStripePayload } from './signature.ts';

export interface FakeStripeOptions {
  secretKey: string;
  webhookSecret: string;
  clock?: Clock;
}

type Json = Record<string, unknown>;
type Form = { [k: string]: string | Form | Form[] };
type Reply = { status: number; body: Json };

interface Sub {
  id: string;
  customer: string;
  status: 'active' | 'past_due' | 'canceled';
  unit_amount: bigint;
  currency: string;
  product: string;
  created: bigint;
  current_period_end: bigint;
  cancel_at: bigint | undefined;
  cancel_at_period_end: boolean;
  canceled_at: bigint | undefined;
  paused: boolean;
  metadata: Record<string, string>;
}

interface Pi {
  id: string;
  amount: bigint;
  currency: string;
  customer: string | undefined;
  payment_method: string;
  payment_method_types: string[];
  status: 'succeeded' | 'processing' | 'requires_action' | 'canceled';
  metadata: Record<string, string>;
  client_secret: string;
}

export class FakeStripe {
  readonly fetch: typeof fetch;
  readonly webhookSecret: string;
  /** Every request seen, without bodies or auth, so tests can assert call shapes. */
  readonly calls: { method: string; path: string; idempotencyKey: string | undefined; form: Form }[] = [];
  private readonly customers = new Map<string, { id: string; email: string; metadata: Record<string, string> }>();
  private readonly subs = new Map<string, Sub>();
  private readonly pis = new Map<string, Pi>();
  private readonly idem = new Map<string, { fingerprint: string; reply: Reply }>();
  private readonly clock: Clock;
  private readonly secretKey: string;
  private seq = 0;
  /** Per-call failure injection: the next N requests get a 503. */
  outageRequests = 0;

  constructor(opts: FakeStripeOptions) {
    this.secretKey = opts.secretKey;
    this.webhookSecret = opts.webhookSecret;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : '';
      const reply = this.handle(method, url, headers, body);
      return new Response(JSON.stringify(reply.body, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  // ---- control hooks (what the Stripe dashboard / clock would do) ----

  failInvoice(subscriptionId: string, attempt = 1): { headers: Record<string, string>; rawBody: string } {
    const s = this.mustSub(subscriptionId);
    s.status = 'past_due';
    return this.event('invoice.payment_failed', this.invoiceFor(s, 'open', attempt));
  }

  payInvoice(subscriptionId: string): { headers: Record<string, string>; rawBody: string } {
    const s = this.mustSub(subscriptionId);
    if (s.status === 'past_due') s.status = 'active';
    return this.event('invoice.paid', this.invoiceFor(s, 'paid', 1));
  }

  subscriptionUpdated(subscriptionId: string): { headers: Record<string, string>; rawBody: string } {
    return this.event('customer.subscription.updated', this.subJson(this.mustSub(subscriptionId)));
  }

  settlePaymentIntent(id: string, outcome: 'succeeded' | 'failed' = 'succeeded'): { headers: Record<string, string>; rawBody: string } {
    const pi = this.pis.get(id);
    if (!pi) throw new Error(`fake stripe: no payment intent ${id}`);
    pi.status = outcome === 'succeeded' ? 'succeeded' : 'canceled';
    return this.event(outcome === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed', this.piJson(pi));
  }

  /** Signs an arbitrary event body; `ageSeconds` back-dates the timestamp to test the tolerance window. */
  sign(rawBody: string, ageSeconds = 0): Record<string, string> {
    const t = Math.floor(this.clock.now().getTime() / 1000) - ageSeconds;
    return { 'stripe-signature': signStripePayload(this.webhookSecret, rawBody, t) };
  }

  // ---- request routing ----

  private handle(method: string, url: URL, headers: Headers, body: string): Reply {
    if (headers.get('authorization') !== `Bearer ${this.secretKey}`) return err(401, 'invalid_request_error', 'Invalid API Key provided', 'api_key_invalid');
    if (this.outageRequests > 0) {
      this.outageRequests -= 1;
      return err(503, 'api_error', 'Service unavailable');
    }
    const form = method === 'GET' ? decodeForm(url.searchParams.toString()) : decodeForm(body);
    const idempotencyKey = headers.get('idempotency-key') ?? undefined;
    this.calls.push({ method, path: url.pathname, idempotencyKey, form });
    const fingerprint = `${method} ${url.pathname} ${body}`;
    if (idempotencyKey) {
      const prior = this.idem.get(idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) return err(400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters');
        return prior.reply;
      }
    }
    const reply = this.route(method, url.pathname, form);
    if (idempotencyKey) this.idem.set(idempotencyKey, { fingerprint, reply });
    return reply;
  }

  private route(method: string, path: string, form: Form): Reply {
    const seg = path.split('/').filter(Boolean); // ['v1', 'subscriptions', 'sub_1']
    if (seg[0] !== 'v1') return err(404, 'invalid_request_error', `Unrecognized request URL (${method}: ${path})`);
    const [, resource, id] = seg;
    if (resource === 'customers' && method === 'POST' && !id) return this.createCustomer(form);
    if (resource === 'setup_intents' && method === 'POST' && !id) return this.createSetupIntent(form);
    if (resource === 'subscriptions' && method === 'POST' && !id) return this.createSubscription(form);
    if (resource === 'subscriptions' && id && method === 'GET') return this.withSub(id, (s) => ok(this.subJson(s)));
    if (resource === 'subscriptions' && id && method === 'POST') return this.withSub(id, (s) => this.updateSubscription(s, form));
    if (resource === 'subscriptions' && id && method === 'DELETE') return this.withSub(id, (s) => this.cancelNow(s));
    if (resource === 'payment_intents' && method === 'POST' && !id) return this.createPaymentIntent(form);
    if (resource === 'payment_intents' && id && method === 'GET') {
      const pi = this.pis.get(id);
      return pi ? ok(this.piJson(pi)) : missing('payment_intent', id);
    }
    return err(404, 'invalid_request_error', `Unrecognized request URL (${method}: ${path})`);
  }

  private createCustomer(form: Form): Reply {
    const email = s(form['email']);
    if (!email) return err(400, 'invalid_request_error', 'Missing required param: email', 'parameter_missing', 'email');
    if (email.endsWith('@outage.example')) return err(503, 'api_error', 'Service unavailable');
    const c = { id: this.id('cus'), email, metadata: stringMap(form['metadata']) };
    this.customers.set(c.id, c);
    return ok({ id: c.id, object: 'customer', email: c.email, metadata: c.metadata, created: this.now() });
  }

  private createSetupIntent(form: Form): Reply {
    const customer = s(form['customer']);
    if (customer && !this.customers.has(customer)) return missing('customer', customer, 'customer');
    const id = this.id('seti');
    return ok({
      id,
      object: 'setup_intent',
      customer: customer ?? null,
      status: 'requires_payment_method',
      usage: s(form['usage']) ?? 'off_session',
      payment_method_types: Array.isArray(form['payment_method_types']) ? form['payment_method_types'] : ['card'],
      client_secret: `${id}_secret_${this.id('x')}`,
      metadata: stringMap(form['metadata']),
      created: this.now(),
    });
  }

  private createSubscription(form: Form): Reply {
    const customer = s(form['customer']);
    if (!customer) return err(400, 'invalid_request_error', 'Missing required param: customer', 'parameter_missing', 'customer');
    const c = this.customers.get(customer);
    if (!c) return missing('customer', customer, 'customer');
    const items = Array.isArray(form['items']) ? form['items'] : [];
    const first = items[0];
    const priceData = first && typeof first === 'object' && !Array.isArray(first) && typeof first['price_data'] === 'object' && !Array.isArray(first['price_data']) ? (first['price_data'] as Form) : undefined;
    const unitAmount = priceData ? s(priceData['unit_amount']) : undefined;
    const currency = priceData ? s(priceData['currency']) : undefined;
    const product = priceData ? s(priceData['product']) : undefined;
    if (!unitAmount || !/^\d+$/.test(unitAmount) || !currency || !product) return err(400, 'invalid_request_error', 'Invalid items[0][price_data]', 'parameter_invalid_empty', 'items[0][price_data]');
    if (c.email.endsWith('@declined.example')) return err(402, 'card_error', 'Your card was declined.', 'card_declined', undefined, 'generic_decline');
    const now = this.now();
    const cancelAt = s(form['cancel_at']);
    const sub: Sub = {
      id: this.id('sub'),
      customer,
      status: 'active',
      unit_amount: BigInt(unitAmount),
      currency,
      product,
      created: now,
      current_period_end: now + 30n * 86_400n,
      cancel_at: cancelAt && /^\d+$/.test(cancelAt) ? BigInt(cancelAt) : undefined,
      cancel_at_period_end: false,
      canceled_at: undefined,
      paused: false,
      metadata: stringMap(form['metadata']),
    };
    this.subs.set(sub.id, sub);
    return ok(this.subJson(sub));
  }

  private updateSubscription(sub: Sub, form: Form): Reply {
    if (sub.status === 'canceled') return err(400, 'invalid_request_error', 'A canceled subscription can only update its cancellation_details.', 'resource_missing');
    if ('pause_collection' in form) {
      const pc = form['pause_collection'];
      if (pc === '') sub.paused = false;
      else if (typeof pc === 'object' && !Array.isArray(pc) && s(pc['behavior'])) sub.paused = true;
      else return err(400, 'invalid_request_error', 'Invalid pause_collection', 'parameter_invalid_empty', 'pause_collection');
    }
    if ('cancel_at_period_end' in form) {
      const v = s(form['cancel_at_period_end']);
      sub.cancel_at_period_end = v === 'true';
      if (sub.cancel_at_period_end) sub.cancel_at = sub.current_period_end;
    }
    return ok(this.subJson(sub));
  }

  private cancelNow(sub: Sub): Reply {
    if (sub.status === 'canceled') return missing('subscription', sub.id);
    sub.status = 'canceled';
    sub.canceled_at = this.now();
    return ok(this.subJson(sub));
  }

  private createPaymentIntent(form: Form): Reply {
    const amount = s(form['amount']);
    const currency = s(form['currency']);
    const pm = s(form['payment_method']);
    if (!amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) return err(400, 'invalid_request_error', 'Invalid positive integer', 'parameter_invalid_integer', 'amount');
    if (!currency) return err(400, 'invalid_request_error', 'Missing required param: currency', 'parameter_missing', 'currency');
    if (!pm) return err(400, 'invalid_request_error', 'Missing required param: payment_method', 'parameter_missing', 'payment_method');
    if (pm === 'pm_outage') return err(503, 'api_error', 'Service unavailable');
    if (pm === 'pm_card_declined') return err(402, 'card_error', 'Your card was declined.', 'card_declined', 'payment_method', 'generic_decline');
    const types = Array.isArray(form['payment_method_types']) ? form['payment_method_types'].map((t) => s(t) ?? '') : ['card'];
    let status: Pi['status'];
    if (pm.startsWith('pm_us_bank_')) {
      if (!types.includes('us_bank_account')) return err(400, 'invalid_request_error', 'The payment method type is not in payment_method_types', 'payment_method_type_mismatch', 'payment_method');
      status = 'processing';
    } else if (pm.startsWith('pm_card_')) {
      if (!types.includes('card')) return err(400, 'invalid_request_error', 'The payment method type is not in payment_method_types', 'payment_method_type_mismatch', 'payment_method');
      status = pm === 'pm_card_3ds' ? 'requires_action' : s(form['confirm']) === 'true' ? 'succeeded' : 'requires_action';
    } else return missing('payment_method', pm, 'payment_method');
    const id = this.id('pi');
    const pi: Pi = {
      id,
      amount: BigInt(amount),
      currency,
      customer: s(form['customer']),
      payment_method: pm,
      payment_method_types: types,
      status,
      metadata: stringMap(form['metadata']),
      client_secret: `${id}_secret_${this.id('x')}`,
    };
    this.pis.set(id, pi);
    return ok(this.piJson(pi));
  }

  // ---- serialisation ----

  private subJson(sub: Sub): Json {
    return {
      id: sub.id,
      object: 'subscription',
      customer: sub.customer,
      status: sub.status,
      items: {
        object: 'list',
        data: [{ id: `si_${sub.id.slice(4)}`, object: 'subscription_item', price: { id: `price_${sub.id.slice(4)}`, object: 'price', currency: sub.currency, unit_amount: sub.unit_amount, product: sub.product, recurring: { interval: 'month', interval_count: 1 } }, current_period_end: sub.current_period_end }],
      },
      start_date: sub.created,
      created: sub.created,
      current_period_start: sub.created,
      current_period_end: sub.current_period_end,
      cancel_at: sub.cancel_at ?? null,
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at ?? null,
      pause_collection: sub.paused ? { behavior: 'void', resumes_at: null } : null,
      metadata: sub.metadata,
      livemode: false,
    };
  }

  private invoiceFor(sub: Sub, status: 'open' | 'paid', attempt: number): Json {
    return {
      id: this.id('in'),
      object: 'invoice',
      customer: sub.customer,
      subscription: sub.id,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
      status,
      currency: sub.currency,
      amount_due: sub.unit_amount,
      amount_paid: status === 'paid' ? sub.unit_amount : 0n,
      attempt_count: attempt,
      livemode: false,
    };
  }

  private piJson(pi: Pi): Json {
    return {
      id: pi.id,
      object: 'payment_intent',
      amount: pi.amount,
      currency: pi.currency,
      customer: pi.customer ?? null,
      payment_method: pi.payment_method,
      payment_method_types: pi.payment_method_types,
      status: pi.status,
      client_secret: pi.client_secret,
      metadata: pi.metadata,
      last_payment_error: pi.status === 'canceled' ? { code: 'payment_intent_payment_attempt_failed', decline_code: 'generic_decline' } : null,
      livemode: false,
    };
  }

  private event(type: string, object: Json): { headers: Record<string, string>; rawBody: string } {
    const rawBody = JSON.stringify({ id: this.id('evt'), object: 'event', api_version: '2025-03-31.basil', type, created: this.now(), livemode: false, data: { object } }, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    return { headers: this.sign(rawBody), rawBody };
  }

  private withSub(id: string, fn: (s: Sub) => Reply): Reply {
    const sub = this.subs.get(id);
    return sub ? fn(sub) : missing('subscription', id);
  }
  private mustSub(id: string): Sub {
    const sub = this.subs.get(id);
    if (!sub) throw new Error(`fake stripe: no subscription ${id}`);
    return sub;
  }
  private id(prefix: string): string {
    return `${prefix}_fake${String(++this.seq).padStart(6, '0')}`;
  }
  private now(): bigint {
    return BigInt(Math.floor(this.clock.now().getTime() / 1000));
  }
}

const ok = (body: Json): Reply => ({ status: 200, body });
const err = (status: number, type: string, message: string, code?: string, param?: string, declineCode?: string): Reply => ({
  status,
  body: { error: { type, message, ...(code ? { code } : {}), ...(param ? { param } : {}), ...(declineCode ? { decline_code: declineCode } : {}) } },
});
const missing = (kind: string, id: string, param?: string): Reply => err(404, 'invalid_request_error', `No such ${kind}: '${id}'`, 'resource_missing', param ?? 'id');
const s = (v: string | Form | Form[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const stringMap = (v: string | Form | Form[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
};

/** Decodes Stripe's bracket form encoding (`a[b][0][c]=1`) into nested objects and arrays. */
export function decodeForm(encoded: string): Form {
  const root: Form = {};
  for (const [key, value] of new URLSearchParams(encoded)) {
    const path = key.replace(/\]/g, '').split('[');
    let node: Form = root;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i]!;
      const existing = node[seg];
      if (typeof existing !== 'object') node[seg] = {};
      node = node[seg] as Form;
    }
    node[path[path.length - 1]!] = value;
  }
  return arrayify(root) as Form;
}

/** Objects whose keys are all consecutive integers become arrays (Stripe's `items[0]` style). */
function arrayify(v: string | Form | Form[]): string | Form | Form[] {
  if (typeof v !== 'object' || Array.isArray(v)) return v;
  const keys = Object.keys(v);
  const out: Form = {};
  for (const k of keys) out[k] = arrayify(v[k]!) as string | Form;
  if (keys.length > 0 && keys.every((k, i) => k === String(i))) return keys.map((k) => out[k]) as Form[];
  return out;
}
