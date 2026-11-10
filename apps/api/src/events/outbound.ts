// Outbound webhooks (T-0803, REQ-NOT-002): institution-facing outbox messages become Standard
// Webhooks deliveries through the EventsPort (Svix or in-house), with the port's retry ladder
// (5 s … 24 h, 72 h) and a replay tool for ops. Payloads are thin: ids and a type.
import { DomainError, uuidv7 } from '@kesher/domain';
import type { DeliveryAttempt, Endpoint, EventsPort, OutboundEventType } from '@kesher/ports';
import type { AuditService } from '../audit/service.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database, SqlClient } from '../db.ts';
import { created, noContent, ok, requireIdempotencyKey, requireRole, route, type Handler, type HttpRequest } from '../http.ts';
import { requireStaff, staffActor } from '../admin/staff-token.ts';
import type { OutboxMessage, OutboxSink } from '../transfers/outbox.ts';

export const WEBHOOKS_FLAG = 'webhooks.outbound';

/**
 * An endpoint URL must be a public https host name: no credentials, port 443 only, no IP literal (private, loopback,
 * link-local and cloud-metadata addresses are all IP literals or internal names), no single-label or internal suffix
 * (`localhost`, `*.local`, `*.internal`, `*.localhost`, `*.lan`, `*.home.arpa`). The delivery host resolves the name
 * itself, so a public name that resolves to a private address (DNS rebinding) is the delivery provider's to refuse.
 */
export function assertPublicHttpsUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'Endpoint must be a valid https URL');
  }
  if (raw.length > 2048 || u.protocol !== 'https:') throw new DomainError('VALIDATION_FAILED', 'Endpoint must be https');
  if (u.username || u.password) throw new DomainError('VALIDATION_FAILED', 'Endpoint must not carry credentials');
  if (u.port && u.port !== '443') throw new DomainError('VALIDATION_FAILED', 'Endpoint must use port 443');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  const last = labels[labels.length - 1] ?? '';
  if (host.includes(':') || host.startsWith('[') || /^\d+$/.test(last) || /^0x/.test(last)) throw new DomainError('VALIDATION_FAILED', 'Endpoint must be a host name, not an IP address');
  if (labels.length < 2 || /(^|\.)(localhost|local|internal|lan|home|corp|intranet|home\.arpa)$/.test(host)) throw new DomainError('VALIDATION_FAILED', 'Endpoint must be a public host name');
}

