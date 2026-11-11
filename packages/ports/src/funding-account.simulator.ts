// FundingAccountPort simulator (T-0698). Stateful: contacts and wallet accounts live in memory. Fixtures by the contact's email:
// `rejected@example.test` -> status rejected, `frozen@example.test` -> status frozen, `outage@example.test` -> PROVIDER_UNAVAILABLE.
// A second party with a mobile already in use answers DUPLICATE_MOBILE. Controls (the vendor's side, for tests): credit, debit,
// setHold, setHeld, setStatus. The chapter's `checking` is the sum of every account's balance. Nothing here logs, and no error
// message carries the personal data passed in.
import { money } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import {
  FundingAccountError,
  type EnsureAccountInput,
  type EnsuredAccount,
  type FundingAccountPort,
  type FundingAccountStatus,
  type FundingAccountView,
  type FundingChapterView,
  type FundingTransaction,
} from './funding-account.ts';

interface Account {
  partyId: string;
  contactRef: string;
  accountRef: string;
  status: FundingAccountStatus;
  balance: bigint;
  hold: bigint;
  rows: FundingTransaction[];
}

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const USD = (minor: bigint): Money => money(minor, 'USD');

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

function fail(code: ConstructorParameters<typeof FundingAccountError>[0], message: string): never {
  throw new FundingAccountError(code, message);
}

export class FundingAccountSimulator implements FundingAccountPort {
  private readonly byParty = new Map<string, Account>();
  private readonly byRef = new Map<string, Account>();
  private readonly mobiles = new Map<string, string>();
  /** key -> the party it first answered for, so a replay with that key is the same account. */
  private readonly idem = new IdempotencyStore<string>();
  private readonly contactIds = new Sequence('contact');
  private readonly accountIds = new Sequence('acct');
  private readonly txIds = new Sequence('tx');
  private held = 0n;

  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  async ensureAccount(input: EnsureAccountInput, idempotencyKey: string): Promise<EnsuredAccount> {
    const i = input as Partial<Record<keyof EnsureAccountInput, unknown>>;
    const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    if (!text(i.partyId)) fail('VALIDATION_FAILED', 'partyId is required');
    if (!text(i.firstName) || !text(i.lastName)) fail('VALIDATION_FAILED', 'A first and last name are required');
    if (typeof i.email !== 'string' || !EMAIL.test(i.email)) fail('VALIDATION_FAILED', 'email is not valid');
    if (typeof i.mobile !== 'string' || !E164.test(i.mobile)) fail('VALIDATION_FAILED', 'mobile must be E.164');
    if (i.dateOfBirth !== undefined && (typeof i.dateOfBirth !== 'string' || !validDate(i.dateOfBirth))) fail('VALIDATION_FAILED', 'dateOfBirth must be YYYY-MM-DD');
    const { partyId, email, mobile } = input;
    const first = this.idem.has(idempotencyKey);
    const owner = this.mobiles.get(mobile);
    if (!first && owner !== undefined && owner !== partyId) fail('DUPLICATE_MOBILE', 'The mobile number is already used by another contact');
    if (!first && email.toLowerCase() === 'outage@example.test') fail('PROVIDER_UNAVAILABLE', 'Simulated funding vendor outage');
    const keyParty = await this.idem.run(idempotencyKey, async () => {
      if (!this.byParty.has(partyId)) {
        const status: FundingAccountStatus = email.toLowerCase() === 'rejected@example.test' ? 'rejected' : email.toLowerCase() === 'frozen@example.test' ? 'frozen' : 'open';
        const a: Account = { partyId, contactRef: this.contactIds.next(), accountRef: this.accountIds.next(), status, balance: 0n, hold: 0n, rows: [] };
        this.byParty.set(partyId, a);
        this.byRef.set(a.accountRef, a);
        this.mobiles.set(mobile, partyId);
      }
      return partyId;
    });
    const a = this.byParty.get(keyParty)!;
    return { contactRef: a.contactRef, accountRef: a.accountRef, status: a.status };
  }

  async account(accountRef: string): Promise<FundingAccountView> {
    const a = this.get(accountRef);
    return { status: a.status, balance: USD(a.balance), hold: USD(a.hold), available: USD(a.balance - a.hold) };
  }

  async chapter(): Promise<FundingChapterView> {
    let checking = 0n;
    for (const a of this.byRef.values()) checking += a.balance;
    return { checking: USD(checking), held: USD(this.held) };
  }

  async *transactions(input: { accountRef: string; from: string; to: string }): AsyncGenerator<FundingTransaction> {
    const a = this.get(input.accountRef);
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    if (Number.isNaN(from) || Number.isNaN(to)) fail('VALIDATION_FAILED', 'from and to must be ISO instants');
    for (const row of [...a.rows]) {
      const t = Date.parse(row.postedAt);
      if (t >= from && t < to) yield { ...row };
    }
  }

  // Controls: the vendor's side of the account, for tests.

  /** Puts money on the account and posts one `credit` row. `collectPaymentId` ties it to a collected payment. */
  credit(accountRef: string, amount: Money, collectPaymentId?: string, description = 'Credit'): void {
    this.post(accountRef, 'credit', amount, description, collectPaymentId);
  }

  /** Takes money off the account (never beyond the available balance) and posts one `debit` row. */
  debit(accountRef: string, amount: Money, description = 'Debit'): void {
    this.post(accountRef, 'debit', amount, description);
  }

  /** Sets the part of the balance that is held (0 to the balance). */
  setHold(accountRef: string, amount: Money): void {
    const a = this.get(accountRef);
    this.requireUsd(amount);
    if (amount.minor < 0n || amount.minor > a.balance) fail('VALIDATION_FAILED', 'hold must be between zero and the balance');
    a.hold = amount.minor;
  }

  /** Sets the platform chapter's held collection funds. */
  setHeld(amount: Money): void {
    this.requireUsd(amount);
    if (amount.minor < 0n) fail('VALIDATION_FAILED', 'held must not be negative');
    this.held = amount.minor;
  }

  setStatus(accountRef: string, status: FundingAccountStatus): void {
    this.get(accountRef).status = status;
  }

  private post(accountRef: string, kind: 'credit' | 'debit', amount: Money, description: string, collectPaymentId?: string): void {
    const a = this.get(accountRef);
    this.requireUsd(amount);
    if (amount.minor <= 0n) fail('VALIDATION_FAILED', 'amount must be positive');
    if (kind === 'debit' && amount.minor > a.balance - a.hold) fail('VALIDATION_FAILED', 'amount exceeds the available balance');
    a.balance += kind === 'credit' ? amount.minor : -amount.minor;
    a.rows.push({ transactionRef: this.txIds.next(), kind, amount: USD(amount.minor), postedAt: this.clock.now().toISOString(), description, ...(collectPaymentId ? { collectPaymentId } : {}) });
  }

  private requireUsd(amount: Money): void {
    if (amount.currency !== 'USD') fail('VALIDATION_FAILED', 'only USD is supported');
  }

  private get(accountRef: string): Account {
    const a = this.byRef.get(accountRef);
    if (!a) fail('UNKNOWN_ACCOUNT', 'Unknown account');
    return a;
  }
}
