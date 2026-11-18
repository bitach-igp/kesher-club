// Member sub-accounts (T-0752, REQ-WAL-002, ADR-018 condition 2 of "Decision, 2026-11-18"): a member's account is a sub-account under the
// nonprofit, opened only for a stated exempt purpose. `SubAccountService.open` is the one place that decides whether to ask the vendor.
//
// The guard, in order, each step before any vendor call or row:
//   1. the flag `wallet.subAccounts` (off by default) and a funding binding that implements MemberSubAccountPort: else FEATURE_OFF;
//   2. the purpose is in the configured list (`SUB_ACCOUNT_PURPOSES`, counsel's T-0759, NO default: an empty list refuses everything);
//   3. `eligible(partyId)` (default: refuse, so a minor can never get one by accident; the age is the owner's decision, T-0738 I4);
//   4. the refs in ops.external_ref are read: found, the answer is those refs and nobody is asked;
//   5. the owner details (T-0738's reader) or an invitation email: none is `detailsRequired`.
// Then ONE port call under `funding-subaccount:{partyId}:{purposeHash}`, a frozen or closed answer refuses (naming the status, writing no refs so
// a later open asks again), and the refs and markers are written in one transaction `on conflict do nothing` (vendor ids live only in ops.external_ref).
// ops.external_ref is unique per (entity type, party, provider), so one party holds one sub-account ref pair. The pair records the purpose it
// was opened for as our own marker row (`funding_subaccount_purpose`, `p:{party}:{hash}`; a stretch of "vendor ids only in external_ref",
// accepted in T-0742, a migration avoided): a replay with another purpose, or a pair with no marker, is IDEMPOTENCY_CONFLICT, never the
// wrong purpose's refs. A failed owner also leaves `funding_subaccount_owner` (`o:{party}:failed`) for load and credit paths to read.
// The refs are the service's answer, never an HTTP response body.
// An owner the vendor refused still returns the sub-account and opens one case for staff, with the party id and nothing personal.
// A full quota (T-0753): the port's QUOTA_EXCEEDED is ONE call, never retried, and answers 503 PROVIDER_UNAVAILABLE with extra.reason
// `subaccount_quota` and fixed text (no new error code, the closed set stays closed; the vendor's words never leave). It writes no ref and
// opens ONE high `ops.case` (dedupe `subaccount-quota`) whose payload is the count of refusals since it opened; a later refusal bumps that
// count, and one that comes after ops resolved the case reopens it with a count of 1. The count is refusals, not distinct members
// (the case holds no party id on purpose). Other port errors propagate unchanged. Nothing here logs, and no error carries personal data.
import { createHash } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import { isMemberSubAccountPort, MemberSubAccountError, type MemberSubAccountStatus, type SubAccountOwner, type SubAccountOwnerStatus } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';

export const SUB_ACCOUNTS_FLAG = 'wallet.subAccounts';
export const SUBACCOUNT_REF = 'funding_subaccount';
export const SUBACCOUNT_ACCOUNT_REF = 'funding_account';
export const OWNER_FAILED_CASE = 'subaccount_owner_failed';
export const QUOTA_FULL_CASE = 'subaccount_quota_full';
export const QUOTA_CASE_KEY = 'subaccount-quota';

/** What T-0738's reader gives: the owner contact, or an email to invite instead. Never both. */
export type SubAccountOwnerDetails = { owner: SubAccountOwner; inviteEmail?: undefined } | { inviteEmail: string; owner?: undefined };

/** T-0738's `details.read` reshaped for sub-accounts; `undefined` when the member has stored nothing. */
export interface OwnerDetailsReader {
  read(partyId: string): Promise<SubAccountOwnerDetails | undefined>;
}

