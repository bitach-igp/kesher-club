// MirrorPort (T-0718, ADR-018 M2/M4/M10, REQ-WAL-002, REQ-LED-004): the vendor-side mirror of a member's USD wallet.
// It books an amount between a member's account at the vendor and the chapter's checking account (Crowded's Book
// Payment: the chapter checking account is on one side of every payment, up to 10 independent legs per request,
// continue-on-error, one result per leg), reads a leg back by its key, reports the two balances and lists the
// account movements. It is NOT `InstitutionBankingPort.bookTransfer`, which moves money from a platform entity to its
// own sub-account.
//
// It is an optional capability of the `funding` binding, found by checking that the methods exist (`isMirrorPort`),
// as `FundingStatementPort` is, so there is no registry capability, catalogue row or provider key of its own.
// The port knows no ledger. USD only (M4): another currency, zero or a negative amount is refused before the vendor.
// Every call that moves money takes an idempotency key per leg; a replay answers the first result. Money is `Money`
// at the edge and bigint cents inside. Memos and descriptions are untrusted text; no error message carries a name or mobile.
import type { Money } from '@kesher/domain';

/** `to_checking` books from the member's account to checking; `from_checking` books from checking to the member's account. */
export type MirrorDirection = 'to_checking' | 'from_checking';

export interface MirrorLeg {
  direction: MirrorDirection;
  /** The vendor's reference of the member's account (from `ops.external_ref`, never a column of its own). */
  accountRef: string;
  /** USD, positive. */
  amount: Money;
  /** At most 80 printable ASCII characters; carries our KC- reference. */
  memo: string;
  /** 8 to 128 characters, unique per leg. */
  idempotencyKey: string;
}

/** The closed set of refusal reasons. */
export type MirrorReasonCode = 'INSUFFICIENT_FUNDS' | 'ACCOUNT_UNAVAILABLE' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'PAYMENT_FAILED';

/**
 * `booked`: the money moved. `refused`: it did not and will not for this key. `unknown`: the answer for this leg
 * is lost or unreadable and the vendor may hold it: read it back by key before any resend.
 */
export interface MirrorLegResult {
  status: 'booked' | 'refused' | 'unknown';
  reasonCode?: MirrorReasonCode;
  paymentRef?: string;
}

export interface MirrorReadBack {
  status: 'booked' | 'refused' | 'not_found';
  reasonCode?: MirrorReasonCode;
  paymentRef?: string;
}

/** One side of a booked payment, as the vendor lists it (each payment appears as two rows, one per account). */
export interface MirrorMovement {
  transactionRef: string;
  /** The account the row is on: the member's account or the chapter's checking reference. */
  accountRef: string;
  /** From the point of view of `accountRef`. */
  direction: 'credit' | 'debit';
  /** Always positive; `direction` carries the sign. */
  amount: Money;
  counterpartyAccountRef?: string;
  /** The vendor's free text. Untrusted. */
  description: string;
  at: Date;
}

export const MIRROR_BATCH_MAX = 10;
export const MIRROR_MEMO_MAX = 80;
export const MIRROR_KEY_MIN = 8;
export const MIRROR_KEY_MAX = 128;

export interface MirrorPort {
  /**
   * Books 1 to 10 legs against the chapter's checking account and answers one result per leg, in order. A leg that
   * is not USD or not positive, a batch of 0 or over 10, or a key outside 8 to 128 characters is `VALIDATION_FAILED`
   * and refuses the whole batch before any call. A refused leg does not stop the others. A key already booked answers
   * `booked` with its first `paymentRef` and moves nothing; a refused key answers its refusal again.
   */
  bookBatch(legs: MirrorLeg[], chapterRef: string): Promise<MirrorLegResult[]>;
  /** What the vendor did with a key, moving nothing. Read a leg whose answer was lost before any resend. */
  readBack(idempotencyKey: string): Promise<MirrorReadBack>;
  /** The chapter checking account's balance in cents. */
  checkingBalance(chapterRef: string): Promise<{ balance: bigint }>;
  /** A member account's balance in cents. */
  accountBalance(accountRef: string): Promise<{ balance: bigint }>;
  /** Movements with `from <= at < to`, across pages, each exactly once. */
  movements(input: { from: Date; to: Date }): AsyncIterable<MirrorMovement>;
}

export type MirrorErrorCode =
  | 'VALIDATION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NOT_FOUND'
  /** A call that may have moved money got an answer we cannot read: do not resend blindly; read the leg back by key. */
  | 'OUTCOME_UNKNOWN';

export class MirrorError extends Error {
  readonly code: MirrorErrorCode;
  constructor(
    code: MirrorErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'MirrorError';
  }
}

export const isMirrorMemo = (s: string): boolean => s.length <= MIRROR_MEMO_MAX && /^[\x20-\x7E]*$/.test(s);

/** Whole-batch validation, before any vendor call. Throws `VALIDATION_FAILED`. */
export function validateMirrorBatch(legs: MirrorLeg[]): void {
  if (legs.length < 1 || legs.length > MIRROR_BATCH_MAX) throw new MirrorError('VALIDATION_FAILED', `A batch takes 1 to ${MIRROR_BATCH_MAX} legs`);
  for (const l of legs) {
    if (l.amount.currency !== 'USD') throw new MirrorError('VALIDATION_FAILED', 'amount must be USD');
    if (l.amount.minor <= 0n) throw new MirrorError('VALIDATION_FAILED', 'amount must be positive');
    if (l.idempotencyKey.length < MIRROR_KEY_MIN || l.idempotencyKey.length > MIRROR_KEY_MAX) throw new MirrorError('VALIDATION_FAILED', `idempotencyKey must be ${MIRROR_KEY_MIN} to ${MIRROR_KEY_MAX} characters`);
  }
}

/** True when the port a binding hands back also does the member mirror (an optional capability, found by its methods). */
export function isMirrorPort(port: unknown): port is MirrorPort {
  if (typeof port !== 'object' || port === null) return false;
  const p = port as Record<string, unknown>;
  return ['bookBatch', 'readBack', 'checkingBalance', 'accountBalance', 'movements'].every((m) => typeof p[m] === 'function');
}