export interface EndpointView {
  endpointId: string;
  url: string;
  eventTypes: readonly OutboundEventType[];
  createdAt: string;
  rotatedAt?: string;
}

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
  private readonly db: Database;
  private readonly port: EventsPort;
  constructor(
    db: Database,
    port: EventsPort,
  ) {
    this.db = db;
    this.port = port;
  }

  /** Console: register an endpoint. Returns the secret ONCE; it is never stored on our side. */
  async createEndpoint(input: { institutionId: string; url: string; eventTypes: readonly OutboundEventType[]; createdBy: string; idempotencyKey?: string }, now: Date): Promise<Endpoint> {
    assertPublicHttpsUrl(input.url);
    const unknown = input.eventTypes.filter((t) => !Object.values(INSTITUTION_EVENTS).includes(t));
    if (unknown.length) throw new DomainError('VALIDATION_FAILED', `Unknown event types: ${unknown.join(', ')}`);
    const ep = await this.port.createEndpoint({ institutionId: input.institutionId, url: input.url, eventTypes: input.eventTypes }, `ep:${input.institutionId}:${input.idempotencyKey ?? input.url}`);
    await this.db.query('insert into notify.outbound_endpoint (endpoint_id, institution_id, url, event_types, created_by, created_at) values ($1, $2, $3, $4, $5, $6) on conflict (endpoint_id) do nothing', [ep.endpointId, input.institutionId, input.url, [...input.eventTypes], input.createdBy, now]);
    return ep;
  }

  async rotateSecret(endpointId: string, now: Date, idempotencyKey?: string): Promise<Endpoint> {
    const ep = await this.port.rotateSecret(endpointId, `rotate:${endpointId}:${idempotencyKey ?? now.getTime()}`);
    await this.db.query('update notify.outbound_endpoint set rotated_at = $2 where endpoint_id = $1', [endpointId, now]);
    return ep;
  }

  /** OutboxSink: called by the OutboxPublisher for every message; non-institution messages are ignored. */
  async publish(m: OutboxMessage, tx?: SqlClient): Promise<void> {
    const type = INSTITUTION_EVENTS[m.type];
    if (!type) return;
    const institutionId = typeof m.payload['institutionId'] === 'string' ? m.payload['institutionId'] : undefined;
    if (!institutionId) return;
    // No live endpoint of ours (none registered, or all deleted): nothing to deliver.
    const live = await (tx ?? this.db).query('select 1 from notify.outbound_endpoint where institution_id = $1 and active limit 1', [institutionId]);
    if (live.rowCount === 0) return;
    const thin: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.payload)) if (typeof v === 'string' && /id$|Id$|^type$|^status$|^count$|^paid$|^failures$/.test(k)) thin[k] = v;
    const sent = await this.port.send({ type, institutionId, payload: { ...thin, aggregateId: m.aggregateId } }, `outbox:${m.id}`);
    await (tx ?? this.db).query('insert into notify.outbound_message (message_id, outbox_id, institution_id, event_type, sent_at) values ($1, $2, $3, $4, $5) on conflict do nothing', [sent.messageId, m.id, institutionId, type, new Date(m.createdAt)]);
  }

  /** Replay UI: messages for an institution with their attempts. */
  async messages(institutionId: string, limit = 50): Promise<{ messageId: string; eventType: string; sentAt: string; attempts: readonly DeliveryAttempt[] }[]> {
    const r = await this.db.query<{ message_id: string; event_type: string; sent_at: string | Date }>('select message_id, event_type, sent_at from notify.outbound_message where institution_id = $1 order by sent_at desc limit $2', [institutionId, limit]);
    const out = [];
    for (const m of r.rows) out.push({ messageId: m.message_id, eventType: m.event_type, sentAt: new Date(m.sent_at).toISOString(), attempts: await this.port.listAttempts(m.message_id) });
    return out;
  }

  /** Ops replay: the same Idempotency-Key replays once; without one every call is a new attempt. */
  async replay(messageId: string, endpointId: string, by: string, now: Date, idempotencyKey?: string): Promise<DeliveryAttempt> {
    const owned = await this.db.query('select 1 from notify.outbound_message m join notify.outbound_endpoint e on e.institution_id = m.institution_id where m.message_id = $1 and e.endpoint_id = $2 and e.active', [messageId, endpointId]);
    if (owned.rowCount === 0) throw new DomainError('NOT_FOUND', 'Message or endpoint not found for this institution');
    return this.port.replay(messageId, endpointId, `replay:${messageId}:${endpointId}:${by}:${idempotencyKey ?? uuidv7(now)}`);
  }

  /** Console: the institution's live endpoints. The secret is not kept, so it cannot be listed. */
  async endpoints(institutionId: string): Promise<EndpointView[]> {
    const r = await this.db.query<{ endpoint_id: string; url: string; event_types: OutboundEventType[]; created_at: string | Date; rotated_at: string | Date | null }>('select endpoint_id, url, event_types, created_at, rotated_at from notify.outbound_endpoint where institution_id = $1 and active order by created_at, endpoint_id', [institutionId]);
    return r.rows.map((e) => ({ endpointId: e.endpoint_id, url: e.url, eventTypes: e.event_types, createdAt: new Date(e.created_at).toISOString(), ...(e.rotated_at ? { rotatedAt: new Date(e.rotated_at).toISOString() } : {}) }));
  }

  /** True when the endpoint is a live one of this institution; another institution's reads as absent. */
  async owns(institutionId: string, endpointId: string): Promise<boolean> {
    return ((await this.db.query('select 1 from notify.outbound_endpoint where endpoint_id = $1 and institution_id = $2 and active', [endpointId, institutionId])).rowCount ?? 0) > 0;
  }

  /** Soft delete: the table grants no delete, so `active` goes false. */
  async deleteEndpoint(institutionId: string, endpointId: string): Promise<boolean> {
    const r = await this.db.query('update notify.outbound_endpoint set active = false where endpoint_id = $1 and institution_id = $2 and active', [endpointId, institutionId]);
    return (r.rowCount ?? 0) > 0;
  }
}

type StaffOfFn = (partyId: string) => Promise<{ institutionId: string; role: 'staff' | 'finance' | 'admin' } | undefined>;

export interface WebhookHandlerDeps {
  svc: OutboundEventsService;
  flags: FeatureFlags;
  audit: AuditService;
  staffOf: StaffOfFn;
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);

