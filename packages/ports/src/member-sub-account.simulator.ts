// MemberSubAccountPort simulator (T-0750). Stateful: sub-accounts live in memory. Fixtures by the owner's (or the invitation's)
// email: `ownerfail@example.test` -> the owner is refused (ownerStatus failed) but the sub-account is made and open,
// `frozen@example.test` -> a frozen sub-account, `outage@example.test` -> PROVIDER_UNAVAILABLE. Refs mimic Crowded's:
// `s:<chapter>` and `s:<chapter>:<account>`. Each key is bound to a hash of its input; personal data is kept only as hashes,
// never in clear or in an error. Fixtures apply on the first create only; a repeated owner mobile is never refused here. Controls (the vendor's side, for tests): setQuota, credit, setHold, setStatus. Nothing here logs.
import { createHash } from 'node:crypto';
import { money } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { Sequence } from './base.ts';
import {
  MemberSubAccountError,
  type EnsureSubAccountInput,
  type EnsuredSubAccount,
  type MemberSubAccountPort,
  type MemberSubAccountStatus,
  type MemberSubAccountView,
  type SubAccountOwnerStatus,
} from './member-sub-account.ts';

interface SubAccount {
  ref: EnsuredSubAccount;
  balance: bigint;
  hold: bigint;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
/** Ref charset: what a chapter or account id at the vendor may contain. Anything else is not a ref. */
const REF = /^s:([A-Za-z0-9_-]{1,64})$/;
/** Caps. partyId: the vendor's sub-account name is `Member {partyId}` with a 255 maximum, so 128 leaves ample room. */
const MAX = { partyId: 128, purpose: 200, name: 100, email: 254 };
const USD = (minor: bigint): Money => money(minor, 'USD');
const hash = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

function fail(code: ConstructorParameters<typeof MemberSubAccountError>[0], message: string): never {
  throw new MemberSubAccountError(code, message);
}

export class MemberSubAccountSimulator implements MemberSubAccountPort {
  private readonly byMemberPurpose = new Map<string, SubAccount>();
  private readonly byRef = new Map<string, SubAccount>();
  /** key -> hash of the input it first answered, so a reused key with other input is refused. */
  private readonly keys = new Map<string, string>();
  private readonly chapterIds = new Sequence('ch');
  private readonly accountIds = new Sequence('ac');
  private quota = Number.POSITIVE_INFINITY;

