// MemberSubAccountPort (REQ-WAL-002, ADR-018 "Decision, 2026-11-18", option 2): a member's account is a SUB-ACCOUNT, a chapter
// under the nonprofit's chapter, with its own deposit account. A sub-account is a chapter, so the result carries a chapter ref
// that every later call needs. The nonprofit chapter is the ADAPTER's configuration (T-0751) and never crosses this port.
//
// A separate interface in the FundingAccountPort style (T-0698): the funding binding implements it too and it is found by the
// method-exists guard `isMemberSubAccountPort`, so there is no registry capability, catalogue row or provider key.
//
// A sub-account takes exactly one of an `owner` (the person who will run it) or an `inviteEmail`. An owner the vendor refuses
// does not fail the sub-account: it comes back `ownerStatus: 'failed'` and the sub-account is still made and `open`. The port
// never decides whether a purpose is exempt (T-0752's guard, counsel's list T-0759); it only refuses an empty one.
// Personal data (name, email, mobile, date of birth) is passed through and never logged or put in an error message.
import type { Money } from '@kesher/domain';

/** Mapped directly from the vendor's Open, Frozen and Closed. Only `open` is usable. */
export type MemberSubAccountStatus = 'open' | 'frozen' | 'closed';

/** `active`: an owner was attached; `invited`: an invitation was sent; `failed`: the owner was refused (the sub-account exists anyway). */
export type SubAccountOwnerStatus = 'active' | 'invited' | 'failed';

export interface SubAccountOwner {
  firstName: string;
  lastName: string;
  email: string;
  /** E.164, such as +14155550123. */
  mobile: string;
  /** `YYYY-MM-DD`. Passed through, never returned. */
  dateOfBirth?: string;
}

export interface EnsureSubAccountInput {
  /** Our party id: with `purpose`, the identity of the sub-account (one per member and purpose). */
  partyId: string;
  /** Free text naming what the money is for. The port refuses an empty one (`PURPOSE_REQUIRED`) and judges nothing else. */
  purpose: string;
  /** Exactly one of `owner` and `inviteEmail`. */
  owner?: SubAccountOwner;
  inviteEmail?: string;
}

export interface EnsuredSubAccount {
  /** Opaque; `s:<chapterId>` at Crowded. Every later call on the sub-account needs it. */
  subAccountRef: string;
  /** Opaque; `s:<chapterId>:<accountId>` at Crowded: the sub-account's own deposit account. */
  accountRef: string;
  status: MemberSubAccountStatus;
  ownerStatus: SubAccountOwnerStatus;
}

export interface MemberSubAccountView {
  status: MemberSubAccountStatus;
  balance: Money;
  hold: Money;
  /** `balance - hold`. */
  available: Money;
}

export interface MemberSubAccountPort {
  /**
   * Ensures the sub-account for a member and purpose.
   * - The same key with the same input replays; the same key with different input is `IDEMPOTENCY_CONFLICT` and returns no refs.
   * - A second key for the same party and purpose answers the same refs and the current status (one sub-account per member and
   *   purpose, not per call), whatever owner or invitation it carries: changing the owner is not part of this port.
   * - Past the tier limit a create is `QUOTA_EXCEEDED`, before the key is looked at (as the live API does), and creates nothing.
   * - An owner the vendor refuses is returned as `ownerStatus: 'failed'`, never thrown.
   */
  ensureSubAccount(input: EnsureSubAccountInput, idempotencyKey: string): Promise<EnsuredSubAccount>;
  /** `UNKNOWN_ACCOUNT` for a ref that is not a sub-account. */
  subAccount(subAccountRef: string): Promise<MemberSubAccountView>;
}

/** Port-level codes: the closed domain error set is unchanged; T-0753 maps these later. */
export type MemberSubAccountErrorCode = 'VALIDATION_FAILED' | 'PURPOSE_REQUIRED' | 'QUOTA_EXCEEDED' | 'UNKNOWN_ACCOUNT' | 'IDEMPOTENCY_CONFLICT' | 'PROVIDER_UNAVAILABLE';

/** Messages are fixed text: they never carry the personal data that was passed in. */
export class MemberSubAccountError extends Error {
  readonly code: MemberSubAccountErrorCode;
  constructor(code: MemberSubAccountErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MemberSubAccountError';
  }
}

/** True when a funding binding also implements MemberSubAccountPort (the capability is optional, as FundingAccountPort is). */
export function isMemberSubAccountPort(port: unknown): port is MemberSubAccountPort {
  const p = port as Partial<Record<keyof MemberSubAccountPort, unknown>> | null | undefined;
  return !!p && typeof p.ensureSubAccount === 'function' && typeof p.subAccount === 'function';
}
