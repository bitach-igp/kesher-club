// BillingPort simulator. Fixtures: email ending "@declined.example" -> CARD_DECLINED on subscribe;
// "@outage.example" -> PROVIDER_UNAVAILABLE. Webhooks are JSON signed with header `x-sim-signature: sim`.
// The control panel can `failNextInvoice(subscriptionId)` to drive dunning.
import { fromWire, toWire } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { addMs, type Clock, DAY, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { BillingError, type BillingCustomer, type BillingEvent, type BillingPort, type PaymentSheet, type Subscription, type WalletButtons } from './billing.ts';

export class BillingSimulator implements BillingPort {
  private readonly customers = new Map<string, BillingCustomer>();
  private readonly subs = new Map<string, Subscription>();
  private readonly idem = new IdempotencyStore<unknown>();
  private readonly events = new Map<string, BillingEvent>();
  private readonly ids = new Sequence('cus');
  private readonly subIds = new Sequence('sub');
  private readonly evIds = new Sequence('evt');

  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  async createCustomer(input: { partyId: string; email: string }, idempotencyKey: string): Promise<BillingCustomer> {
    if (input.email.endsWith('@outage.example')) throw new BillingError('PROVIDER_UNAVAILABLE', 'Simulated billing outage');
    return (await this.idem.run(idempotencyKey, async () => {
      const c = { customerId: this.ids.next(), email: input.email };
      this.customers.set(c.customerId, c);
      return c;
    })) as BillingCustomer;
  }

  async createSetupSheet(customerId: string, wallets: WalletButtons): Promise<PaymentSheet> {
    if (!this.customers.has(customerId)) throw new BillingError('UNKNOWN_CUSTOMER', customerId);
    return { clientSecret: `seti_${customerId}_secret_sim`, wallets };
  }

  async createSubscription(input: { customerId: string; planCode: string; price: Money; termMonths: number }, idempotencyKey: string): Promise<Subscription> {
    const c = this.customers.get(input.customerId);
    if (!c) throw new BillingError('UNKNOWN_CUSTOMER', input.customerId);
    if (c.email.endsWith('@declined.example')) throw new BillingError('CARD_DECLINED', 'Simulated decline');
    return (await this.idem.run(idempotencyKey, async () => {
      const s: Subscription = {
        subscriptionId: this.subIds.next(),
        customerId: input.customerId,
        planCode: input.planCode,
        status: 'active',
        price: input.price,
        termMonths: input.termMonths,
        currentPeriodEnd: addMs(this.clock.now(), 30 * DAY).toISOString(),
      };
      this.subs.set(s.subscriptionId, s);
      return s;
    })) as Subscription;
  }

  async pause(id: string, key: string): Promise<Subscription> {
    return this.transition(id, key, ['active', 'past_due'], 'paused');
  }
  async resume(id: string, key: string): Promise<Subscription> {
    return this.transition(id, key, ['paused'], 'active');
  }
  async cancel(id: string, at: 'now' | 'period_end', key: string): Promise<Subscription> {
    return (await this.idem.run(key, async () => {
      const s = this.must(id);
      if (s.status === 'cancelled') throw new BillingError('INVALID_STATE', 'Already cancelled');
      const next: Subscription = at === 'now' ? { ...s, status: 'cancelled', cancelAt: this.clock.now().toISOString() } : { ...s, cancelAt: s.currentPeriodEnd };
      this.subs.set(id, next);
      return next;
    })) as Subscription;
  }
  async get(id: string): Promise<Subscription> {
    return { ...this.must(id) };
  }

  async parseWebhook(headers: Record<string, string>, rawBody: string): Promise<BillingEvent> {
    if (headers['x-sim-signature'] !== 'sim') throw new BillingError('BAD_SIGNATURE', 'Webhook signature invalid');
    const b = JSON.parse(rawBody) as { eventId: string; type: BillingEvent['type']; subscriptionId: string; amount?: { minor: string; currency: string }; attempt?: number };
    const prior = this.events.get(b.eventId);
    if (prior) return prior;
    const s = this.must(b.subscriptionId);
    let event: BillingEvent;
    if (b.type === 'invoice.paid') event = { eventId: b.eventId, type: 'invoice.paid', subscriptionId: s.subscriptionId, amount: b.amount ? fromWire(b.amount) : s.price };
    else if (b.type === 'invoice.payment_failed') {
      this.subs.set(s.subscriptionId, { ...s, status: 'past_due' });
      event = { eventId: b.eventId, type: 'invoice.payment_failed', subscriptionId: s.subscriptionId, attempt: b.attempt ?? 1 };
    } else event = { eventId: b.eventId, type: 'subscription.updated', subscription: { ...this.must(s.subscriptionId) } };
    this.events.set(b.eventId, event);
    return event;
  }

  /** Control-panel hook: emit a signed webhook for a failed or paid invoice. */
  webhookFor(subscriptionId: string, type: 'invoice.paid' | 'invoice.payment_failed', attempt = 1): { headers: Record<string, string>; rawBody: string } {
    const s = this.must(subscriptionId);
    return {
      headers: { 'x-sim-signature': 'sim' },
      rawBody: JSON.stringify({ eventId: this.evIds.next(), type, subscriptionId, amount: toWire(s.price), attempt }),
    };
  }

  private async transition(id: string, key: string, from: Subscription['status'][], to: Subscription['status']): Promise<Subscription> {
    return (await this.idem.run(key, async () => {
      const s = this.must(id);
      if (!from.includes(s.status)) throw new BillingError('INVALID_STATE', `Cannot go from ${s.status} to ${to}`);
      const next = { ...s, status: to };
      this.subs.set(id, next);
      return next;
    })) as Subscription;
  }

  private must(id: string): Subscription {
    const s = this.subs.get(id);
    if (!s) throw new BillingError('UNKNOWN_SUBSCRIPTION', id);
    return s;
  }
}
