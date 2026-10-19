// Inbound event store (T-0204, REQ-LED-003) over ops.inbound_event: every provider webhook is
// written first, keyed by (provider, event_id), with the raw payload and whether its signature
// verified. Processing happens after the write and is idempotent, so replay is always safe.
import { isPgError, PG, type Database } from '../db.ts';

export interface InboundEvent {
  provider: string;
  eventId: string;
  receivedAt: string;
  signatureOk: boolean;
  payload: unknown;
  processedAt?: string;
  error?: string;
}

interface Row {
  provider: string;
  event_id: string;
  received_at: string | Date;
  signature_ok: boolean;
  payload: unknown;
  processed_at: string | Date | null;
  error: string | null;
}

export class InboundEventStore {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Returns `duplicate: true` when the (provider, eventId) pair was already stored; the stored row wins. */
  async record(e: { provider: string; eventId: string; signatureOk: boolean; payload: unknown; receivedAt: Date }): Promise<{ duplicate: boolean; event: InboundEvent }> {
    try {
      await this.db.query('insert into ops.inbound_event (provider, event_id, received_at, signature_ok, payload) values ($1, $2, $3, $4, $5)', [e.provider, e.eventId, e.receivedAt, e.signatureOk, JSON.stringify(e.payload)]);
      return { duplicate: false, event: (await this.get(e.provider, e.eventId))! };
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) return { duplicate: true, event: (await this.get(e.provider, e.eventId))! };
      throw err;
    }
  }

  async get(provider: string, eventId: string): Promise<InboundEvent | undefined> {
    const r = await this.db.query<Row>('select * from ops.inbound_event where provider = $1 and event_id = $2', [provider, eventId]);
    return r.rows[0] ? toEvent(r.rows[0]) : undefined;
  }

  async markProcessed(provider: string, eventId: string, at: Date, error?: string): Promise<void> {
    await this.db.query('update ops.inbound_event set processed_at = $3, error = $4 where provider = $1 and event_id = $2', [provider, eventId, error ? null : at, error ?? null]);
  }

  /** Verified events never processed or processed with an error, oldest first (the replay tool and the backlog alarm read this). */
  async pending(limit = 100, provider?: string): Promise<InboundEvent[]> {
    const r = await this.db.query<Row>(
      `select * from ops.inbound_event where signature_ok and processed_at is null and ($1::text is null or provider = $1) order by received_at limit $2`,
      [provider ?? null, limit],
    );
    return r.rows.map(toEvent);
  }

  /** Age of the oldest unprocessed verified event in ms (RUN-05 webhook backlog alert: over 5 minutes pages). */
  async lagMs(now: Date): Promise<number> {
    const r = await this.db.query<{ oldest: string | Date | null }>('select min(received_at) as oldest from ops.inbound_event where signature_ok and processed_at is null');
    const oldest = r.rows[0]?.oldest;
    return oldest ? now.getTime() - new Date(oldest).getTime() : 0;
  }
}

function toEvent(r: Row): InboundEvent {
  return {
    provider: r.provider,
    eventId: r.event_id,
    receivedAt: new Date(r.received_at).toISOString(),
    signatureOk: r.signature_ok,
    payload: r.payload,
    ...(r.processed_at ? { processedAt: new Date(r.processed_at).toISOString() } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}
