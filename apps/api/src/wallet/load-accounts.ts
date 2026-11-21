// The hosted-load funding account (T-0740, ADR-018 A1/A2), split from loads.ts (T-0767): the payer's contact and wallet account at the vendor,
// made once and read back through ops.external_ref. Moved from LoadService with the SQL, the keys, the order of the checks and the error text
// unchanged; the functions take the narrow slice of `Deps` they read. The funding details are personal data: never logged, thrown or stored here.
import { DomainError } from '@kesher/domain';
import { FundingAccountError, type FundingAccountPort } from '@kesher/ports';
import type { Database } from '../db.ts';
import { openCase } from '../ops/cases.ts';
import { linkRef, refOf } from '../ops/external-ref.ts';

/** The part of `LoadService`'s dependencies the funding-account step reads. */
export interface AccountDeps {
  db: Database;
  /** Registry provider name, the key space of ops.external_ref. */
  provider: string;
  fundingAccounts?: FundingAccountPort | undefined;
  details?: { read(partyId: string): Promise<FundingDetails | undefined> } | undefined;
}

export interface FundingDetails {
  firstName: string;
  lastName: string;
  email: string;
  /** E.164. */
  mobile: string;
  dateOfBirth?: string;
}

/** The idempotency key of a member's funding account at the vendor: stable per party, so a retry is the same account. */
export const fundingAccountKey = (partyId: string): string => `funding-account:${partyId}`;
const FUNDING_REF_TYPES = ['funding_contact', 'funding_account'] as const;
const BLOCKED_ACCOUNT_STATUSES = ['rejected', 'archived', 'frozen', 'closed'];

export async function contactRef(deps: AccountDeps, partyId: string): Promise<string> {
  const ref = await refOf(deps.db, 'funding_contact', partyId, deps.provider);
  if (ref === undefined) throw new DomainError('FEATURE_OFF', 'Your funding account is not set up yet');
  return ref;
}

/**
 * The payer's contact and wallet account at the vendor, made once (T-0740, ADR-018 A1/A2). The refs in ops.external_ref are read first, so
 * the second hosted load asks nobody; otherwise the details are read, `ensureAccount` runs under `funding-account:{partyId}`, and both
 * refs are written. The vendor is the KYC authority: a rejected, archived, frozen or closed answer refuses the load, naming the status only.
 */
export async function ensureFundingAccount(deps: AccountDeps, partyId: string, now: Date): Promise<void> {
  const { fundingAccounts, details } = deps;
  if (!fundingAccounts || !details) throw new DomainError('FEATURE_OFF', 'Hosted loads are not enabled yet');
  const have = await deps.db.query<{ entity_type: string }>(`select entity_type from ops.external_ref where entity_id = $1 and provider = $2 and entity_type = any($3)`, [partyId, deps.provider, [...FUNDING_REF_TYPES]]);
  if (FUNDING_REF_TYPES.every((t) => have.rows.some((r) => r.entity_type === t))) return;
  const d = await details.read(partyId);
  if (!d) throw new DomainError('VALIDATION_FAILED', 'Your funding details are needed first', { detailsRequired: true });
  let ensured;
  try {
    ensured = await fundingAccounts.ensureAccount({ partyId, firstName: d.firstName, lastName: d.lastName, email: d.email, mobile: d.mobile, ...(d.dateOfBirth ? { dateOfBirth: d.dateOfBirth } : {}) }, fundingAccountKey(partyId));
  } catch (e) {
    if (!(e instanceof FundingAccountError)) throw e;
    if (e.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('PROVIDER_UNAVAILABLE', 'Funding is temporarily unavailable; try again with the same key');
    if (e.code === 'DUPLICATE_MOBILE' || e.code === 'PARTY_CONFLICT' || e.code === 'IDEMPOTENCY_CONFLICT') {
      // For people: the case carries the party and the code, never a name, number or vendor text.
      await openCase(deps.db, { kind: 'load_account_conflict', dedupeKey: fundingAccountKey(partyId), severity: 'medium', payload: { partyId, code: e.code }, now });
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Your funding account could not be set up; support has been told');
    }
    throw new DomainError('VALIDATION_FAILED', 'Your funding details were not accepted', { detailsRequired: true });
  }
  if (!('accountRef' in ensured) || BLOCKED_ACCOUNT_STATUSES.includes(ensured.status)) throw new DomainError('FEATURE_OFF', `Your funding account is ${ensured.status}`);
  for (const [type, ref] of [['funding_contact', ensured.contactRef], ['funding_account', ensured.accountRef]] as const) {
    await linkRef(deps.db, { entityType: type, entityId: partyId, provider: deps.provider, externalId: ref });
  }
}
