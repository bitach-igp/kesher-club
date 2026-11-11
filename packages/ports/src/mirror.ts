// MirrorPort (T-0718, ADR-018 M2/M4/M10, REQ-WAL-002, REQ-LED-004): the vendor-side mirror of a member's USD wallet.
// It books an amount between a member's account at the vendor and the chapter's checking account (Crowded's Book
// Payment: the chapter checking account is on one side of every payment, up to 10 independent legs per request,
// continue-on-error, one result per leg), finds a booked leg again by its memo, reports the two balances and lists the
// vendor's book payments and account movements. It is NOT `InstitutionBankingPort.bookTransfer`, which moves money from
// a platform entity to its own sub-account.
//
// It is an optional capability of the `funding` binding, found by checking that the methods exist (`isMirrorPort`),
// as `FundingStatementPort` is, so there is no registry capability, catalogue row or provider key of its own.
// The port knows no ledger. USD only (M4): another currency, zero or a negative amount is refused before the vendor.
// Money is `Money` at the edge and bigint cents inside. Memos and descriptions are untrusted text; no error message
// carries a name or mobile.
//
// What the vendor really does (Crowded, live sandbox 2026-11-11), which shapes this port:
// - The idempotency key is scoped to the chapter and the wire key must be a UUID v4 (the adapter derives one from our
//   key, T-0734). A reused key with a DIFFERENT body silently replays the FIRST payment, so every leg result echoes the
//   leg the vendor holds (`leg`) and a caller compares it with what it sent.
// - The vendor has NO lookup by key. A payment row carries its memo (`description`), source, destination and amount, not
//   the key. So a leg is found again by chapter and MEMO (`readBack`): the memo is our correlation id and MUST be unique
//   per leg. That is the caller's contract (the planner embeds a leg reference); the port rejects a duplicate memo inside
//   one batch, and `readBack` answers `ambiguous` when two payments share one.
// - A transaction row (`movements`) has no payment id, so it cannot be joined to a payment; `payments()` is what a
//   reconciler joins on.
import type { Money } from '@kesher/domain';

/** `to_checking` books from the member's account to checking; `from_checking` books from checking to the member's account. */
export type MirrorDirection = 'to_checking' | 'from_checking';

export interface MirrorLeg {
  direction: MirrorDirection;
  /** The vendor's reference of the member's account (from `ops.external_ref`, never a column of its own). */
  accountRef: string;
  /** USD, positive. */
  amount: Money;
  /** Required, at most 80 printable ASCII characters, unique per leg (the correlation id, carries our KC- reference). */
  memo: string;
  /** 8 to 128 characters of letters, digits and `._:-`, unique per leg. */
  idempotencyKey: string;
}

/** The leg as the vendor holds it. After a replay with a different body this is the FIRST body, not the one just sent. */
export interface MirrorStoredLeg {
  accountRef: string;
  direction: MirrorDirection;
  amount: Money;
  memo: string;
}

/**
 * The closed set of refusal reasons. `DUPLICATE_PAYMENT` is the vendor's answer to a reused key: it is NOT a final
 * refusal; the adapter resolves it by reading the payment back and answering what the first payment became.
 */
export type MirrorReasonCode = 'INSUFFICIENT_FUNDS' | 'ACCOUNT_UNAVAILABLE' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'PAYMENT_FAILED' | 'DUPLICATE_PAYMENT';

/**
 * `booked`: the money moved. `refused`: it did not and will not for this key. `unknown`: the vendor may hold it (the
 * answer is lost, or the vendor says Pending or something unrecognised): read it back by memo before any resend.
 */
export interface MirrorLegResult {
  status: 'booked' | 'refused' | 'unknown';
  reasonCode?: MirrorReasonCode;
  paymentRef?: string;
  /** What the vendor holds for this key; absent when the vendor never saw the leg or the answer carries none. */
  leg?: MirrorStoredLeg;
}

export type MirrorReadBack = { status: 'found'; result: MirrorLegResult } | { status: 'not_found' } | { status: 'ambiguous' };

export type MirrorAccountStatus = 'open' | 'frozen' | 'closed';

export interface MirrorBalance {
  status: MirrorAccountStatus;
  /** Cents. */
  balance: bigint;
  /** Held by card authorisations; a balance proof compares `balance` and treats `hold` separately. */
  hold: bigint;
  available: bigint;
}

/** One book payment as the vendor lists it (`GET /chapters/{id}/payments?filter[method]=book`). */
export interface MirrorPayment {
  paymentRef: string;
  status: 'sent' | 'failed' | 'pending';
  /** Always positive. */
  amount: Money;
  /** The vendor's `description`: our memo. Untrusted text. */
  memo: string;
  sourceAccountRef: string;
  destinationAccountRef: string;
  createdAt: Date;
}

