// The vendor credit step of a load (T-0766, split from loads.ts): the credit keys and the typed markers that record an attempt (T-0761,
// T-0742; in ops.workflow_marker since T-0769), the failed-owner block (T-0763), the account gate, the credit before the journal (T-0705, ADR-018 A4/M1) and the read of whether
// the vendor may already hold a load's money. Moved from LoadService with the SQL, the keys, the ordering of the early returns and the
// error text unchanged. The step takes the narrow slice of `Deps` it uses and returns `{ proceed, credited, refused }`; `LoadService` keeps
// the `credits` and `refusals` counters the sweep report reads and adds what the step says happened.
import { DomainError } from '@kesher/domain';
import { FundingAccountError, FundingError, type CreditResult, type FundingAccountPort, type FundingCreditPort, type Load as VendorLoad } from '@kesher/ports';
import type { Database } from '../db.ts';
import { openCase } from '../ops/cases.ts';
import { getMarker, getMarkers, putMarker } from '../ops/workflow-marker.ts';
import type { Transfer } from '../transfers/service.ts';
import { creditCase, openCreditCase } from './load-cases.ts';
import { mapFundingError } from './load-model.ts';
import { isOwnerFailedMarker } from './sub-account-markers.ts';
import { OWNER_FAILED_CASE, ownerCaseKey, ownerKind } from './sub-accounts.ts';

/** The vendor credit's key (T-0705): a refusal is final for its key at the vendor, so a retry after one is the next `n`. */
export const creditKey = (workflowId: string, n: number): string => `${workflowId}:credit:${n}`;
/** What the vendor answered to a credit attempt (the stored outcome suffix). */
export type CreditOutcome = 'credited' | 'pending' | 'refused';
/** `ops.workflow_marker` kind noting that credit attempt `seq` of a transfer began (T-0769); the value is the credit key. */
const CREDIT_BEGAN = 'credit_began';
/** The outcome of attempt `seq` (value `credited|pending|refused`), written once after the vendor answered; absent after a crash in between. */
const CREDIT_OUTCOME = 'credit_outcome';
/** How many consecutive case-less `NOT_SUCCEEDED` answers for one key open the `load_credit_refused` case (T-0786, owner decision, option 2). */
export const CASE_AFTER_NOT_SUCCEEDED = 3;
const FLAP_SEQS: readonly number[] = Array.from({ length: CASE_AFTER_NOT_SUCCEEDED }, (_, i) => i + 1);
/** `ops.workflow_marker` kind of the answers counted for credit attempt `attempt` (one kind per attempt, so a later key starts at zero); subject the transfer id, seq the occurrence 1..N, value the credit key. */
const flapKind = (attempt: number): string => `credit_flap:${attempt}`;
interface CreditAttempt {
  transferId: string;
  /** Kept for the callers; the markers are keyed by the transfer id, which implies the provider (T-0769). */
  provider: string;
  attempt: number;
}

/** Writes the `began` marker of a credit attempt, before the vendor is called, so a crash between the vendor's answer and our journal leaves a trace (T-0742). Idempotent. */
export async function recordCreditBegan(db: Database, a: CreditAttempt & { workflowId: string }): Promise<void> {
  await putMarker(db, { kind: CREDIT_BEGAN, subjectId: a.transferId, seq: a.attempt, value: creditKey(a.workflowId, a.attempt) });
}

/** Writes the outcome of a credit attempt. The FIRST outcome wins (write-once on (kind, transfer, attempt)): a `pending` that later turns credited or refused stays `pending` (conservative: it can only open a case, never hide one). */
export async function recordCreditOutcome(db: Database, a: CreditAttempt & { workflowId: string; outcome: CreditOutcome }): Promise<void> {
  await putMarker(db, { kind: CREDIT_OUTCOME, subjectId: a.transferId, seq: a.attempt, value: a.outcome });
}

/** What our own records say of a credit attempt: whether it began, and its outcome when one was written. A stored value that is none of the three reads as `pending` (the conservative answer: money may have moved). */
export async function creditAttemptState(db: Database, a: CreditAttempt): Promise<{ began: boolean; outcome?: CreditOutcome }> {
  if ((await getMarker(db, CREDIT_BEGAN, a.transferId, a.attempt)) === undefined) return { began: false };
  const done = await getMarker(db, CREDIT_OUTCOME, a.transferId, a.attempt);
  if (done === undefined) return { began: true };
  return { began: true, outcome: done === 'credited' || done === 'refused' ? done : 'pending' };
}

