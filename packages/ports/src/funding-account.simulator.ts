// FundingAccountPort simulator (T-0698). Stateful: contacts and wallet accounts live in memory. Fixtures by the contact's email:
// `rejected@example.test` -> a contact with no account (status rejected), `archived@example.test` -> likewise (archived),
// `frozen@example.test` -> a frozen account, `outage@example.test` -> PROVIDER_UNAVAILABLE. Identity is the mobile, as at the
// vendor. Each key is bound to a hash of its input and personal data is kept only as hashes, never in clear or in an error.
// Controls (the vendor's side, for tests): credit, debit, setHold, setChecking, setStatus. Nothing here logs.
import { createHash } from 'node:crypto';
import { money } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { type Clock, fixedClock, Sequence } from './base.ts';
import {
  FundingAccountError,
  type EnsureAccountInput,
  type EnsuredAccount,
  type FundingAccountPort,
  type FundingAccountStatus,
  type FundingAccountView,
  type FundingChapterView,
  type FundingContactStatus,
  type FundingTransaction,
} from './funding-account.ts';

interface Contact {
  contactRef: string;
  /** Hash of every contact field: a later request for the party must match it. */
  dataHash: string;
  contactStatus: FundingContactStatus | undefined;
  account: Account | undefined;
}

interface Account {
  accountRef: string;
  status: FundingAccountStatus;
  balance: bigint;
  hold: bigint;
  rows: FundingTransaction[];
}

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const USD = (minor: bigint): Money => money(minor, 'USD');
const hash = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

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
  private readonly byParty = new Map<string, Contact>();
  private readonly byMobile = new Map<string, string>();
  private readonly accounts = new Map<string, Account>();
  /** key -> hash of the input it first answered, so a reused key with other input is refused. */
  private readonly keys = new Map<string, string>();
  private readonly contactIds = new Sequence('contact');
  private readonly accountIds = new Sequence('acct');
  private readonly txIds = new Sequence('tx');
  private checking = 0n;

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
    const dataHash = hash(input.firstName, input.lastName, email.toLowerCase(), mobile, input.dateOfBirth ?? '');
    const inputHash = hash(partyId, dataHash);

    const bound = this.keys.get(idempotencyKey);
    if (bound !== undefined && bound !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was used with different input');
    const existing = this.byParty.get(partyId);
    if (bound === undefined) {
      if (existing && existing.dataHash !== dataHash) fail('PARTY_CONFLICT', 'The party already has a contact with different details');
      if (!existing) {
        if (this.byMobile.has(hash(mobile))) fail('DUPLICATE_MOBILE', 'The mobile number belongs to another contact');
        if (email.toLowerCase() === 'outage@example.test') fail('PROVIDER_UNAVAILABLE', 'Simulated funding vendor outage');
        const e = email.toLowerCase();
        const contactStatus: FundingContactStatus | undefined = e === 'rejected@example.test' ? 'rejected' : e === 'archived@example.test' ? 'archived' : undefined;
        const account: Account | undefined = contactStatus ? undefined : { accountRef: this.accountIds.next(), status: e === 'frozen@example.test' ? 'frozen' : 'open', balance: 0n, hold: 0n, rows: [] };
        const c: Contact = { contactRef: this.contactIds.next(), dataHash, contactStatus, account };
        this.byParty.set(partyId, c);
        this.byMobile.set(hash(mobile), partyId);
        if (account) this.accounts.set(account.accountRef, account);
      }
      this.keys.set(idempotencyKey, inputHash);
    }
    const c = this.byParty.get(partyId)!;
    if (c.account) return { contactRef: c.contactRef, accountRef: c.account.accountRef, status: c.account.status };
    return { contactRef: c.contactRef, status: c.contactStatus! };
  }

  async account(accountRef: string): Promise<FundingAccountView> {
    const a = this.get(accountRef);
    return { status: a.status, balance: USD(a.balance), hold: USD(a.hold), available: USD(a.balance - a.hold) };
  }

  async chapter(): Promise<FundingChapterView> {
    return { checking: USD(this.checking) };
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

  /** Puts money on the account and posts one `credit` row. It does not move the chapter's checking (set that with setChecking). */
  credit(accountRef: string, amount: Money, description = 'Credit'): void {
    this.post(accountRef, 'credit', amount, description);
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

  /** Sets the platform chapter's checking balance, independent of the wallets. */
  setChecking(amount: Money): void {
    this.requireUsd(amount);
    this.checking = amount.minor;
  }

  setStatus(accountRef: string, status: FundingAccountStatus): void {
    this.get(accountRef).status = status;
  }

  private post(accountRef: string, kind: 'credit' | 'debit', amount: Money, description: string): void {
    const a = this.get(accountRef);
    this.requireUsd(amount);
    if (amount.minor <= 0n) fail('VALIDATION_FAILED', 'amount must be positive');
    if (kind === 'debit' && amount.minor > a.balance - a.hold) fail('VALIDATION_FAILED', 'amount exceeds the available balance');
    a.balance += kind === 'credit' ? amount.minor : -amount.minor;
    a.rows.push({ transactionRef: this.txIds.next(), kind, amount: USD(amount.minor), postedAt: this.clock.now().toISOString(), description });
  }

  private requireUsd(amount: Money): void {
    if (amount.currency !== 'USD') fail('VALIDATION_FAILED', 'only USD is supported');
  }

  private get(accountRef: string): Account {
    const a = this.accounts.get(accountRef);
    if (!a) fail('UNKNOWN_ACCOUNT', 'Unknown account');
    return a;
  }
}
