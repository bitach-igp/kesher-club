// MirrorPort simulator (T-0718). A chapter's checking account and its members' accounts in memory, bigint cents.
// The panel's hooks: `openChapter(chapterRef, minor)` makes a checking account, `openAccount(accountRef, minor)` a member's
// open account. Deterministic failure fixtures, by the leg's idempotency key or the account:
// - `refuse(key, code)`: the leg with that key is refused with that code, once it is sent;
// - `loseAnswer(key)`: the leg books, then its answer is lost (`unknown`); a resend or a read-back finds it booked;
// - `freeze(accountRef, on = true)`: legs on that account are refused ACCOUNT_UNAVAILABLE (M10: the account must be open);
// - `outage(on)`: every call answers PROVIDER_UNAVAILABLE and nothing moves.
// A leg is refused INSUFFICIENT_FUNDS when the account it draws from would go below zero, NOT_FOUND for an account the
// vendor does not know, and VALIDATION_ERROR for a memo over 80 printable ASCII characters (that one is not kept for its key).
import { type Money, money } from '@kesher/domain';
import { type Clock, fixedClock, Sequence } from './base.ts';
import {
  type MirrorLeg,
  type MirrorLegResult,
  type MirrorMovement,
  type MirrorPort,
  type MirrorReadBack,
  type MirrorReasonCode,
  MirrorError,
  isMirrorMemo,
  validateMirrorBatch,
} from './mirror.ts';

interface Account {
  balance: bigint;
  open: boolean;
}
interface Booked {
  status: 'booked' | 'refused';
  reasonCode?: MirrorReasonCode;
  paymentRef?: string;
}

export class MirrorSimulator implements MirrorPort {
  readonly clock: Clock;
  private readonly pageSize: number;
  private readonly chapters = new Map<string, bigint>();
  private readonly accounts = new Map<string, Account>();
  private readonly results = new Map<string, Booked>();
  private readonly rows: MirrorMovement[] = [];
  private readonly refusals = new Map<string, MirrorReasonCode>();
  private readonly lost = new Set<string>();
  private down = false;
  private readonly ids = { pay: new Sequence('bkp'), txn: new Sequence('mtx') };

  /** `pageSize` is the vendor's page: small values make `movements` cross page boundaries in tests. */
  constructor(opts: { clock?: Clock; pageSize?: number } = {}) {
    this.clock = opts.clock ?? fixedClock();
    this.pageSize = Math.max(1, opts.pageSize ?? 100);
  }

  openChapter(chapterRef: string, minor: bigint): void {
    this.chapters.set(chapterRef, minor);
  }
  openAccount(accountRef: string, minor = 0n): void {
    this.accounts.set(accountRef, { balance: minor, open: true });
  }
  refuse(key: string, code: MirrorReasonCode): void {
    this.refusals.set(key, code);
  }
  loseAnswer(key: string): void {
    this.lost.add(key);
  }
  freeze(accountRef: string, on = true): void {
    const a = this.accounts.get(accountRef);
    if (a) a.open = !on;
  }
  outage(on: boolean): void {
    this.down = on;
  }

  private up(): void {
    if (this.down) throw new MirrorError('PROVIDER_UNAVAILABLE', 'Simulated provider outage');
  }

  async bookBatch(legs: MirrorLeg[], chapterRef: string): Promise<MirrorLegResult[]> {
    validateMirrorBatch(legs);
    this.up();
    if (!this.chapters.has(chapterRef)) throw new MirrorError('NOT_FOUND', 'Unknown chapter');
    return legs.map((l) => this.bookOne(l, chapterRef));
  }

  private bookOne(l: MirrorLeg, chapterRef: string): MirrorLegResult {
    const prior = this.results.get(l.idempotencyKey);
    if (prior) return { ...prior };
    if (!isMirrorMemo(l.memo)) return { status: 'refused', reasonCode: 'VALIDATION_ERROR' };
    const refuse = (reasonCode: MirrorReasonCode): MirrorLegResult => {
      const r: Booked = { status: 'refused', reasonCode };
      this.results.set(l.idempotencyKey, r);
      return { ...r };
    };
    const forced = this.refusals.get(l.idempotencyKey);
    if (forced) return refuse(forced);
    const acct = this.accounts.get(l.accountRef);
    if (!acct) return refuse('NOT_FOUND');
    if (!acct.open) return refuse('ACCOUNT_UNAVAILABLE');
    const checking = this.chapters.get(chapterRef) ?? 0n;
    const draws = l.direction === 'to_checking' ? acct.balance : checking;
    if (draws < l.amount.minor) return refuse('INSUFFICIENT_FUNDS');
    const sign = l.direction === 'to_checking' ? -1n : 1n;
    acct.balance += sign * l.amount.minor;
    this.chapters.set(chapterRef, checking - sign * l.amount.minor);
    const paymentRef = this.ids.pay.next();
    this.results.set(l.idempotencyKey, { status: 'booked', paymentRef });
    const at = this.clock.now();
    const toMember = l.direction === 'from_checking';
    this.rows.push(
      { transactionRef: this.ids.txn.next(), accountRef: l.accountRef, direction: toMember ? 'credit' : 'debit', amount: l.amount, counterpartyAccountRef: chapterRef, description: l.memo, at },
      { transactionRef: this.ids.txn.next(), accountRef: chapterRef, direction: toMember ? 'debit' : 'credit', amount: l.amount, counterpartyAccountRef: l.accountRef, description: l.memo, at },
    );
    if (this.lost.delete(l.idempotencyKey)) return { status: 'unknown' };
    return { status: 'booked', paymentRef };
  }

  async readBack(idempotencyKey: string): Promise<MirrorReadBack> {
    this.up();
    const r = this.results.get(idempotencyKey);
    return r ? { ...r } : { status: 'not_found' };
  }

  async checkingBalance(chapterRef: string): Promise<{ balance: bigint }> {
    this.up();
    const b = this.chapters.get(chapterRef);
    if (b === undefined) throw new MirrorError('NOT_FOUND', 'Unknown chapter');
    return { balance: b };
  }

  async accountBalance(accountRef: string): Promise<{ balance: bigint }> {
    this.up();
    const a = this.accounts.get(accountRef);
    if (!a) throw new MirrorError('NOT_FOUND', 'Unknown account');
    return { balance: a.balance };
  }

  async *movements(input: { from: Date; to: Date }): AsyncIterable<MirrorMovement> {
    this.up();
    const inRange = this.rows.filter((r) => r.at >= input.from && r.at < input.to);
    for (let i = 0; i < inRange.length; i += this.pageSize) {
      for (const row of inRange.slice(i, i + this.pageSize)) yield { ...row, amount: money(row.amount.minor, 'USD') as Money };
    }
  }
}
