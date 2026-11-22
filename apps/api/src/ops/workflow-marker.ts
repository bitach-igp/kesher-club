import type { SqlClient } from '../db.ts';

// Our own workflow markers live in ops.workflow_marker, not in ops.external_ref (which holds vendor ids only).
// A marker is write-once: first writer wins on (kind, subject_id, seq) and on (kind, value); club_app has no update or delete.
// Values are party ids, keys and hashes, never PII.

export interface MarkerPut {
  kind: string;
  subjectId: string;
  /** Defaults to 0; a marker per attempt uses the attempt number. */
  seq?: number;
  value: string;
}

/** Records the marker; one that already exists (either key) is left alone. True iff a row was inserted. */
export async function putMarker(db: SqlClient, m: MarkerPut): Promise<boolean> {
  const r = await db.query(`insert into ops.workflow_marker (kind, subject_id, seq, value) values ($1, $2, $3, $4) on conflict do nothing`, [m.kind, m.subjectId, m.seq ?? 0, m.value]);
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

/** The subject this value is recorded for under this kind, if any. */
export async function findByValue(db: SqlClient, kind: string, value: string): Promise<string | undefined> {
  const r = await db.query<{ subject_id: string }>('select subject_id from ops.workflow_marker where kind = $1 and value = $2', [kind, value]);
  return r.rows[0]?.subject_id;
}
