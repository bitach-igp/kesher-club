// MirrorPort simulator (T-0718). A chapter's checking account and its members' accounts in memory, bigint cents.
// The panel's hooks: `openChapter(chapterRef, minor)` makes a checking account, `openAccount(accountRef, minor)` a member's
// open account, `setStatus(ref, 'open' | 'frozen' | 'closed')` (an unopened reference is an error), `setHold(ref, minor)`.
// A payment is kept with the leg as first sent (a reused key with another body replays the FIRST payment, as the vendor does).
// Deterministic fixtures, one-shot (consumed the first time their key is processed; `clearFixtures()` drops the unused;
// a batch refused by validation, or by an outage, consumes none):
// - `refuse(key, code)`: the leg is refused with that code once sent. INSUFFICIENT_FUNDS and PAYMENT_FAILED are PERSISTED
//   (a payment id, listed as failed, found by readBack); VALIDATION_ERROR, NOT_FOUND and ACCOUNT_UNAVAILABLE are refused
//   before persistence (no id, never listed, readBack not_found), as the vendor does. DUPLICATE_PAYMENT is rejected (never a final refusal);
// - `vendorStatus(key, 'Rejected' | 'Pending')`: the vendor answers an item whose paymentStatus is Rejected (reasonCode
//   InsufficientFunds: refused INSUFFICIENT_FUNDS, persisted, unless `refuse` names another) or Pending (unknown, nothing
//   moves until `settle(key)`);
// - `loseAnswer(key)`: the leg books, then its answer is lost (`unknown`); a read-back or a resend finds it booked;
// - `loseBatch()`: the next batch that passes validation books every leg it can, then answers OUTCOME_UNKNOWN for the whole
//   request, even when all its legs are replays (the fixture is consumed by that batch);
// - `outage(on)`: every call answers PROVIDER_UNAVAILABLE and nothing moves (the request never left).
// Precedence on one key: `refuse` beats `vendorStatus` beats `loseAnswer` (which is dropped).
// A leg is refused INSUFFICIENT_FUNDS when the account it draws from has less available (balance minus hold),
// NOT_FOUND for an account the vendor does not know, ACCOUNT_UNAVAILABLE when either side is frozen or closed, and
// VALIDATION_ERROR for a memo over 80 printable ASCII characters (the vendor never saw it: not stored, nothing to read back).
// Only a persisted refusal is kept as a failed payment; a replay of a key that was refused before persistence is decided afresh.
import { type Money, money } from '@kesher/domain';
import { type Clock, fixedClock, Sequence } from './base.ts';
import {
  type MirrorAccountStatus,
  type MirrorBalance,
  type MirrorDirection,
  type MirrorLeg,
  type MirrorLegResult,
  type MirrorMovement,
  type MirrorPayment,
  type MirrorPort,
  type MirrorReadBack,
  type MirrorReasonCode,
  MIRROR_PERSISTED_REFUSALS,
  MirrorError,
  isMirrorMemo,
  mirrorItemResult,
  validateMirrorBatch,
} from './mirror.ts';

interface Acct {
  kind: 'chapter' | 'member';
  balance: bigint;
  hold: bigint;
  status: MirrorAccountStatus;
}
interface Payment {
  paymentRef: string;
  key: string;
  chapterRef: string;
  leg: MirrorLeg;
  status: 'sent' | 'failed' | 'pending';
  reasonCode?: MirrorReasonCode;
  at: Date;
}

const PAYMENT_STATUS = { sent: 'Sent', failed: 'Rejected', pending: 'Pending' } as const;

export class MirrorSimulator implements MirrorPort {
  readonly clock: Clock;
  private readonly pageSize: number;
  private readonly accts = new Map<string, Acct>();
  private readonly payList: Payment[] = [];
  private readonly byKey = new Map<string, Payment>();
  private readonly rows: MirrorMovement[] = [];
  private readonly refusals = new Map<string, MirrorReasonCode>();
  private readonly vendorStatuses = new Map<string, 'Rejected' | 'Pending'>();
  private readonly lost = new Set<string>();
  private lostBatch = false;
  private down = false;
  private readonly ids = { pay: new Sequence('bkp'), txn: new Sequence('mtx') };

  /** `pageSize` is the vendor's page: small values make the listings cross page boundaries in tests. */
  constructor(opts: { clock?: Clock; pageSize?: number } = {}) {
    this.clock = opts.clock ?? fixedClock();
    this.pageSize = Math.max(1, opts.pageSize ?? 100);
  }

