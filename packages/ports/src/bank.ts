// BankPort (T-0618, REQ-INS-007): the incoming credits on Kesher's own collection account, which institutions
// pay into by Masav, wire or ACH quoting their payment reference (T-0614). The port tells the club what arrived:
// one signed notification per credit, and the day's statement for the daily reconciliation. It moves no money.
// Which bank sits behind it waits on ADR-006; until then the simulator stands in (ports before vendors).
//
// A credit carries what the bank saw and nothing personal: the rail, the amount, the bank's own reference for the
// statement line, the value date and the remitter's free text, which is untrusted data, never instructions.
import type { Money } from '@kesher/domain';

export type BankRail = 'masav' | 'wire' | 'ach';

export interface IncomingCredit {
  /** The bank's id for the credit; mapped through ops.external_ref, never stored in a column of its own. */
  creditId: string;
  rail: BankRail;
  amount: Money;
  /** The statement line's reference, unique per rail at the bank ("FT2611-ABC"). */
  bankReference: string;
  /** What the payer wrote, where a "KC-…" payment reference should be. Untrusted text, at most 140 characters. */
  remitterReference: string;
  /** YYYY-MM-DD: the day the money was available at the bank. */
  valueDate: string;
}

export interface BankPort {
  /** Verifies and maps the bank's credit notification. A duplicate notification answers the same event. */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; credit: IncomingCredit }>;
  /** Every incoming credit with this value date, for the daily reconciliation. */
  statement(input: { valueDate: string }): Promise<IncomingCredit[]>;
}

export type BankErrorCode = 'BAD_SIGNATURE' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class BankError extends Error {
  readonly code: BankErrorCode;
  constructor(
    code: BankErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'BankError';
  }
}

/** The longest remitter text a credit carries; a bank's longer field is cut, not refused. */
export const REMITTER_MAX = 140;