export function webhookHandlers(d: WebhookHandlerDeps): Record<string, Handler> {
  const flagOn = async (): Promise<void> => {
    if (!(await d.flags.isOn(WEBHOOKS_FLAG))) throw new DomainError('FEATURE_OFF', 'Outbound webhooks are not enabled yet');
  };
  /** Active staff of this institution; `admin` only when asked. Another institution reads as not found. */
  const own = async (req: HttpRequest, admin: boolean) => {
    const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
    await flagOn();
    const institutionId = req.params['id'] ?? '';
    const staff = await d.staffOf(p.partyId);
    if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
    if (admin && staff.role !== 'admin') throw new DomainError('FORBIDDEN', 'Only institution admins manage webhook endpoints');
    return { institutionId, partyId: p.partyId };
  };
  const secretBody = (ep: Endpoint) => ({ endpointId: ep.endpointId, url: ep.url, eventTypes: ep.eventTypes, secret: ep.secret, ...(ep.previousSecretValidUntil ? { previousSecretValidUntil: ep.previousSecretValidUntil } : {}) });
  return {
    createWebhookEndpoint: route(async (req) => {
      const { institutionId, partyId } = await own(req, true);
      const key = requireIdempotencyKey(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const eventTypes = strings(b['eventTypes']);
      if (typeof b['url'] !== 'string' || !eventTypes?.length) throw new DomainError('VALIDATION_FAILED', 'url and eventTypes are required');
      const ep = await d.svc.createEndpoint({ institutionId, url: b['url'], eventTypes: eventTypes as OutboundEventType[], createdBy: partyId, idempotencyKey: key }, req.now);
      await d.audit.record({ actorId: partyId, actorRole: 'org_admin', action: 'institution.webhook.create', subject: ep.endpointId, reason: 'Webhook endpoint registered', payload: { institutionId, url: ep.url, eventTypes } }, req.now);
      return created(secretBody(ep));
    }),
    listWebhookEndpoints: route(async (req) => {
      const { institutionId } = await own(req, false);
      return ok({ items: await d.svc.endpoints(institutionId) });
    }),
    updateWebhookEndpoint: route(async (req) => {
      const { institutionId, partyId } = await own(req, true);
      const key = requireIdempotencyKey(req);
      const endpointId = req.params['endpointId'] ?? '';
      if (!(await d.svc.owns(institutionId, endpointId))) throw new DomainError('NOT_FOUND', 'Webhook endpoint not found');
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b['rotateSecret'] !== true) throw new DomainError('VALIDATION_FAILED', 'Only { "rotateSecret": true } is supported');
      const ep = await d.svc.rotateSecret(endpointId, req.now, key);
      await d.audit.record({ actorId: partyId, actorRole: 'org_admin', action: 'institution.webhook.rotate', subject: endpointId, reason: 'Webhook secret rotated', payload: { institutionId } }, req.now);
      return ok(secretBody(ep));
    }),
    deleteWebhookEndpoint: route(async (req) => {
      const { institutionId, partyId } = await own(req, true);
      const endpointId = req.params['endpointId'] ?? '';
      if (!(await d.svc.deleteEndpoint(institutionId, endpointId))) throw new DomainError('NOT_FOUND', 'Webhook endpoint not found');
      await d.audit.record({ actorId: partyId, actorRole: 'org_admin', action: 'institution.webhook.delete', subject: endpointId, reason: 'Webhook endpoint deleted', payload: { institutionId } }, req.now);
      return noContent();
    }),
    listWebhookDeliveries: route(async (req) => {
      const { institutionId } = await own(req, false);
      return ok({ items: await d.svc.messages(institutionId) });
    }),
    replayAdminWebhookDelivery: route(async (req) => {
      const p = requireStaff(req, 'admin');
      await flagOn();
      const key = requireIdempotencyKey(req);
      const messageId = req.params['id'] ?? '';
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b['endpointId'] !== 'string') throw new DomainError('VALIDATION_FAILED', 'endpointId is required');
      const attempt = await d.svc.replay(messageId, b['endpointId'], p.partyId, req.now, key);
      await d.audit.record({ actorId: staffActor(p).partyId, actorRole: 'admin', action: 'ops.webhook.replay', subject: messageId, reason: 'Webhook delivery replayed', payload: { endpointId: b['endpointId'] } }, req.now);
      return ok(attempt);
    }),
  };
}