/**
 * One side of a booked payment, as the vendor's transactions feed lists it (two rows per payment). It carries NO
 * payment reference: the vendor's rows have none, so it cannot be joined to a payment by id; use `payments()` for that.
 */
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
   * Books 1 to 10 legs against the chapter's checking account and answers one result per leg, in order.
   * - The whole batch is refused with `VALIDATION_FAILED` before any call for: 0 or over 10 legs, a non-USD, zero or
   *   negative amount, an empty memo, an empty accountRef, a key outside 8 to 128 characters or its charset, and a key
   *   or a memo repeated inside the batch.
   * - A refused leg does not stop the others. A memo over 80 characters or outside printable ASCII is refused
   *   `VALIDATION_ERROR` for that leg; the vendor never saw it, so a read-back finds nothing.
   * - A key already booked answers its first result with the stored leg (see `MirrorStoredLeg`); a refused key answers
   *   its refusal again.
   * - The vendor's own item status maps through `mirrorItemResult`: `Sent` is `booked`; `Rejected` is `refused`,
   *   never `booked`, even on an item the vendor called a success; `Pending` or anything unrecognised is `unknown`.
   * - Any failure after the request may have been sent (timeout, 5xx, connection loss, an unreadable answer) is
   *   `OUTCOME_UNKNOWN`; `PROVIDER_UNAVAILABLE` only when the request provably never left. After `OUTCOME_UNKNOWN`
   *   or a leg `unknown`, resend only the SAME key and the SAME body (always safe), never a new key, and first
   *   `readBack` by memo.
   */
  bookBatch(legs: MirrorLeg[], chapterRef: string): Promise<MirrorLegResult[]>;
  /**
   * Finds a leg of the chapter by its memo, moving nothing: `found` with what the vendor holds, `not_found`, or
   * `ambiguous` when more than one payment carries the memo (resolve by hand: a memo must be unique per leg).
   */
  readBack(input: { chapterRef: string; memo: string }): Promise<MirrorReadBack>;
  /** The chapter checking account. */
  checkingBalance(chapterRef: string): Promise<MirrorBalance>;
  /** A member account. */
  accountBalance(accountRef: string): Promise<MirrorBalance>;
  /** The chapter's book payments with `from <= createdAt < to`, across pages, each exactly once (what a reconciler joins on). */
  payments(input: { chapterRef: string; from: Date; to: Date }): AsyncIterable<MirrorPayment>;
  /** Account transactions with `from <= at < to`, across pages, each exactly once. No payment reference (see `MirrorMovement`). */
  movements(input: { from: Date; to: Date }): AsyncIterable<MirrorMovement>;
}

export type MirrorErrorCode =
  | 'VALIDATION_FAILED'
  /** The request provably never left. */
  | 'PROVIDER_UNAVAILABLE'
  | 'NOT_FOUND'
  /** The request may have been sent and its answer is lost or unreadable: read back by memo; never a new key. */
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
const KEY_CHARS = /^[A-Za-z0-9._:-]+$/;

/** Whole-batch validation, before any vendor call. Throws `VALIDATION_FAILED`. */
export function validateMirrorBatch(legs: MirrorLeg[]): void {
  if (legs.length < 1 || legs.length > MIRROR_BATCH_MAX) throw new MirrorError('VALIDATION_FAILED', `A batch takes 1 to ${MIRROR_BATCH_MAX} legs`);
  const keys = new Set<string>();
  const memos = new Set<string>();
  for (const l of legs) {
    if (l.direction !== 'to_checking' && l.direction !== 'from_checking') throw new MirrorError('VALIDATION_FAILED', 'direction is to_checking or from_checking');
    if (typeof l.accountRef !== 'string' || l.accountRef.trim() === '') throw new MirrorError('VALIDATION_FAILED', 'accountRef is required');
    if (l.amount.currency !== 'USD') throw new MirrorError('VALIDATION_FAILED', 'amount must be USD');
    if (typeof l.amount.minor !== 'bigint') throw new MirrorError('VALIDATION_FAILED', 'amount.minor must be a bigint');
    if (l.amount.minor <= 0n) throw new MirrorError('VALIDATION_FAILED', 'amount must be positive');
    if (typeof l.memo !== 'string' || l.memo === '') throw new MirrorError('VALIDATION_FAILED', 'memo is required');
    const k = l.idempotencyKey;
    if (typeof k !== 'string' || k.length < MIRROR_KEY_MIN || k.length > MIRROR_KEY_MAX || !KEY_CHARS.test(k)) throw new MirrorError('VALIDATION_FAILED', `idempotencyKey must be ${MIRROR_KEY_MIN} to ${MIRROR_KEY_MAX} characters of letters, digits and ._:-`);
    if (keys.has(k)) throw new MirrorError('VALIDATION_FAILED', 'An idempotency key is repeated inside the batch');
    if (memos.has(l.memo)) throw new MirrorError('VALIDATION_FAILED', 'A memo is repeated inside the batch');
    keys.add(k);
    memos.add(l.memo);
  }
}

/**
 * Maps the vendor's per-item `paymentStatus` to a leg result, the one rule an adapter and the simulator share:
 * `Sent` is booked; `Rejected` is refused (`reasonCode`, default INSUFFICIENT_FUNDS), never booked, even on an item the
 * vendor reported as a success; `Pending` and anything unrecognised is `unknown` (resolve by `readBack`).
 */
export function mirrorItemResult(item: { paymentStatus: string; reasonCode?: MirrorReasonCode; paymentRef?: string; leg?: MirrorStoredLeg }): MirrorLegResult {
  const extra = { ...(item.paymentRef ? { paymentRef: item.paymentRef } : {}), ...(item.leg ? { leg: item.leg } : {}) };
  if (item.paymentStatus === 'Sent') return { status: 'booked', ...extra };
  if (item.paymentStatus === 'Rejected') return { status: 'refused', reasonCode: item.reasonCode ?? 'INSUFFICIENT_FUNDS', ...extra };
  return { status: 'unknown', ...extra };
}

/** True when the port a binding hands back also does the member mirror (an optional capability, found by its methods). */
export function isMirrorPort(port: unknown): port is MirrorPort {
  if (typeof port !== 'object' || port === null) return false;
  const p = port as Record<string, unknown>;
  return ['bookBatch', 'readBack', 'checkingBalance', 'accountBalance', 'payments', 'movements'].every((m) => typeof p[m] === 'function');
}
