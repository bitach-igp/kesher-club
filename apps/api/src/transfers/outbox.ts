// Transactional outbox (T-0205). State changes insert an ops.outbox row in the same transaction;
// the publisher drains it at least once to the event sink (Temporal signal, notification, webhook).
import type { Database, SqlClient } from '../db.ts';

export interface OutboxMessage {
  id: string;
  aggregate: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface OutboxSink {
  /** `tx` is the publisher's claim transaction: a sink that writes to the database does it there, so it never waits on the claim's own connection and its rows commit with `published_at`. */
  publish(message: OutboxMessage, tx?: SqlClient): Promise<void>;
}

/** Call inside the transaction that changes the aggregate. */
export async function enqueue(tx: SqlClient, aggregate: string, aggregateId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await tx.query('insert into ops.outbox (aggregate, aggregate_id, type, payload) values ($1, $2, $3, $4)', [aggregate, aggregateId, type, JSON.stringify(payload, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))]);
}

export class OutboxPublisher {
  private readonly db: Database;
  private readonly sink: OutboxSink;
  constructor(
    db: Database,
    sink: OutboxSink,
  ) {
    this.db = db;
    this.sink = sink;
  }

  /**
   * Publishes up to `limit` unpublished rows in id order (at-least-once). The rows are claimed with `for update skip locked` in one
   * transaction, so a second publisher (another worker) skips them and takes the next ones: no message reaches the sink twice from two
   * workers at once. Each message runs inside its own savepoint, so a failing message undoes only its own writes. A sink failure leaves the row unpublished, counts the attempt and records the error's class (never its message),
   * and the row is claimed again on the next run.
   */
  async publishBatch(limit = 100): Promise<{ published: number; failed: number }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; aggregate: string; aggregate_id: string; type: string; payload: Record<string, unknown>; created_at: string | Date }>(
        'select id::text as id, aggregate, aggregate_id, type, payload, created_at from ops.outbox where published_at is null order by id limit $1 for update skip locked',
        [limit],
      );
      let published = 0;
      let failed = 0;
      for (const r of rows.rows) {
        // One savepoint per message: a SQL error inside the sink aborts the transaction (25P02) until it is rolled back to here, and the
        // sink's own writes through `tx` for a message that then fails must not stay.
        await tx.query('savepoint outbox_msg');
        try {
          await this.sink.publish({ id: r.id, aggregate: r.aggregate, aggregateId: r.aggregate_id, type: r.type, payload: r.payload, createdAt: new Date(r.created_at).toISOString() }, tx);
          await tx.query('update ops.outbox set published_at = now() where id = $1', [r.id]);
          await tx.query('release savepoint outbox_msg');
          published += 1;
        } catch (e) {
          await tx.query('rollback to savepoint outbox_msg');
          await tx.query('update ops.outbox set attempts = attempts + 1, last_error_class = $2 where id = $1', [r.id, e instanceof Error ? e.name : typeof e]);
          failed += 1;
        }
      }
      return { published, failed };
    });
  }

  async backlog(): Promise<number> {
    const r = await this.db.query<{ n: number }>('select count(*)::int as n from ops.outbox where published_at is null');
    return r.rows[0]?.n ?? 0;
  }
}
