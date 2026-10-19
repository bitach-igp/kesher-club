// BillingPort (E03): memberships billed by Stripe Billing. Plans and entitlements are ours; the
// vendor holds customers, payment methods and subscriptions. Money is Money (bigint minor units).
import type { Money } from '@kesher/domain';

export type SubscriptionStatus = 'incomplete' | 'active' | 'past_due' | 'paused' | 'cancelled';

export interface BillingCustomer {
  customerId: string;
  email: string;
}

export interface Subscription {
  subscriptionId: string;
  customerId: string;
  planCode: string;
  status: SubscriptionStatus;
  /** Monthly price actually charged (plan price at creation, locked for the term). */
  price: Money;
  /** Term length in months (10 for the academic year). */
  termMonths: number;
  currentPeriodEnd: string;
  cancelAt?: string;
}

export type WalletButtons = { applePay: boolean; googlePay: boolean };

export interface PaymentSheet {
  /** Client secret for the Payment Element / SetupIntent. Never logged. */
  clientSecret: string;
  wallets: WalletButtons;
}

export interface BillingPort {
  createCustomer(input: { partyId: string; email: string }, idempotencyKey: string): Promise<BillingCustomer>;
  /** Prepares the Payment Element for saving a card; wallet buttons follow billing.applePay / googlePay. */
  createSetupSheet(customerId: string, wallets: WalletButtons): Promise<PaymentSheet>;
  createSubscription(input: { customerId: string; planCode: string; price: Money; termMonths: number }, idempotencyKey: string): Promise<Subscription>;
  pause(subscriptionId: string, idempotencyKey: string): Promise<Subscription>;
  resume(subscriptionId: string, idempotencyKey: string): Promise<Subscription>;
  cancel(subscriptionId: string, at: 'now' | 'period_end', idempotencyKey: string): Promise<Subscription>;
  get(subscriptionId: string): Promise<Subscription>;
  /** Verifies the vendor signature and maps the event. Duplicate event ids return the same event. */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<BillingEvent>;
}

export type BillingEvent =
  | { eventId: string; type: 'invoice.paid'; subscriptionId: string; amount: Money }
  | { eventId: string; type: 'invoice.payment_failed'; subscriptionId: string; attempt: number }
  | { eventId: string; type: 'subscription.updated'; subscription: Subscription };

export type BillingErrorCode = 'UNKNOWN_CUSTOMER' | 'UNKNOWN_SUBSCRIPTION' | 'UNKNOWN_PLAN' | 'CARD_DECLINED' | 'BAD_SIGNATURE' | 'INVALID_STATE' | 'PROVIDER_UNAVAILABLE';

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  constructor(
    code: BillingErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'BillingError';
  }
}