  async ensureSubAccount(input: EnsureSubAccountInput, idempotencyKey: string): Promise<EnsuredSubAccount> {
    const i = input as Partial<Record<keyof EnsureSubAccountInput, unknown>>;
    const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    if (!text(i.partyId) || i.partyId.length > MAX.partyId) fail('VALIDATION_FAILED', 'partyId is required and must not be too long');
    if (!text(i.purpose)) fail('PURPOSE_REQUIRED', 'A purpose is required');
    if (i.purpose.length > MAX.purpose) fail('VALIDATION_FAILED', 'purpose is too long');
    const hasOwner = i.owner !== undefined;
    const hasInvite = i.inviteEmail !== undefined;
    if (hasOwner === hasInvite) fail('VALIDATION_FAILED', 'Exactly one of owner and inviteEmail is required');
    let email: string;
    let ownerHash: string;
    if (hasOwner) {
      const o = i.owner as Partial<Record<string, unknown>> | null;
      if (typeof o !== 'object' || o === null) fail('VALIDATION_FAILED', 'owner is not valid');
      if (!text(o.firstName) || !text(o.lastName)) fail('VALIDATION_FAILED', 'A first and last name are required');
      if (o.firstName.length > MAX.name || o.lastName.length > MAX.name) fail('VALIDATION_FAILED', 'A name is too long');
      if (typeof o.email !== 'string' || o.email.length > MAX.email || !EMAIL.test(o.email)) fail('VALIDATION_FAILED', 'email is not valid');
      if (typeof o.mobile !== 'string' || !E164.test(o.mobile)) fail('VALIDATION_FAILED', 'mobile must be E.164');
      if (o.dateOfBirth !== undefined && (typeof o.dateOfBirth !== 'string' || !validDate(o.dateOfBirth))) fail('VALIDATION_FAILED', 'dateOfBirth must be YYYY-MM-DD');
      email = o.email.toLowerCase();
      ownerHash = hash('owner', o.firstName, o.lastName, email, o.mobile, typeof o.dateOfBirth === 'string' ? o.dateOfBirth : '');
    } else {
      if (typeof i.inviteEmail !== 'string' || i.inviteEmail.length > MAX.email || !EMAIL.test(i.inviteEmail)) fail('VALIDATION_FAILED', 'inviteEmail is not valid');
      email = i.inviteEmail.toLowerCase();
      ownerHash = hash('invite', email);
    }
    const partyId = i.partyId;
    const purpose = i.purpose.trim();
    const inputHash = hash(partyId, purpose, ownerHash);

    const memberKey = hash(partyId, purpose.toLowerCase());
    const existing = this.byMemberPurpose.get(memberKey);
    // The quota is the live API's 429 on a create: it comes before the key is looked at, and only a create can hit it.
    if (!existing && this.byRef.size >= this.quota) fail('QUOTA_EXCEEDED', 'The sub-account limit has been reached');
    const bound = this.keys.get(idempotencyKey);
    if (bound !== undefined && bound !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was used with different input');
    if (bound === undefined) {
      if (!existing) {
        if (email === 'outage@example.test') fail('PROVIDER_UNAVAILABLE', 'Simulated funding vendor outage');
        const chapter = this.chapterIds.next();
        const ownerStatus: SubAccountOwnerStatus = email === 'ownerfail@example.test' ? 'failed' : hasOwner ? 'active' : 'invited';
        const status: MemberSubAccountStatus = email === 'frozen@example.test' ? 'frozen' : 'open';
        const sa: SubAccount = { ref: { subAccountRef: `s:${chapter}`, accountRef: `s:${chapter}:${this.accountIds.next()}`, status, ownerStatus }, balance: 0n, hold: 0n };
        this.byMemberPurpose.set(memberKey, sa);
        this.byRef.set(sa.ref.subAccountRef, sa);
      }
      this.keys.set(idempotencyKey, inputHash);
    }
    return { ...this.byMemberPurpose.get(memberKey)!.ref };
  }

  async subAccount(subAccountRef: string): Promise<MemberSubAccountView> {
    const a = this.get(subAccountRef);
    return { status: a.ref.status, balance: USD(a.balance), hold: USD(a.hold), available: USD(a.balance - a.hold) };
  }

  // Controls: the vendor's side, for tests.

  /** Allows `n` sub-accounts in all; the create past that answers QUOTA_EXCEEDED. */
  setQuota(n: number): void {
    this.quota = n;
  }

  /** Puts money on the sub-account's deposit account. */
  credit(subAccountRef: string, amount: Money): void {
    const a = this.get(subAccountRef);
    this.requireUsd(amount);
    if (amount.minor <= 0n) fail('VALIDATION_FAILED', 'amount must be positive');
    a.balance += amount.minor;
  }

  /** Sets the part of the balance that is held (0 to the balance). */
  setHold(subAccountRef: string, amount: Money): void {
    const a = this.get(subAccountRef);
    this.requireUsd(amount);
    if (amount.minor < 0n || amount.minor > a.balance) fail('VALIDATION_FAILED', 'hold must be between zero and the balance');
    a.hold = amount.minor;
  }

  setStatus(subAccountRef: string, status: MemberSubAccountStatus): void {
    this.get(subAccountRef).ref.status = status;
  }

  private requireUsd(amount: Money): void {
    if (amount.currency !== 'USD') fail('VALIDATION_FAILED', 'only USD is supported');
  }

  private get(subAccountRef: string): SubAccount {
    const m = typeof subAccountRef === 'string' ? REF.exec(subAccountRef) : null;
    const a = m ? this.byRef.get(subAccountRef) : undefined;
    if (!a) fail('UNKNOWN_ACCOUNT', 'Unknown account');
    return a;
  }
}
