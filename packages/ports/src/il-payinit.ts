// IlPayInitPort (flag il.payinit): Israeli pay-by-bank through a licensed PISP (future). Defined now
// so the FundingPort ACH/RTP shape has an ILS sibling; the simulator is the only implementation.
import type { Money } from '@kesher/domain';

export type PayInitStatus = 'redirect' | 'authorised' | 'settled' | 'rejected' | 'expired';

export interface PayInitiation {
  paymentId: string;
  amount: Money;
  status: PayInitStatus;
  /** Bank app / web redirect for the payer. */
  redirectUrl?: string;
  expiresAt: string;
}

export interface IlPayInitPort {
  initiate(input: { amount: Money; payerHint?: { bankCode: string }; reference: string; returnUrl: string }, idempotencyKey: string): Promise<PayInitiation>;
  getStatus(paymentId: string): Promise<PayInitiation>;
  /** Bank callback after the payer authorises. Duplicate ids return the same result. */
  parseCallback(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; payment: PayInitiation }>;
}

export type IlPayInitErrorCode = 'UNKNOWN_PAYMENT' | 'BAD_SIGNATURE' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class IlPayInitError extends Error {
  constructor(
    readonly code: IlPayInitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IlPayInitError';
  }
}