/**
 * Counts one case-less `NOT_SUCCEEDED` answer for this attempt's key (T-0786) and returns how many answers are on record, this one included.
 * The count is derived from insert-only markers (no migration, no new grant): seqs 1..N of `credit_flap:{attempt}` are read and the first absent
 * seq is written (first writer wins). A crash between the vendor's answer and this write loses nothing but time: the next cycle sends the same key,
 * the vendor replays the same answer and it is counted then (the case opens one cycle later). Two sweeps racing may count one answer once (both write
 * the same seq); they cannot open two cases, because the case opener dedupes on the transfer's `dedupe_key`.
 */
export async function recordCreditFlap(db: Database, a: CreditAttempt & { workflowId: string }): Promise<number> {
  const kind = flapKind(a.attempt);
  const have = await getMarkers(db, kind, a.transferId, FLAP_SEQS);
  const next = FLAP_SEQS.find((seq) => !have.has(seq));
  if (next === undefined) return have.size;
  await putMarker(db, { kind, subjectId: a.transferId, seq: next, value: creditKey(a.workflowId, a.attempt) });
  return have.size + 1;
}

/** The part of `LoadService`'s dependencies the credit phase reads. */
export interface CreditDeps {
  db: Database;
  /** Registry provider name, the key space of the vendor refs in ops.external_ref (the credit markers no longer use it). */
  provider: string;
  fundingAccounts?: FundingAccountPort | undefined;
  credit?: FundingCreditPort | undefined;
}

/** What one credit step did: whether the journal may post, whether the vendor answered `credited`, and whether it opened or reopened a `load_credit_refused` case. */
export interface CreditStepResult {
  proceed: boolean;
  credited: boolean;
  refused: boolean;
}

/**
 * The vendor credit before the journal (T-0705, ADR-018 A4/M1). `proceed` is true when the journal may post: no credit port (the journals every
 * other vendor posts), or the vendor answered `credited`. False leaves the load where it is and posts nothing: `pending` (a load the
 * vendor still holds, or an answer not final yet) is retried by the next sweep with the SAME key, a refusal opens one `load_credit_refused`
 * case and stops until people resolve it, and the retry after that takes the next key `{wf}:credit:{n}`, `n` read from the case. A `NOT_SUCCEEDED`
 * refusal opens no case at first (retried with the same key) but does after the third in a row for that key (T-0786).
 * A thrown outage leaves everything as it was. The credit is per load at the vendor, so a crash after it and before the journal
 * calls it again, is answered `credited`, and the one journal follows.
 */
export async function creditStep(d: CreditDeps, transfer: Transfer, vendor: VendorLoad | undefined, now: Date): Promise<CreditStepResult> {
  const port = d.credit;
  let refused = false;
  const refuse = async (loadId: string, reasonCode: string, attempt: number): Promise<CreditStepResult> => {
    if (await openCreditCase(d.db, transfer, loadId, reasonCode, attempt, now)) refused = true;
    return { proceed: false, credited: false, refused };
  };
  if (transfer.kind !== 'load' || !vendor) return { proceed: true, credited: false, refused: false };
  // A sub-account whose owner the vendor refused is not credited (T-0763), with or without a credit port: this is the one place every path
  // (webhook, sweep, release) passes before a load's journal. It runs ahead of the credit-case and account gates, so a failed owner never
  // opens a `load_credit_refused` case either, and unlike them it writes no `began` marker: no attempt number is spent, nobody has to
  // resolve a case, and the next cycle reads the marker again and goes on with the same key once it is gone.
  if (await ownerBlock(d, transfer, now)) return { proceed: false, credited: false, refused: false };
  if (!port) return { proceed: true, credited: false, refused: false };
  const found = await creditCase(d.db, transfer.id);
  if (found.open) return { proceed: false, credited: false, refused: false };
  // Not `succeeded` (an ACH the vendor still holds, even past our hold date when its clock lags ours): nothing to credit yet, no case.
  if (vendor.status !== 'succeeded') return { proceed: false, credited: false, refused: false };
  const attempt = found.attempt + 1;
  const accountRef = await memberAccountRef(d, transfer);
  if (!accountRef) return refuse(vendor.loadId, 'NO_ACCOUNT', attempt);
  // A stored ref skipped the account gate when the load began: an account frozen or closed since is checked again here (T-0740 review).
  const blocked = await accountBlock(d, accountRef);
  if (blocked) return refuse(vendor.loadId, blocked, attempt);
  // Written before the call, so a crash between the vendor's `credited` and our journal leaves a trace a later return can find (T-0742).
  await recordCreditBegan(d.db, { transferId: transfer.id, workflowId: transfer.idempotencyKey, provider: d.provider, attempt });
  let result: CreditResult;
  try {
    result = await port.creditWallet({ loadId: vendor.loadId, accountRef, amount: transfer.amount }, creditKey(transfer.idempotencyKey, attempt));
  } catch (e) {
    // An outage moved nothing: the same key is sent again next cycle. A request the vendor will never accept (a USD-only credit asked for an
    // ILS load, a load it does not know) is a case for people, once, not an error every cycle.
    if (e instanceof FundingError && (e.code === 'VALIDATION_FAILED' || e.code === 'UNKNOWN_LOAD')) return refuse(vendor.loadId, e.code, attempt);
    throw mapFundingError(e);
  }
  // The FIRST outcome of an attempt wins: a second one hits the primary key (kind, subject, seq) and is dropped by `on conflict do nothing`.
  // A `pending` that later turns credited or refused stays `pending`, which is conservative: it can only open a case, never hide one.
  await recordCreditOutcome(d.db, { transferId: transfer.id, workflowId: transfer.idempotencyKey, provider: d.provider, attempt, outcome: result.status });
  if (result.status === 'credited') return { proceed: true, credited: true, refused: false };
  if (result.status === 'refused' && result.reasonCode !== 'NOT_SUCCEEDED') return refuse(vendor.loadId, result.reasonCode ?? 'REFUSED', attempt);
  // `NOT_SUCCEEDED` after a `succeeded` read is retried with the same key and no case, so a one-off flap costs nothing; but a refusal is final for
  // its key at the vendor, so a key that keeps answering it never recovers. After N such answers in a row (T-0786) ONE `load_credit_refused` case
  // opens (reasonCode `NOT_SUCCEEDED`, this attempt), the key stays the same, and staff resolving it takes the next key like any refusal.
  if (result.status === 'refused' && (await recordCreditFlap(d.db, { transferId: transfer.id, workflowId: transfer.idempotencyKey, provider: d.provider, attempt })) >= CASE_AFTER_NOT_SUCCEEDED) return refuse(vendor.loadId, result.reasonCode ?? 'NOT_SUCCEEDED', attempt);
  return { proceed: false, credited: false, refused: false };
}

