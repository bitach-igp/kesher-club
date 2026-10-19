// EventsPort simulator: signs with real HMAC-SHA256 per the Standard Webhooks spec and "delivers" to
// an in-memory receiver map. Fixtures: a url containing "/fail" always returns 500 (drives the retry
// schedule); "/outage" -> PROVIDER_UNAVAILABLE at send. Every delivered request is kept in `delivered`.
import { createHmac, randomBytes } from 'node:crypto';
import { addMs, type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { EventsError, RETRY_SCHEDULE_MS, type DeliveryAttempt, type Endpoint, type EventsPort, type OutboundEvent, type OutboundEventType } from './events.ts';

export interface SignedRequest {
  url: string;
  headers: { 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string; 'content-type': 'application/json' };
  body: string;
}

/** Standard Webhooks signature: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)), prefixed "v1,". */
export function signStandardWebhook(secret: string, id: string, timestampSec: number, body: string): string {
  const raw = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
  return `v1,${createHmac('sha256', raw).update(`${id}.${timestampSec}.${body}`).digest('base64')}`;
}

export class EventsSimulator implements EventsPort {
  private readonly endpoints = new Map<string, Endpoint & { previousSecret?: string }>();
  private readonly messages = new Map<string, { event: OutboundEvent; body: string }>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();
  private readonly idem = new IdempotencyStore<unknown>();
  private readonly ids = new Sequence('ep');
  private readonly msgIds = new Sequence('msg');
  private readonly attIds = new Sequence('att');
  /** Test hook: every signed request the simulator "sent". */
  readonly delivered: SignedRequest[] = [];

  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  async createEndpoint(input: { institutionId: string; url: string; eventTypes: readonly OutboundEventType[] }, key: string): Promise<Endpoint> {
    if (!/^https:\/\//.test(input.url)) throw new EventsError('VALIDATION_FAILED', 'Endpoints must be https');
    return (await this.idem.run(key, async () => {
      const ep: Endpoint = { endpointId: this.ids.next(), institutionId: input.institutionId, url: input.url, secret: newSecret(), eventTypes: input.eventTypes, active: true };
      this.endpoints.set(ep.endpointId, ep);
      return { ...ep };
    })) as Endpoint;
  }

  async rotateSecret(endpointId: string, key: string): Promise<Endpoint> {
    return (await this.idem.run(key, async () => {
      const ep = this.mustEndpoint(endpointId);
      const next = { ...ep, previousSecret: ep.secret, secret: newSecret(), previousSecretValidUntil: addMs(this.clock.now(), 24 * 3_600_000).toISOString() };
      this.endpoints.set(endpointId, next);
      const { previousSecret: _p, ...out } = next;
      return out;
    })) as Endpoint;
  }

  async send(event: OutboundEvent, key: string): Promise<{ messageId: string; attempts: readonly DeliveryAttempt[] }> {
    return (await this.idem.run(key, async () => {
      const targets = [...this.endpoints.values()].filter((e) => e.active && e.institutionId === event.institutionId && e.eventTypes.includes(event.type));
      if (targets.some((e) => e.url.includes('/outage'))) throw new EventsError('PROVIDER_UNAVAILABLE', 'Simulated delivery outage');
      const messageId = this.msgIds.next();
      const body = JSON.stringify({ type: event.type, timestamp: this.clock.now().toISOString(), data: event.payload });
      this.messages.set(messageId, { event, body });
      this.attempts.set(messageId, []);
      const attempts = targets.map((ep) => this.attempt(messageId, ep, 1));
      return { messageId, attempts };
    })) as { messageId: string; attempts: readonly DeliveryAttempt[] };
  }

  async replay(messageId: string, endpointId: string, key: string): Promise<DeliveryAttempt> {
    return (await this.idem.run(key, async () => {
      if (!this.messages.has(messageId)) throw new EventsError('UNKNOWN_MESSAGE', messageId);
      const ep = this.mustEndpoint(endpointId);
      const n = (this.attempts.get(messageId) ?? []).filter((a) => a.endpointId === endpointId).length + 1;
      return this.attempt(messageId, ep, n, true);
    })) as DeliveryAttempt;
  }

  async listAttempts(messageId: string): Promise<readonly DeliveryAttempt[]> {
    const a = this.attempts.get(messageId);
    if (!a) throw new EventsError('UNKNOWN_MESSAGE', messageId);
    return a.map((x) => ({ ...x }));
  }

  /** Control-panel hook: run the next due retry for every failed attempt. */
  runRetries(): DeliveryAttempt[] {
    const out: DeliveryAttempt[] = [];
    for (const [messageId, list] of this.attempts) {
      for (const a of [...list]) {
        if (a.status === 'failed' && a.nextRetryAt && Date.parse(a.nextRetryAt) <= this.clock.now().getTime()) {
          a.status = 'exhausted'; // superseded by the retry row
          out.push(this.attempt(messageId, this.mustEndpoint(a.endpointId), a.attemptNumber + 1));
        }
      }
    }
    return out;
  }

  private attempt(messageId: string, ep: Endpoint, attemptNumber: number, replay = false): DeliveryAttempt {
    const { body } = this.messages.get(messageId)!;
    const ts = Math.floor(this.clock.now().getTime() / 1000);
    const req: SignedRequest = {
      url: ep.url,
      headers: { 'webhook-id': messageId, 'webhook-timestamp': String(ts), 'webhook-signature': signStandardWebhook(ep.secret, messageId, ts, body), 'content-type': 'application/json' },
      body,
    };
    this.delivered.push(req);
    const responseStatus = ep.url.includes('/fail') ? 500 : 200;
    const ok = responseStatus < 300;
    const retryMs = RETRY_SCHEDULE_MS[attemptNumber - 1];
    const a: DeliveryAttempt = {
      attemptId: this.attIds.next(),
      messageId,
      endpointId: ep.endpointId,
      attemptNumber,
      status: ok ? 'succeeded' : replay || retryMs === undefined ? 'exhausted' : 'failed',
      responseStatus,
      at: this.clock.now().toISOString(),
      ...(!ok && !replay && retryMs !== undefined ? { nextRetryAt: addMs(this.clock.now(), retryMs).toISOString() } : {}),
    };
    this.attempts.get(messageId)!.push(a);
    return { ...a };
  }

  private mustEndpoint(id: string) {
    const e = this.endpoints.get(id);
    if (!e) throw new EventsError('UNKNOWN_ENDPOINT', id);
    return e;
  }
}

const newSecret = (): string => `whsec_${randomBytes(24).toString('base64')}`;
