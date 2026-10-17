// FundingPort (REQ-WAL-002/003/005): loads into a member's wallet by card, Apple Pay, Google Pay, ACH
// or RTP, and refunds back to a load's source when a purse is emptied on closure. The port creates the
// pull or the refund at the vendor; the ledger journal is posted by the workflow after the vendor
// confirms (SEQ-02). ACH loads carry the bank's hold days.
import type { Money } from '@kesher/domain';

export type FundingMethod = 'card' | 'apple_pay' | 'google_pay' | 'ach' | 'rtp';
export type LoadStatus = 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'on_hold';

export interface Load {
  loadId: string;
  method: FundingMethod;
  amount: Money;
  status: LoadStatus;
  /** ACH: funds spendable from this date ("On hold until {date}", REQ-WAL-003). */
  holdUntil?: string;
  /** Client-side secret for a payment sheet when status is requires_action. Never logged. */
  clientSecret?: string;
  failureCode?: string;
}

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

/** Money returned to the source of a load (REQ-WAL-005). Partial refunds are allowed up to the load's amount. */
export interface Refund {
  refundId: string;
  loadId: string;
  amount: Money;
  status: RefundStatus;
  failureCode?: string;
}

export interface FundingPort {
  createLoad(input: { customerId: string; method: FundingMethod; amount: Money; paymentMethodId?: string }, idempotencyKey: string): Promise<Load>;
  getLoad(loadId: string): Promise<Load>;
  /** Returns up to the load's remaining amount to its source. Same key → the same refund. */
  refund(input: { loadId: string; amount: Money }, idempotencyKey: string): Promise<Refund>;
  getRefund(refundId: string): Promise<Refund>;
  /** Verifies and maps a vendor webhook (payment_intent.succeeded etc.). Duplicate ids return the same event. */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; load: Load }>;
}

export type FundingErrorCode = 'UNSUPPORTED_METHOD' | 'UNKNOWN_LOAD' | 'UNKNOWN_REFUND' | 'DECLINED' | 'BAD_SIGNATURE' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class FundingError extends Error {
  constructor(
    readonly code: FundingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FundingError';
  }
}
