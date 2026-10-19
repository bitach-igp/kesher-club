// Hash-chained admin audit (T-0903, REQ-ADM-001, THR-05): every admin action records actor,
// reason and before/after hashes in a row whose hash includes the previous row's hash. The
// verification job recomputes the chain; a tampered, deleted or reordered row fails it.
import { createHash } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import type { Database, SqlClient } from '../db.ts';

export interface AuditInput {
  actorId: string;
  actorRole: string;
  action: string;
  subject: string;
  reason: string;
  before?: unknown;
  after?: unknown;
  payload?: Record<string, unknown>;
}

export interface AuditEntry extends Omit<AuditInput, 'before' | 'after'> {
  seq: number;
  id: string;
  beforeHash?: string;
  afterHash?: string;
  at: string;
  prevHash: string;
  hash: string;
}

export const GENESIS = 'genesis';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Stable JSON: sorted keys, bigint as string. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const hashState = (v: unknown): string => sha(canonical(v));

export function entryHash(e: Omit<AuditEntry, 'hash' | 'seq'>): string {
  return sha([e.id, e.actorId, e.actorRole, e.action, e.subject, e.reason, e.beforeHash ?? '', e.afterHash ?? '', canonical(e.payload ?? {}), e.at, e.prevHash].join('\n'));
}

export class AuditService {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Appends one entry. Serialised through a row lock on the last entry so the chain never forks. */
  async record(input: AuditInput, now: Date, db: Database = this.db): Promise<AuditEntry> {
    if (!input.reason.trim()) throw new DomainError('VALIDATION_FAILED', 'A reason is required for every admin action');
    return db.transaction(async (tx) => {
      await tx.query('lock table audit.entry in share row exclusive mode');
      const last = await tx.query<{ hash: string }>('select hash from audit.entry order by seq desc limit 1');
      const prevHash = last.rows[0]?.hash ?? GENESIS;
      const base = {
        id: uuidv7(now),
        actorId: input.actorId,
        actorRole: input.actorRole,
        action: input.action,
        subject: input.subject,
        reason: input.reason,
        ...(input.before !== undefined ? { beforeHash: hashState(input.before) } : {}),
        ...(input.after !== undefined ? { afterHash: hashState(input.after) } : {}),
        payload: input.payload ?? {},
        at: now.toISOString(),
        prevHash,
      };
      const hash = entryHash(base);
      const r = await tx.query<{ seq: number }>(
        `insert into audit.entry (id, actor_id, actor_role, action, subject, reason, before_hash, after_hash, payload, at, prev_hash, hash) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning seq`,
        [base.id, base.actorId, base.actorRole, base.action, base.subject, base.reason, base.beforeHash ?? null, base.afterHash ?? null, JSON.stringify(base.payload), now, prevHash, hash],
      );
      return { ...base, hash, seq: r.rows[0]!.seq };
    });
  }

  /** Recomputes every hash in seq order. The first bad row is reported; the job runs nightly and pages on failure. */
  async verify(db: SqlClient = this.db): Promise<{ ok: true; entries: number } | { ok: false; entries: number; brokenAtSeq: number; reason: string }> {
    const rows = await db.query<{ seq: number; id: string; actor_id: string; actor_role: string; action: string; subject: string; reason: string; before_hash: string | null; after_hash: string | null; payload: Record<string, unknown>; at: string | Date; prev_hash: string; hash: string }>('select * from audit.entry order by seq');
    let prev = GENESIS;
    let n = 0;
    for (const r of rows.rows) {
      n += 1;
      if (r.prev_hash !== prev) return { ok: false, entries: n, brokenAtSeq: r.seq, reason: 'chain link does not match the previous row' };
      const expected = entryHash({ id: r.id, actorId: r.actor_id, actorRole: r.actor_role, action: r.action, subject: r.subject, reason: r.reason, ...(r.before_hash ? { beforeHash: r.before_hash } : {}), ...(r.after_hash ? { afterHash: r.after_hash } : {}), payload: r.payload, at: new Date(r.at).toISOString(), prevHash: r.prev_hash });
      if (expected !== r.hash) return { ok: false, entries: n, brokenAtSeq: r.seq, reason: 'row content does not match its hash' };
      prev = r.hash;
    }
    return { ok: true, entries: n };
  }

  async list(subject: string, limit = 50): Promise<AuditEntry[]> {
    const r = await this.db.query<{ seq: number; id: string; actor_id: string; actor_role: string; action: string; subject: string; reason: string; before_hash: string | null; after_hash: string | null; payload: Record<string, unknown>; at: string | Date; prev_hash: string; hash: string }>('select * from audit.entry where subject = $1 order by seq desc limit $2', [subject, limit]);
    return r.rows.map((x) => ({ seq: x.seq, id: x.id, actorId: x.actor_id, actorRole: x.actor_role, action: x.action, subject: x.subject, reason: x.reason, ...(x.before_hash ? { beforeHash: x.before_hash } : {}), ...(x.after_hash ? { afterHash: x.after_hash } : {}), payload: x.payload, at: new Date(x.at).toISOString(), prevHash: x.prev_hash, hash: x.hash }));
  }
}
