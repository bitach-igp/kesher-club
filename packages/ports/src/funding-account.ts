// FundingAccountPort (REQ-WAL-002, ADR-018 A1/A2/M10): the funding vendor holds a member's wallet, so it must know the member
// first. `ensureAccount` makes the member's contact and wallet account. The vendor is the KYC authority for its own accounts
// (A2): a refused contact comes back as a status, never thrown, and the caller refuses the load naming it. Our own KycPort stays
// the app's tier gate.
//
// Identity at the vendor is the MOBILE within the platform chapter: a contact create has no idempotency key and no external id,
// so the adapter owns the mobile-to-contact lookup (it finds an existing contact by mobile before it creates one). `partyId` is
// only the idempotency subject. The party-to-contact mapping is the CALLER's, kept in `ops.external_ref` (entity types
// `funding_contact` and `funding_account`); the port keeps no lookup by party and refs are opaque strings.
//
// A separate interface in the FundingStatementPort style: the same adapter instance implements it and it is found through the
// `funding` binding. `isFundingAccountPort` is a new method-exists check for that (the repo has no equivalent guard for
// FundingStatementPort), so there is no registry capability, catalogue row or provider key. Personal data (name, email, mobile,
// date of birth) is passed through and never logged or put in an error message; the date of birth is never returned. KYC images
// are never stored.
import type { Money } from '@kesher/domain';

/**
 * The vendor's states of a wallet account, mapped directly from its Open, Frozen and Closed. Only `open` is usable: a caller
 * refuses a load for `frozen` and `closed`, naming the status. An account still being provisioned is the adapter's to resolve
 * (poll) before it returns, and a vendor answer that the account already existed (`accountCreated: false`) is success.
 */
export type FundingAccountStatus = 'open' | 'frozen' | 'closed';

/**
 * A contact that has no wallet account. Mapped from the vendor's contact status: Failed is `rejected` (the vendor refused the
 * contact), Archived is `archived`; Active is implied by an account. The vendor creates no account for either.
 */
export type FundingContactStatus = 'rejected' | 'archived';

export interface EnsureAccountInput {
  /** Our party id: the idempotency subject only. It is never sent as a vendor id (the vendor has no settable external id). */
  partyId: string;
  firstName: string;
  lastName: string;
  email: string;
  /** E.164, such as +14155550123. Unique per chapter at the vendor, so it is the contact's identity there. */
  mobile: string;
  /** `YYYY-MM-DD`. Passed through to the vendor, never returned. */
  dateOfBirth?: string;
}

/** A contact with an account carries both refs; a `rejected` or `archived` contact carries its `contactRef` only, no `accountRef`. */
export type EnsuredAccount =
  | { contactRef: string; accountRef: string; status: FundingAccountStatus }
  | { contactRef: string; status: FundingContactStatus };

export interface FundingAccountView {
  status: FundingAccountStatus;
  balance: Money;
  hold: Money;
  /** `balance - hold`. */
  available: Money;
}

export interface FundingChapterView {
  /**
   * The platform chapter's checking balance. A separate account at the vendor (it also holds platform revenue and payables,
   * ADR-018 D5), not the sum of the wallets: a wallet credit moves checking down by a book payment.
   */
  checking: Money;
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
  // No payment id: the vendor's wallet transaction rows carry none. Only a statement or reconciliation join can supply one.
}

export interface FundingAccountPort {
  /**
   * Ensures the contact and wallet account for a mobile.
   * - The same key with the same input replays; the same key with different input (party, name, email, mobile or date of birth)
   *   is `IDEMPOTENCY_CONFLICT` and returns no refs.
   * - A second key for a party that already exists with the same data answers the same refs and the current status.
   * - A second key for an existing party with a different mobile, name, email or date of birth is `PARTY_CONFLICT`: a member
   *   changing phone is an explicit update call, not part of this port.
   * - A different party whose mobile already belongs to an existing contact is `DUPLICATE_MOBILE` (the caller shows the member a
   *   generic message, not which mobile or party).
   * `rejected` and `archived` are returned, not thrown.
   */
  ensureAccount(input: EnsureAccountInput, idempotencyKey: string): Promise<EnsuredAccount>;
  /** `UNKNOWN_ACCOUNT` for a ref that is not a wallet account, including the contactRef of a rejected contact. */
  account(accountRef: string): Promise<FundingAccountView>;
  /** The platform chapter's checking balance, for reconciliation (T-0708, which will source held collection funds itself). */
  chapter(): Promise<FundingChapterView>;
  /** The account's rows with `from <= postedAt < to` (ISO instants), each once, for reconciliation (T-0708). */
  transactions(input: { accountRef: string; from: string; to: string }): AsyncIterable<FundingTransaction>;
}

export type FundingAccountErrorCode = 'VALIDATION_FAILED' | 'DUPLICATE_MOBILE' | 'UNKNOWN_ACCOUNT' | 'IDEMPOTENCY_CONFLICT' | 'PARTY_CONFLICT' | 'PROVIDER_UNAVAILABLE';

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
