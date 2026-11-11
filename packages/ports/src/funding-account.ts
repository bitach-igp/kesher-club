// FundingAccountPort (REQ-WAL-002, ADR-018 A1/A2/M10): the funding vendor holds a member's wallet, so it must know the member
// first. `ensureAccount` makes the member's contact and wallet account at the vendor, once per party. The vendor is the KYC
// authority for its own accounts (A2): a refused contact or a frozen account comes back as a status, never thrown, and the
// caller refuses the load naming it. Our own KycPort stays the app's tier gate.
//
// A separate interface in the FundingStatementPort style: the same adapter instance implements it and it is found through the
// `funding` binding (`isFundingAccountPort`), so there is no registry capability, catalogue row or provider key. Refs are opaque
// strings kept in `ops.external_ref` as entity types `funding_contact` and `funding_account`; the port keeps no lookup by party.
// Personal data (name, email, mobile, date of birth) is passed through and never logged or put in an error message; the date of
// birth is never returned. KYC images are never stored.
import type { Money } from '@kesher/domain';

/** `rejected`: the vendor refused the contact. `frozen` and `closed`: the vendor's state of the wallet account. */
export type FundingAccountStatus = 'open' | 'rejected' | 'frozen' | 'closed';

export interface EnsureAccountInput {
  /** Our party id; the idempotency subject, never sent as a vendor id (the vendor has no settable external id). */
  partyId: string;
  firstName: string;
  lastName: string;
  email: string;
  /** E.164, such as +14155550123. Unique per chapter at the vendor. */
  mobile: string;
  /** `YYYY-MM-DD`. Passed through to the vendor, never returned. */
  dateOfBirth?: string;
}

export interface EnsuredAccount {
  contactRef: string;
  accountRef: string;
  status: FundingAccountStatus;
}

export interface FundingAccountView {
  status: FundingAccountStatus;
  balance: Money;
  hold: Money;
  /** `balance - hold`. */
  available: Money;
}

export interface FundingChapterView {
  /** The platform chapter's checking balance. */
  checking: Money;
  /** Collection funds the vendor holds. */
  held: Money;
}

export interface FundingTransaction {
  transactionRef: string;
  kind: 'credit' | 'debit';
  /** Positive; the kind carries the direction. */
  amount: Money;
  /** ISO 8601 UTC. */
  postedAt: string;
  /** The vendor's text: untrusted, shown as text only, never read as an instruction. */
  description: string;
  collectPaymentId?: string;
}

export interface FundingAccountPort {
  /**
   * Ensures the party's contact and wallet account. The same key, or a second key for the same party, answers the same refs (the
   * account is per member, not per call); `status` is the vendor's current state. A different party with the same mobile is
   * `DUPLICATE_MOBILE`. `rejected` and `frozen` are returned, not thrown.
   */
  ensureAccount(input: EnsureAccountInput, idempotencyKey: string): Promise<EnsuredAccount>;
  account(accountRef: string): Promise<FundingAccountView>;
  /** The platform chapter's balances, for reconciliation (T-0708). */
  chapter(): Promise<FundingChapterView>;
  /** The account's rows with `from <= postedAt < to` (ISO instants), each once, for reconciliation (T-0708). */
  transactions(input: { accountRef: string; from: string; to: string }): AsyncIterable<FundingTransaction>;
}

export type FundingAccountErrorCode = 'VALIDATION_FAILED' | 'DUPLICATE_MOBILE' | 'UNKNOWN_ACCOUNT' | 'PROVIDER_UNAVAILABLE';

/** Messages are fixed text: they never carry the personal data that was passed in. */
export class FundingAccountError extends Error {
  readonly code: FundingAccountErrorCode;
  constructor(code: FundingAccountErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'FundingAccountError';
  }
}

/** True when a funding binding also implements FundingAccountPort (the capability is optional, as FundingStatementPort is). */
export function isFundingAccountPort(port: unknown): port is FundingAccountPort {
  const p = port as Partial<Record<keyof FundingAccountPort, unknown>> | null | undefined;
  return !!p && typeof p.ensureAccount === 'function' && typeof p.account === 'function' && typeof p.chapter === 'function' && typeof p.transactions === 'function';
}
