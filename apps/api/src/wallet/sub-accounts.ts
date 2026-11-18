// Member sub-accounts (T-0752, REQ-WAL-002, ADR-018 condition 2 of "Decision, 2026-11-18"): a member's account is a sub-account under the
// nonprofit, opened only for a stated exempt purpose. `SubAccountService.open` is the one place that decides whether to ask the vendor.
//
// The guard, in order, each step before any vendor call or row:
//   1. the flag `wallet.subAccounts` (off by default) and a funding binding that implements MemberSubAccountPort: else FEATURE_OFF;
//   2. the purpose is in the configured list (`SUB_ACCOUNT_PURPOSES`, counsel's T-0759, NO default: an empty list refuses everything);
//   3. `eligible(partyId)` (default: refuse, so a minor can never get one by accident; the age is the owner's decision, T-0738 I4);
//   4. the refs in ops.external_ref are read: found, the answer is those refs and nobody is asked;
//   5. the owner details (T-0738's reader) or an invitation email: none is `detailsRequired`.
// Then ONE port call under `funding-subaccount:{partyId}:{purpose}`, a frozen or closed answer refuses (naming the status, writing no refs so
// a later open asks again), and both refs are written `on conflict do nothing` (vendor ids live only in ops.external_ref).
// ops.external_ref is unique per (entity type, party, provider), so one party holds one sub-account ref pair: a second PURPOSE for the same
// member finds that pair at step 4 (see the PR note). The refs are the service's answer, never an HTTP response body.
// An owner the vendor refused still returns the sub-account and opens one case for staff, with the party id and nothing personal.
// Port errors (QUOTA_EXCEEDED and the rest) propagate unchanged; T-0753 maps them. Nothing here logs, and no error carries personal data.
import { DomainError, uuidv7 } from '@kesher/domain';
import { isMemberSubAccountPort, type MemberSubAccountStatus, type SubAccountOwner, type SubAccountOwnerStatus } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';

export const SUB_ACCOUNTS_FLAG = 'wallet.subAccounts';
export const SUBACCOUNT_REF = 'funding_subaccount';
export const SUBACCOUNT_ACCOUNT_REF = 'funding_account';
export const OWNER_FAILED_CASE = 'subaccount_owner_failed';

/** What T-0738's reader gives: the owner contact, or an email to invite instead. Never both. */
export type SubAccountOwnerDetails = { owner: SubAccountOwner; inviteEmail?: undefined } | { inviteEmail: string; owner?: undefined };

/** T-0738's `details.read` reshaped for sub-accounts; `undefined` when the member has stored nothing. */
export interface OwnerDetailsReader {
  read(partyId: string): Promise<SubAccountOwnerDetails | undefined>;
}

export const subAccountKey = (partyId: string, purpose: string): string => `funding-subaccount:${partyId}:${purpose}`;
export const ownerCaseKey = (partyId: string): string => `subaccount-owner:${partyId}`;

export interface SubAccountServiceDeps {
  db: Database;
  flags: FeatureFlags;
  /** The funding binding, checked with `isMemberSubAccountPort`. */
  funding: unknown;
  details: OwnerDetailsReader;
  /** `SUB_ACCOUNT_PURPOSES`: the exempt purposes. No default; empty refuses every purpose. */
  purposes: readonly string[];
  /** The ops.external_ref provider name. */
  provider: string;
  /** Default: nobody is eligible. */
  eligible?: (partyId: string) => Promise<boolean>;
}

export interface OpenedSubAccount {
  subAccountRef: string;
  accountRef: string;
  /** False when the refs were already stored and the vendor was not asked. */
  created: boolean;
  /** Present on a first open only (a replay asks nobody). */
  status?: MemberSubAccountStatus | undefined;
  ownerStatus?: SubAccountOwnerStatus | undefined;
}

const BLOCKED: readonly MemberSubAccountStatus[] = ['frozen', 'closed'];

export class SubAccountService {
  private readonly d: SubAccountServiceDeps;
  constructor(deps: SubAccountServiceDeps) {
    this.d = deps;
  }

  async open(input: { partyId: string; purpose: string }, now: Date): Promise<OpenedSubAccount> {
    const { db, provider } = this.d;
    const port = this.d.funding;
    if (!(await this.d.flags.isOn(SUB_ACCOUNTS_FLAG)) || !isMemberSubAccountPort(port)) throw new DomainError('FEATURE_OFF', 'Member sub-accounts are not enabled yet');

    const wanted = input.purpose.trim().toLowerCase();
    const purpose = wanted === '' ? undefined : this.d.purposes.find((p) => p.trim().toLowerCase() === wanted);
    if (purpose === undefined) throw new DomainError('VALIDATION_FAILED', 'A stated purpose from the allowed list is required', { purposeRequired: true });

    const { partyId } = input;
    if (!this.d.eligible || !(await this.d.eligible(partyId))) throw new DomainError('VALIDATION_FAILED', 'This member cannot have a sub-account', { eligibilityRequired: true });

    const have = await db.query<{ entity_type: string; external_id: string }>(`select entity_type, external_id from ops.external_ref where entity_id = $1 and provider = $2 and entity_type = any($3)`, [partyId, provider, [SUBACCOUNT_REF, SUBACCOUNT_ACCOUNT_REF]]);
    const sub = have.rows.find((r) => r.entity_type === SUBACCOUNT_REF);
    const acct = have.rows.find((r) => r.entity_type === SUBACCOUNT_ACCOUNT_REF);
    if (sub && acct) return { subAccountRef: sub.external_id, accountRef: acct.external_id, created: false };

    const d = await this.d.details.read(partyId);
    if (!d || (!d.owner && !d.inviteEmail)) throw new DomainError('VALIDATION_FAILED', 'Owner details or an invitation email are needed first', { detailsRequired: true });

    const ensured = await port.ensureSubAccount({ partyId, purpose, ...(d.owner ? { owner: d.owner } : { inviteEmail: d.inviteEmail! }) }, subAccountKey(partyId, purpose));
    if (BLOCKED.includes(ensured.status)) throw new DomainError('FEATURE_OFF', `Your sub-account is ${ensured.status}`);

    for (const [type, ref] of [[SUBACCOUNT_REF, ensured.subAccountRef], [SUBACCOUNT_ACCOUNT_REF, ensured.accountRef]] as const) {
      await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ($1, $2, $3, $4) on conflict do nothing`, [type, partyId, provider, ref]);
    }
    if (ensured.ownerStatus === 'failed') {
      // For people: the party id and nothing personal, so staff can re-invite.
      await db.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, 'medium', 'open', $4, $5) on conflict (dedupe_key) do nothing`, [uuidv7(now), OWNER_FAILED_CASE, ownerCaseKey(partyId), { partyId }, now]);
    }
    return { subAccountRef: ensured.subAccountRef, accountRef: ensured.accountRef, created: true, status: ensured.status, ownerStatus: ensured.ownerStatus };
  }
}
