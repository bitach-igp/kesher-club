// Outbound webhooks (T-0803, REQ-NOT-002): institution-facing outbox messages become Standard
// Webhooks deliveries through the EventsPort (Svix or in-house), with the port's retry ladder
// (5 s … 24 h, 72 h) and a replay tool for ops. Payloads are thin: ids and a type.
import { DomainError, uuidv7 } from '@kesher/domain';
import type { DeliveryAttempt, Endpoint, EventsPort, OutboundEventType } from '@kesher/ports';
import type { Database } from '../db.ts';
import type { OutboxMessage, OutboxSink } from '../transfers/outbox.ts';

/** Outbox types that institutions may subscribe to, mapped to the public event names (Tab 3 §5). */
export const INSTITUTION_EVENTS: Readonly<Record<string, OutboundEventType>> = {
  'member.onboarded': 'member.onboarded',
  'membership.status_changed': 'membership.status_changed',
  'allowance.run.completed': 'allowance.run.completed',
  'collection.paid': 'collection.paid',
  'payout.status_changed': 'payout.status_changed',
  'roster.import.completed': 'roster.import.completed',
};

export class OutboundEventsService implements OutboxSink {
  constructor(
    private readonly db: Database,
    private readonly port: EventsPort,
  ) {}

  /** Console: register an endpoint. Returns the secret ONCE; it is never stored on our side. */
  async createEndpoint(input: { institutionId: string; url: string; eventTypes: readonly OutboundEventType[]; createdBy: string }, now: Date): Promise<Endpoint> {
    if (!/^https:\/\//.test(input.url)) throw new DomainError('VALIDATION_FAILED', 'Endpoint must be https');
    const unknown = input.eventTypes.filter((t) => !Object.values(INSTITUTION_EVENTS).includes(t));
    if (unknown.length) throw new DomainError('VALIDATION_FAILED', `Unknown event types: ${unknown.join(', ')}`);
    const ep = await this.port.createEndpoint({ institutionId: input.institutionId, url: input.url, eventTypes: input.eventTypes }, `ep:${input.institutionId}:${input.url}`);
    await this.db.query('insert into notify.outbound_endpoint (endpoint_id, institution_id, url, event_types, created_by, created_at) values ($1, $2, $3, $4, $5, $6) on conflict (endpoint_id) do nothing', [ep.endpointId, input.institutionId, input.url, [...input.eventTypes], input.createdBy, now]);
    return ep;
  }

  async rotateSecret(endpointId: string, now: Date): Promise<Endpoint> {
    const ep = await this.port.rotateSecret(endpointId, `rotate:${endpointId}:${now.getTime()}`);
    await this.db.query('update notify.outbound_endpoint set rotated_at = $2 where endpoint_id = $1', [endpointId, now]);
    return ep;
  }

  /** OutboxSink: called by the OutboxPublisher for every message; non-institution messages are ignored. */
  async publish(m: OutboxMessage): Promise<void> {
    const type = INSTITUTION_EVENTS[m.type];
    if (!type) return;
    const institutionId = typeof m.payload['institutionId'] === 'string' ? m.payload['institutionId'] : undefined;
    if (!institutionId) return;
    const thin: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.payload)) if (typeof v === 'string' && /id$|Id$|^type$|^status$|^count$|^paid$|^failures$/.test(k)) thin[k] = v;
    const sent = await this.port.send({ type, institutionId, payload: { ...thin, aggregateId: m.aggregateId } }, `outbox:${m.id}`);
    await this.db.query('insert into notify.outbound_message (message_id, outbox_id, institution_id, event_type, sent_at) values ($1, $2, $3, $4, $5) on conflict do nothing', [sent.messageId, m.id, institutionId, type, new Date(m.createdAt)]);
  }

  /** Replay UI: messages for an institution with their attempts. */
  async messages(institutionId: string, limit = 50): Promise<{ messageId: string; eventType: string; sentAt: string; attempts: readonly DeliveryAttempt[] }[]> {
    const r = await this.db.query<{ message_id: string; event_type: string; sent_at: string | Date }>('select message_id, event_type, sent_at from notify.outbound_message where institution_id = $1 order by sent_at desc limit $2', [institutionId, limit]);
    const out = [];
    for (const m of r.rows) out.push({ messageId: m.message_id, eventType: m.event_type, sentAt: new Date(m.sent_at).toISOString(), attempts: await this.port.listAttempts(m.message_id) });
    return out;
  }

  async replay(messageId: string, endpointId: string, by: string, now: Date): Promise<DeliveryAttempt> {
    const owned = await this.db.query('select 1 from notify.outbound_message m join notify.outbound_endpoint e on e.institution_id = m.institution_id where m.message_id = $1 and e.endpoint_id = $2', [messageId, endpointId]);
    if (owned.rowCount === 0) throw new DomainError('NOT_FOUND', 'Message or endpoint not found for this institution');
    return this.port.replay(messageId, endpointId, `replay:${messageId}:${endpointId}:${by}:${uuidv7(now)}`);
  }
}
