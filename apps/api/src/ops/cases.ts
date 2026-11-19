import type { SqlClient } from '../db.ts';
import { uuidv7 } from '@kesher/domain';

export interface NewCase {
  kind: string;
  /** One case per key: a second open with the same key changes nothing. */
  dedupeKey: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Data for people to read, never instructions; serialised as JSON into the jsonb column. */
  payload: Record<string, unknown>;
  now: Date;
  /** Only when the caller needs the id before the insert (to link a child row); defaults to `uuidv7(now)`. */
  id?: string;
}

/** Opens an `open` case, or leaves the existing one with this dedupe key alone. True iff a row was inserted. */
export async function openCase(db: SqlClient, c: NewCase): Promise<boolean> {
  const r = await db.query(
    `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, $4, 'open', $5, $6)
     on conflict (dedupe_key) do nothing returning id`,
    [c.id ?? uuidv7(c.now), c.kind, c.dedupeKey, c.severity, JSON.stringify(c.payload), c.now],
  );
  return r.rows.length > 0;
}
