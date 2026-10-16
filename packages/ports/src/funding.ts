// FundingPort (REQ-WAL-002/003): loads into a member's wallet by card, Apple Pay, Google Pay, ACH or
// RTP. The port creates the pull at the vendor; the ledger journal is posted by the LoadWorkflow
// after the vendor confirms (SEQ-02). ACH loads carry the bank's hold days.
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

export interface FundingPort {
  createLoad(input: { customerId: string; method: FundingMethod; amount: Money; paymentMethodId?: string }, idempotencyKey: string): Promise<Load>;
  getLoad(loadId: string): Promise<Load>;
  /** Verifies and maps a vendor webhook (payment_intent.succeeded etc.). Duplicate ids return the same event. */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; load: Load }>;
}

export type FundingErrorCode = 'UNSUPPORTED_METHOD' | 'UNKNOWN_LOAD' | 'DECLINED' | 'BAD_SIGNATURE' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class FundingError extends Error {
  constructor(
    readonly code: FundingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FundingError';
  }
}