  openChapter(chapterRef: string, minor: bigint): void {
    this.accts.set(chapterRef, { kind: 'chapter', balance: minor, hold: 0n, status: 'open' });
  }
  openAccount(accountRef: string, minor = 0n): void {
    this.accts.set(accountRef, { kind: 'member', balance: minor, hold: 0n, status: 'open' });
  }
  private known(ref: string): Acct {
    const a = this.accts.get(ref);
    if (!a) throw new Error(`MirrorSimulator: ${ref} is not opened`);
    return a;
  }
  setStatus(ref: string, status: MirrorAccountStatus): void {
    this.known(ref).status = status;
  }
  setHold(ref: string, minor: bigint): void {
    const a = this.known(ref);
    if (typeof minor !== 'bigint' || minor < 0n || minor > a.balance) throw new Error('MirrorSimulator: a hold is a non-negative bigint, at most the balance');
    a.hold = minor;
  }
  refuse(key: string, code: MirrorReasonCode): void {
    if ((code as string) === 'DUPLICATE_PAYMENT') throw new Error('MirrorSimulator: DUPLICATE_PAYMENT is not a refusal a leg can end with');
    this.refusals.set(key, code);
  }
  vendorStatus(key: string, status: 'Rejected' | 'Pending'): void {
    this.vendorStatuses.set(key, status);
  }
  loseAnswer(key: string): void {
    this.lost.add(key);
  }
  loseBatch(): void {
    this.lostBatch = true;
  }
  outage(on: boolean): void {
    this.down = on;
  }
  clearFixtures(): void {
    this.refusals.clear();
    this.vendorStatuses.clear();
    this.lost.clear();
    this.lostBatch = false;
  }

  /** Control hook: the vendor settles a Pending payment: the money moves now, or it fails when the source cannot cover it. */
  settle(key: string): void {
    const p = this.byKey.get(key);
    if (!p || p.status !== 'pending') throw new Error(`MirrorSimulator: no pending payment for ${key}`);
    const reason = this.refusalFor(p.leg, p.chapterRef);
    if (reason) {
      p.status = 'failed';
      p.reasonCode = reason;
      return;
    }
    p.status = 'sent';
    this.apply(p);
  }

  private up(): void {
    if (this.down) throw new MirrorError('PROVIDER_UNAVAILABLE', 'Simulated provider outage');
  }

  async bookBatch(legs: MirrorLeg[], chapterRef: string): Promise<MirrorLegResult[]> {
    validateMirrorBatch(legs);
    this.up();
    if (this.accts.get(chapterRef)?.kind !== 'chapter') throw new MirrorError('NOT_FOUND', 'Unknown chapter');
    const results = legs.map((l) => this.bookOne(l, chapterRef));
    if (this.lostBatch) {
      this.lostBatch = false;
      throw new MirrorError('OUTCOME_UNKNOWN', 'Simulated lost answer: the request may have been booked');
    }
    return results;
  }

  private echo(p: Payment): MirrorLegResult {
    const { accountRef, direction, amount, memo } = p.leg;
    return mirrorItemResult({ paymentStatus: PAYMENT_STATUS[p.status], ...(p.reasonCode ? { reasonCode: p.reasonCode === 'INSUFFICIENT_FUNDS' ? 'InsufficientFunds' : p.reasonCode } : {}), paymentRef: p.paymentRef, leg: { accountRef, direction, amount, memo } });
  }

  /** Why the leg cannot move now, or undefined. */
  private refusalFor(l: MirrorLeg, chapterRef: string): MirrorReasonCode | undefined {
    const acct = this.accts.get(l.accountRef);
    if (acct?.kind !== 'member') return 'NOT_FOUND';
    const checking = this.known(chapterRef);
    if (acct.status !== 'open' || checking.status !== 'open') return 'ACCOUNT_UNAVAILABLE';
    const from = l.direction === 'to_checking' ? acct : checking;
    return from.balance - from.hold < l.amount.minor ? 'INSUFFICIENT_FUNDS' : undefined;
  }

  private apply(p: Payment): void {
    const l = p.leg;
    const acct = this.known(l.accountRef);
    const checking = this.known(p.chapterRef);
    const toMember = l.direction === 'from_checking';
    acct.balance += toMember ? l.amount.minor : -l.amount.minor;
    checking.balance += toMember ? -l.amount.minor : l.amount.minor;
    this.rows.push(
      { transactionRef: this.ids.txn.next(), accountRef: l.accountRef, direction: toMember ? 'credit' : 'debit', amount: l.amount, counterpartyAccountRef: p.chapterRef, description: l.memo, at: p.at },
      { transactionRef: this.ids.txn.next(), accountRef: p.chapterRef, direction: toMember ? 'debit' : 'credit', amount: l.amount, counterpartyAccountRef: l.accountRef, description: l.memo, at: p.at },
    );
  }

