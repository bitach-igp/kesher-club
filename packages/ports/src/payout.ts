// PayoutPort (REQ-PO-001/002): ILS payouts via Nium (Masav). Payee validation covers the Israeli
// IBAN checksum and the account-holder name; the 24 h cooling-off for new payees over ₪2,000 is
// enforced by the PayoutWorkflow, not the vendor. Failures auto-reverse the journal (SEQ-09).
import type { Money } from '@kesher/domain';

export type PayoutStatus = 'submitted' | 'processing' | 'settled' | 'failed';

export interface Payee {
  iban: string;
  /** Account holder name as the bank knows it. */
  name: string;
}

export interface PayeeValidation {
  valid: boolean;
  reasons: readonly ('IBAN_CHECKSUM' | 'NOT_ISRAELI' | 'NAME_MISMATCH' | 'BANK_UNKNOWN')[];
  bankCode?: string;
}

export interface Payout {
  payoutId: string;
  payee: Payee;
  amount: Money;
  status: PayoutStatus;
  failureReason?: string;
}

export interface PayoutPort {
  validatePayee(payee: Payee): Promise<PayeeValidation>;
  createPayout(input: { payee: Payee; amount: Money; reference: string }, idempotencyKey: string): Promise<Payout>;
  getPayout(payoutId: string): Promise<Payout>;
  /** Status webhooks (processing / settled / failed). Duplicate ids return the same event. */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; payout: Payout }>;
}

export type PayoutErrorCode = 'INVALID_PAYEE' | 'UNKNOWN_PAYOUT' | 'BAD_SIGNATURE' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class PayoutError extends Error {
  constructor(
    readonly code: PayoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

/** ISO 13616 mod-97 check; shared by the simulator, adapters and the API's payee form. */
export function ibanChecksumOk(iban: string): boolean {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

export const isIsraeliIban = (iban: string): boolean => /^IL\d{21}$/.test(iban.replace(/\s+/g, '').toUpperCase());