export const SUBACCOUNT_PURPOSE_REF = 'funding_subaccount_purpose';
export const SUBACCOUNT_OWNER_REF = 'funding_subaccount_owner';
const normalize = (purpose: string): string => purpose.trim().toLowerCase();
/** 16 hex characters of the normalized purpose: non-PII, and short enough that the port key stays under 128 characters. */
export const purposeHash = (purpose: string): string => createHash('sha256').update(normalize(purpose)).digest('hex').slice(0, 16);
export const subAccountKey = (partyId: string, purpose: string): string => `funding-subaccount:${partyId}:${purposeHash(purpose)}`;
const purposeMarker = (partyId: string, purpose: string): string => `p:${partyId}:${purposeHash(purpose)}`;
const OTHER_PURPOSE = 'This member already has a sub-account for another purpose';
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

    const wanted = normalize(input.purpose);
    const purpose = wanted === '' ? undefined : this.d.purposes.find((p) => normalize(p) === wanted);
    if (purpose === undefined) throw new DomainError('VALIDATION_FAILED', 'A stated purpose from the allowed list is required', { purposeRequired: true });

    const { partyId } = input;
    if (!this.d.eligible || !(await this.d.eligible(partyId))) throw new DomainError('VALIDATION_FAILED', 'This member cannot have a sub-account', { eligibilityRequired: true });

    const have = await db.query<{ entity_type: string; external_id: string }>(`select entity_type, external_id from ops.external_ref where entity_id = $1 and provider = $2 and entity_type = any($3)`, [partyId, provider, [SUBACCOUNT_REF, SUBACCOUNT_ACCOUNT_REF, SUBACCOUNT_PURPOSE_REF]]);
    const sub = have.rows.find((r) => r.entity_type === SUBACCOUNT_REF);
    const acct = have.rows.find((r) => r.entity_type === SUBACCOUNT_ACCOUNT_REF);
    if (sub && acct) {
      // The pair belongs to the purpose it was opened for; a marker that is missing or names another purpose is never guessed at.
      const marker = have.rows.find((r) => r.entity_type === SUBACCOUNT_PURPOSE_REF);
      if (marker?.external_id !== purposeMarker(partyId, purpose)) throw new DomainError('IDEMPOTENCY_CONFLICT', OTHER_PURPOSE);
      return { subAccountRef: sub.external_id, accountRef: acct.external_id, created: false };
    }

    const d = await this.d.details.read(partyId);
    if (!d || (!d.owner && !d.inviteEmail)) throw new DomainError('VALIDATION_FAILED', 'Owner details or an invitation email are needed first', { detailsRequired: true });

    let ensured;
    try {
      ensured = await port.ensureSubAccount({ partyId, purpose, ...(d.owner ? { owner: d.owner } : { inviteEmail: d.inviteEmail! }) }, subAccountKey(partyId, purpose));
    } catch (e) {
      if (!(e instanceof MemberSubAccountError) || e.code !== 'QUOTA_EXCEEDED') throw e;
      await this.recordQuotaRefusal(now);
      throw new DomainError('PROVIDER_UNAVAILABLE', 'Opening new accounts is paused for now. Please try again later.', { reason: 'subaccount_quota' });
    }
    if (BLOCKED.includes(ensured.status)) throw new DomainError('FEATURE_OFF', `Your sub-account is ${ensured.status}`);

    // One transaction: the refs, the purpose marker, the owner-failed marker and its case stand or fall together.
    const rows: Array<readonly [string, string]> = [[SUBACCOUNT_REF, ensured.subAccountRef], [SUBACCOUNT_ACCOUNT_REF, ensured.accountRef], [SUBACCOUNT_PURPOSE_REF, purposeMarker(partyId, purpose)]];
    if (ensured.ownerStatus === 'failed') rows.push([SUBACCOUNT_OWNER_REF, `o:${partyId}:failed`]);
    await db.transaction(async (tx) => {
      for (const [type, ref] of rows) await tx.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ($1, $2, $3, $4) on conflict do nothing`, [type, partyId, provider, ref]);
      // A racing open for another purpose may have stored its marker first: ours was then skipped, so refuse and roll back.
      const stored = await tx.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = $1 and entity_id = $2 and provider = $3`, [SUBACCOUNT_PURPOSE_REF, partyId, provider]);
      if (stored.rows[0]?.external_id !== purposeMarker(partyId, purpose)) throw new DomainError('IDEMPOTENCY_CONFLICT', OTHER_PURPOSE);
      if (ensured.ownerStatus === 'failed') {
        // For people: the party id and nothing personal, so staff can re-invite.
        await tx.query(`insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, 'medium', 'open', $4, $5) on conflict (dedupe_key) do nothing`, [uuidv7(now), OWNER_FAILED_CASE, ownerCaseKey(partyId), { partyId }, now]);
      }
    });
    return { subAccountRef: ensured.subAccountRef, accountRef: ensured.accountRef, created: true, status: ensured.status, ownerStatus: ensured.ownerStatus };
  }

  /** One case for the whole outage: open it, count another refusal on it while it is open, or reopen it once ops has resolved it. */
  private async recordQuotaRefusal(now: Date): Promise<void> {
    const live = `ops.case.status in ('open', 'investigating')`;
    await this.d.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, 'high', 'open', '{"refused": 1}', $4)
       on conflict (dedupe_key) do update set
         payload = case when ${live} then jsonb_build_object('refused', coalesce((ops.case.payload->>'refused')::int, 0) + 1) else '{"refused": 1}'::jsonb end,
         opened_at = case when ${live} then ops.case.opened_at else excluded.opened_at end,
         status = case when ${live} then ops.case.status else 'open' end,
         resolved_at = case when ${live} then ops.case.resolved_at else null end,
         resolved_by = case when ${live} then ops.case.resolved_by else null end,
         resolution = case when ${live} then ops.case.resolution else null end`,
      [uuidv7(now), QUOTA_FULL_CASE, QUOTA_CASE_KEY, now],
    );
  }
}