  private bookOne(l: MirrorLeg, chapterRef: string): MirrorLegResult {
    const prior = this.byKey.get(l.idempotencyKey);
    if (prior) return this.echo(prior);
    if (!isMirrorMemo(l.memo)) return { status: 'refused', reasonCode: 'VALIDATION_ERROR' };
    const key = l.idempotencyKey;
    const forced = this.refusals.get(key);
    const vendor = this.vendorStatuses.get(key);
    const lost = this.lost.has(key);
    this.refusals.delete(key);
    this.vendorStatuses.delete(key);
    this.lost.delete(key);
    const p: Payment = { paymentRef: this.ids.pay.next(), key, chapterRef, leg: { ...l }, status: 'sent', at: this.clock.now() };
    const reason = forced ?? (vendor === 'Rejected' ? 'INSUFFICIENT_FUNDS' : vendor === 'Pending' ? undefined : this.refusalFor(l, chapterRef));
    // Refused before persistence: no payment id, not listed, nothing kept for the key.
    if (reason && !MIRROR_PERSISTED_REFUSALS.includes(reason)) return { status: 'refused', reasonCode: reason };
    if (reason) {
      p.status = 'failed';
      p.reasonCode = reason;
    } else if (vendor === 'Pending') p.status = 'pending';
    this.payList.push(p);
    this.byKey.set(key, p);
    if (p.status === 'sent') this.apply(p);
    if (lost && p.status === 'sent') return { status: 'unknown' };
    return this.echo(p);
  }

  async readBack(input: { chapterRef: string; memo: string; accountRef?: string; direction?: MirrorDirection; amount?: Money; since?: Date }): Promise<MirrorReadBack> {
    this.up();
    const found = this.payList.filter(
      (p) =>
        p.chapterRef === input.chapterRef &&
        p.leg.memo === input.memo &&
        (input.accountRef === undefined || p.leg.accountRef === input.accountRef) &&
        (input.direction === undefined || p.leg.direction === input.direction) &&
        (input.amount === undefined || (p.leg.amount.currency === input.amount.currency && p.leg.amount.minor === input.amount.minor)) &&
        (input.since === undefined || p.at >= input.since),
    );
    const [only] = found;
    if (!only) return { status: 'not_found' };
    return found.length > 1 ? { status: 'ambiguous', candidates: found.map((p) => this.echo(p)) } : { status: 'found', result: this.echo(only) };
  }

  private view(ref: string, kind: Acct['kind']): MirrorBalance {
    const a = this.accts.get(ref);
    if (a?.kind !== kind) throw new MirrorError('NOT_FOUND', kind === 'chapter' ? 'Unknown chapter' : 'Unknown account');
    return { status: a.status, balance: a.balance, hold: a.hold, available: a.balance - a.hold };
  }
  async checkingBalance(chapterRef: string): Promise<MirrorBalance> {
    this.up();
    return this.view(chapterRef, 'chapter');
  }
  async accountBalance(accountRef: string): Promise<MirrorBalance> {
    this.up();
    return this.view(accountRef, 'member');
  }

  async *payments(input: { chapterRef: string; from: Date; to: Date; since?: Date }): AsyncIterable<MirrorPayment> {
    this.up();
    const lower = input.since && input.since > input.from ? input.since : input.from;
    const inRange = this.payList.filter((p) => p.chapterRef === input.chapterRef && p.at >= lower && p.at < input.to);
    for (let i = 0; i < inRange.length; i += this.pageSize) {
      for (const p of inRange.slice(i, i + this.pageSize)) {
        const toMember = p.leg.direction === 'from_checking';
        yield {
          paymentRef: p.paymentRef,
          status: p.status,
          amount: p.leg.amount,
          memo: p.leg.memo,
          sourceAccountRef: toMember ? p.chapterRef : p.leg.accountRef,
          destinationAccountRef: toMember ? p.leg.accountRef : p.chapterRef,
          createdAt: p.at,
        };
      }
    }
  }

  async *movements(input: { from: Date; to: Date }): AsyncIterable<MirrorMovement> {
    this.up();
    const inRange = this.rows.filter((r) => r.at >= input.from && r.at < input.to);
    for (let i = 0; i < inRange.length; i += this.pageSize) {
      for (const row of inRange.slice(i, i + this.pageSize)) yield { ...row, amount: money(row.amount.minor, 'USD') };
    }
  }
}