/** True when the load's purse is a sub-account whose owner failed (the `o:{party}:failed` marker of this provider, kind `subaccount_owner:{provider}` in ops.workflow_marker since T-0770); opens the one owner case for staff (the key sub-accounts.ts used) if it is not there. */
async function ownerBlock(d: CreditDeps, transfer: Transfer, now: Date): Promise<boolean> {
  const party = transfer.toPartyId;
  if (party === undefined) return false;
  if (!isOwnerFailedMarker(party, await getMarker(d.db, ownerKind(d.provider), party))) return false;
  await openCase(d.db, { kind: OWNER_FAILED_CASE, dedupeKey: ownerCaseKey(party), severity: 'medium', payload: { partyId: party }, now });
  return true;
}

async function memberAccountRef(d: CreditDeps, transfer: Transfer): Promise<string | undefined> {
  const ref = await d.db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'funding_account' and entity_id = $1 and provider = $2`, [transfer.toPartyId, d.provider]);
  return ref.rows[0]?.external_id;
}

/** The reason code when the member's wallet account at the vendor is no longer open (read now, never trusted from the stored ref); undefined when it is open or the binding cannot say. */
async function accountBlock(d: CreditDeps, accountRef: string): Promise<string | undefined> {
  const accounts = d.fundingAccounts;
  if (!accounts) return undefined;
  try {
    const view = await accounts.account(accountRef);
    return view.status === 'open' ? undefined : `ACCOUNT_${view.status.toUpperCase()}`;
  } catch (e) {
    if (e instanceof FundingAccountError && e.code === 'UNKNOWN_ACCOUNT') return 'UNKNOWN_ACCOUNT';
    if (e instanceof FundingAccountError && e.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('PROVIDER_UNAVAILABLE', 'Funding is temporarily unavailable; try again with the same key');
    throw e;
  }
}

/**
 * The vendor load id when the vendor may already hold this load's money in the member's wallet without our journal, else undefined. Reads
 * only our own records and calls no vendor: attempt `n` (the next after the credit case's) has a `began` marker, written before the call,
 * and its outcome row is `credited` or `pending`, or missing (a crash between the call and the outcome: the vendor may have credited).
 * A `refused` outcome, no marker, or an open credit case (the last attempt was refused, no later key sent) means no money moved: a refusal is
 * final for its key at the vendor, so a `refused` outcome means no money moved under that key.
 * `vendorId` is the vendor's load id for the transfer, read by the caller (`LoadService.vendorLoadOf`) after its `kind === 'load'` check.
 */
export async function creditMayHaveMoved(d: Pick<CreditDeps, 'db' | 'provider'>, transfer: Transfer, vendorId: string): Promise<string | undefined> {
  const found = await creditCase(d.db, transfer.id);
  if (found.open) return undefined;
  const attempt = found.attempt + 1;
  const state = await creditAttemptState(d.db, { transferId: transfer.id, provider: d.provider, attempt });
  return state.began && state.outcome !== 'refused' ? vendorId : undefined;
}
