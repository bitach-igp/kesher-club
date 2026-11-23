import type { SqlClient } from '../db.ts';

// Our own workflow markers live in ops.workflow_marker, not in ops.external_ref (which holds vendor ids only).
// A marker is write-once: first writer wins on (kind, subject_id, seq) and on (kind, claim); club_app has no update. The one exception is a
// failed-owner marker (kind `subaccount_owner:{provider}`), which staff clear once the owner is fixed (T-0787, `clearMarker`): the table
// grants delete, and a BEFORE DELETE trigger refuses every other kind.
// Values are party ids, keys and hashes, never PII.

export interface MarkerPut {
  kind: string;
  subjectId: string;
  /** Defaults to 0; a marker per attempt uses the attempt number. */
  seq?: number;
  value: string;
  /** A key one subject may take once per kind (a lost-race key); omitted markers never collide on it. */
  claim?: string;
}

/**
 * Records the marker, first writer wins (on conflict do nothing). True iff a row was inserted. False means the (kind, subject, seq)
 * is already written OR the claim is taken by another subject; a caller that needs to tell which must follow up with getMarker.
 */
export async function putMarker(db: SqlClient, m: MarkerPut): Promise<boolean> {
  const r = await db.query(`insert into ops.workflow_marker (kind, subject_id, seq, value, claim) values ($1, $2, $3, $4, $5) on conflict do nothing`, [m.kind, m.subjectId, m.seq ?? 0, m.value, m.claim ?? null]);
  return r.rowCount > 0;
}

/** The marker's value, if one is recorded. */
export async function getMarker(db: SqlClient, kind: string, subjectId: string, seq = 0): Promise<string | undefined> {
  const r = await db.query<{ value: string }>('select value from ops.workflow_marker where kind = $1 and subject_id = $2 and seq = $3', [kind, subjectId, seq]);
  return r.rows[0]?.value;
}

/** The recorded markers among these seqs, keyed by seq; a seq with no marker is absent. */
export async function getMarkers(db: SqlClient, kind: string, subjectId: string, seqs: readonly number[]): Promise<Map<number, string>> {
  if (seqs.length === 0) return new Map();
  const r = await db.query<{ seq: number; value: string }>('select seq, value from ops.workflow_marker where kind = $1 and subject_id = $2 and seq = any($3::int[])', [kind, subjectId, [...seqs]]);
  return new Map(r.rows.map((row) => [row.seq, row.value]));
}

/** The subject that holds this claim under this kind, if any. */
export async function findByClaim(db: SqlClient, kind: string, claim: string): Promise<string | undefined> {
  const r = await db.query<{ subject_id: string }>('select subject_id from ops.workflow_marker where kind = $1 and claim = $2', [kind, claim]);
  return r.rows[0]?.subject_id;
}

/** The only kind prefix that may be cleared (a failed-owner marker); the table's delete trigger enforces the same rule. */
export const CLEARABLE_KIND_PREFIX = 'subaccount_owner:';

/**
 * Deletes a failed-owner marker (T-0787). True iff a row was deleted; false when none exists (idempotent). Any other kind throws before the
 * database is touched: credit, lost-key, payee and purpose markers are write-once (and the table's trigger refuses them as well).
 */
export async function clearMarker(db: SqlClient, m: { kind: string; subjectId: string; seq?: number }): Promise<boolean> {
  if (!m.kind.startsWith(CLEARABLE_KIND_PREFIX)) throw new Error('clearMarker: only a failed-owner marker may be cleared');
  const r = await db.query('delete from ops.workflow_marker where kind = $1 and subject_id = $2 and seq = $3', [m.kind, m.subjectId, m.seq ?? 0]);
  return r.rowCount > 0;
}
