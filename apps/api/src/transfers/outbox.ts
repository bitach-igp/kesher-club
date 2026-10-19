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
  publish(message: OutboxMessage): Promise<void>;
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

  /** Publishes up to `limit` unpublished rows in id order. A sink failure leaves the row unpublished for the next run (at-least-once). */
  async publishBatch(limit = 100): Promise<{ published: number; failed: number }> {
    const rows = await this.db.query<{ id: string; aggregate: string; aggregate_id: string; type: string; payload: Record<string, unknown>; created_at: string | Date }>(
      'select id::text as id, aggregate, aggregate_id, type, payload, created_at from ops.outbox where published_at is null order by id limit $1',
      [limit],
    );
    let published = 0;
    let failed = 0;
    for (const r of rows.rows) {
      try {
        await this.sink.publish({ id: r.id, aggregate: r.aggregate, aggregateId: r.aggregate_id, type: r.type, payload: r.payload, createdAt: new Date(r.created_at).toISOString() });
        await this.db.query('update ops.outbox set published_at = now() where id = $1 and published_at is null', [r.id]);
        published += 1;
      } catch {
        failed += 1;
      }
    }
    return { published, failed };
  }

  async backlog(): Promise<number> {
    const r = await this.db.query<{ n: number }>('select count(*)::int as n from ops.outbox where published_at is null');
    return r.rows[0]?.n ?? 0;
  }
}
