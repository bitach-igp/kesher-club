// The cases a load can open and the keys that make them one per transfer (T-0765, split from loads.ts): the vendor does not know a held
// load (`load_unknown`), the vendor refused the credit (`load_credit_refused`), and the vendor took money back after the wallet was
// credited (`load_returned_after_release`). The three openers share one reopen statement, `reopenableCase`. Moved from LoadService with
// the SQL, the keys and the payloads unchanged; the `refusals` counter stays on the service and counts on `openCreditCase`'s boolean.
import { uuidv7 } from '@kesher/domain';
import type { SqlClient } from '../db.ts';
import type { Transfer } from '../transfers/service.ts';

export const unknownLoadKey = (transferId: string): string => `load-unknown:${transferId}`;
export const creditCaseKey = (transferId: string): string => `load-credit:${transferId}`;
/** The one case per transfer for money the vendor holds that a return or reversal now contradicts (T-0742). */
export const returnedCaseKey = (transferId: string): string => `load-returned:${transferId}`;

export interface ReopenableCase {
  kind: string;
  dedupeKey: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  payload: Record<string, unknown>;
  now: Date;
}

/**
 * Opens an `open` case, or reopens a resolved or dismissed one with this dedupe key (what people decided is kept in the payload under
 * `reopened`); an open or investigating one is left alone. True when a row was inserted or reopened. `ops/cases.ts` `openCase` never
 * reopens, so it cannot stand in.
 */
export async function reopenableCase(db: SqlClient, c: ReopenableCase): Promise<boolean> {
  const r = await db.query(
    `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, $4, 'open', $5, $6)
       on conflict (dedupe_key) do update set status = 'open', resolved_at = null, resolved_by = null, resolution = null,
         disposition = null, decided_by = null, decided_at = null, decision_note = null, assigned_to = null, assigned_at = null,
         payload = excluded.payload || jsonb_build_object('reopened', jsonb_build_object('at', excluded.opened_at, 'was', ops.case.status, 'resolution', ops.case.resolution))
       where ops.case.status in ('resolved', 'dismissed') returning id`,
    [uuidv7(c.now), c.kind, c.dedupeKey, c.severity, c.payload, c.now],
  );
  return r.rows.length > 0;
}

/** True while a case people have not decided exists for a held load the vendor does not know; a resolved or dismissed one lets it be asked again. */
export async function unknownLoadOpen(db: SqlClient, transferId: string): Promise<boolean> {
  return Boolean((await db.query(`select 1 from ops.case where dedupe_key = $1 and status in ('open', 'investigating')`, [unknownLoadKey(transferId)])).rows[0]);
}

export async function creditCase(db: SqlClient, transferId: string): Promise<{ open: boolean; attempt: number }> {
  const r = await db.query<{ status: string; payload: { attempt?: number } }>(`select status, payload from ops.case where dedupe_key = $1`, [creditCaseKey(transferId)]);
  const row = r.rows[0];
  return { open: row?.status === 'open' || row?.status === 'investigating', attempt: row ? (row.payload.attempt ?? 1) : 0 };
}

/**
 * The vendor took the money back (a return, a refund, a cancel) after the member's wallet was credited (T-0742): one case for people,
 * `load_returned_after_release`, high, per transfer. It moves nothing: no journal, no state change, no debit of the wallet (who bears
 * the loss is the owner's to decide). A resolved or dismissed case is reopened by a later report; an open one is left alone. The
 * payload holds ids, the amount and the code only. `stage` is `after_release` (the vendor read a settled load failed) or `before_journal` (our records show a credit began and no journal posted; the load is failed and its hold reversed).
 */
export async function openReturnedCase(db: SqlClient, transfer: Transfer, loadId: string, failureCode: string, stage: 'after_release' | 'before_journal', now: Date): Promise<void> {
  await reopenableCase(db, {
    kind: 'load_returned_after_release', dedupeKey: returnedCaseKey(transfer.id), severity: 'high', now,
    payload: { transferId: transfer.id, loadId, amount: { minor: transfer.amount.minor.toString(), currency: transfer.amount.currency }, memberPartyId: transfer.toPartyId, failureCode, reasonCode: failureCode, stage },
  });
}

/** A resolved or dismissed case is reopened by the next refusal (the earlier decision is kept in the payload); an open one is left alone. True when a row was inserted or reopened. */
export async function openCreditCase(db: SqlClient, transfer: Transfer, loadId: string, reasonCode: string, attempt: number, now: Date): Promise<boolean> {
  return reopenableCase(db, {
    kind: 'load_credit_refused', dedupeKey: creditCaseKey(transfer.id), severity: 'high', now,
    payload: { transferId: transfer.id, loadId, amount: { minor: transfer.amount.minor.toString(), currency: transfer.amount.currency }, reasonCode, attempt },
  });
}

/**
 * A case people resolved or dismissed while the vendor still does not know the load is reopened (what they decided is kept in the
 * payload), so the hold never stalls without anyone being told (T-0680); an open one is left alone.
 */
export async function openUnknownLoadCase(db: SqlClient, transfer: Transfer, loadId: string, now: Date): Promise<void> {
  await reopenableCase(db, {
    kind: 'load_unknown', dedupeKey: unknownLoadKey(transfer.id), severity: 'high', now,
    payload: { transferId: transfer.id, loadId, state: transfer.state, amount: { minor: transfer.amount.minor.toString(), currency: transfer.amount.currency } },
  });
}
