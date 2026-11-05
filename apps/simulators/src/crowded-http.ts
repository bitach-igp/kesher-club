// Crowded over HTTP (T-0660). The in-memory Crowded of the adapter's contract suite (FakeCrowded, T-0648) is served under
// /crowded/api/v1 with Crowded's shapes as documented in docs/vendors/crowded/api-inventory.md: bearer auth, the `data` envelope,
// `pagination[limit|offset]` with `meta.pagination.total`, a 201 whose status is Rejected, and the webhook management endpoints the
// registration script uses (tools/crowded-webhooks.mjs). The simulator also plays Crowded's webhook sender: it signs a batch and POSTs it to
// every registered URL as `X-Webhook-Signature: sha256=<hex>`, the HMAC-SHA256 of the exact bytes it sends under the registration's secret,
// at least once (a refused batch stays queued and goes again, up to MAX_DELIVERY_ATTEMPTS tries) and, when the panel switch is on, newest first.
//
// This package's tests import the adapter's client, fake and verifier from @kesher/adapters (a devDependency);
// the simulator itself stays dependency-free: the backend is a structural type (FakeCrowded satisfies it) and the
// HMAC is node:crypto's, computed the way the receiver's `verifyCrowdedSignature` checks it. Local and preview only,
// like the rest of the host.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PanelResponse } from './server.ts';

type Json = Record<string, unknown>;
type HeaderMap = Readonly<Record<string, string | string[] | undefined>>;

/** What this layer needs of the Crowded in memory behind it. */
export interface CrowdedBackend {
  fetch: typeof globalThis.fetch;
  decide(chapterId: string, outcome?: 'Approved' | 'Denied' | 'AwaitingDocuments'): void;
  /** A funder pays an intent (`<chapter>:<collection>:<intent>`); answers the webhook batch for it (its signature is the fake's, so it is ignored). */
  pay(intentRef: string): { headers: Record<string, string>; rawBody: string };
  /** pending -> processing -> sent. */
  advanceAch(paymentRef: string): void;
  /** A batch of these events, with fresh ids; the signature in `headers` is the fake's, so it is ignored. */
  webhook(events: { eventType: string; data?: Json; chapterId?: string }[]): { headers: Record<string, string>; rawBody: string };
}

export interface CrowdedHttpOptions {
  backend: CrowdedBackend;
  /** The bearer token the API checks. */
  token: string;
  /** The page cap of the lists this layer serves itself (webhook registrations); the backend caps its own. */
  pageSize?: number;
  /** The client webhooks go out on (tests may inject one). */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface CrowdedEvent {
  eventType: string;
  data?: Json;
  chapterId?: string;
}

/** One attempt to deliver one batch to one registration. */
export interface Delivery {
  batchId: string;
  registrationId: string;
  /** 1 for the first try. */
  attempt: number;
  delivered: boolean;
  /** The receiver's HTTP status, when it answered. */
  status?: number;
  /** The start of the receiver's answer (diagnostics). */
  response?: string;
  /** Set when the receiver could not be reached. */
  error?: string;
}

export interface ControlResult {
  /** The batches queued by this control (one per subscribed registration, same id). */
  batchIds: string[];
  /** What went out right away. Empty while out-of-order is on: the batches wait for `flush`. */
  delivered: Delivery[];
}

export interface ControlDescriptor {
  name: string;
  describe: string;
  args: readonly string[];
}

/** Event types a registration may subscribe to: the Get Event Types list plus the origination events documented separately (api-inventory 5.4). */
export const WEBHOOK_EVENT_TYPES: readonly string[] = [
  'collect.collection.created', 'collect.collection.updated', 'collect.collection.canceled',
  'collect.payment.pending', 'collect.payment.processing', 'collect.payment.succeeded', 'collect.payment.failed', 'collect.payment.canceled', 'collect.payment.returned', 'collect.payment.refunded',
  'collect.payment_plan.created', 'collect.payment_plan.canceled', 'collect.payment_plan.completed',
  'collect.refund.initiated', 'collect.refund.processing', 'collect.refund.reversed',
  'collect.intent.created', 'collect.intent.updated',
  'platform.organization.created', 'platform.organization.updated', 'platform.organization.archived',
  'platform.chapter.created', 'platform.chapter.updated', 'platform.chapter.archived',
  'platform.contact.created', 'platform.contact.updated', 'platform.contact.archived', 'platform.contacts.bulk_created',
  'finance.account.created', 'finance.account.updated', 'finance.account.closed',
  'finance.application.submitted', 'finance.application.approved', 'finance.application.denied',
  'finance.transaction.created',
  'finance.authorization.created', 'finance.authorization.declined', 'finance.authorization.canceled', 'finance.authorization.amount_changed',
  'finance.ach_payment.processing', 'finance.ach_payment.sent', 'finance.ach_payment.returned', 'finance.ach_payment.canceled', 'finance.ach_payment.failed',
  'finance.wire_payment.sent', 'finance.wire_payment.returned', 'finance.wire_payment.canceled', 'finance.wire_payment.failed',
];

interface Registration {
  id: string;
  url: string;
  events: string[];
  deliveryMode: 'at_least_once' | 'at_most_once';
  description: string | null;
  isActive: boolean;
  secret: string;
  authorizationHeader: string | undefined;
  createdAt: string;
  updatedAt: string;
}

interface Batch {
  batchId: string;
  count: number;
  events: { eventId: string; eventType: string }[];
}

interface Entry {
  batchId: string;
  registrationId: string;
  /** The bytes that are signed and sent, fixed when the batch is queued. */
  body: string;
  attempt: number;
  delivered: boolean;
  abandoned: boolean;
}

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const SECRET_FORMAT = /^[A-Za-z0-9_\-+/=]{32,128}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1']);
/** A delivery is tried at most this often, however the registration is set: Crowded's own retry ceiling is finite too. */
export const MAX_DELIVERY_ATTEMPTS = 10;

/** `sha256=<hex>`: the HMAC-SHA256 of the raw bytes, which is what the receiver verifies. */
const sign = (secret: string, bytes: Uint8Array): string => `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;

const problem = (status: number, message: string, code?: string): PanelResponse => ({
  status,
  body: { type: status === 400 ? 'ResourceInputError' : 'Error', statusCode: status, message, ...(code ? { code } : {}), requestId: 'req_sim' },
});
const data = (value: unknown, status = 200, meta?: Json): PanelResponse => ({ status, body: { data: value, ...(meta ? { meta } : {}) } as Json });

export class CrowdedHttpSimulator {
  /** Hold batches and release them newest first on `flush` (the panel's switch). */
  outOfOrder = false;
  /** Sign deliveries with another key, so a receiver must refuse them (the panel's switch; the fake's wh_bad_sig). */
  badSignature = false;

  private readonly backend: CrowdedBackend;
  private readonly token: string;
  private readonly pageSize: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly registrations = new Map<string, Registration>();
  private readonly entries: Entry[] = [];
  /** Payments the panel returned: Crowded's API answers them as `returned` (the fake has no such status of its own). */
  private readonly returned = new Set<string>();
  private readonly table: Record<string, { describe: string; args: readonly string[]; run(a: Record<string, string>): Promise<unknown> | unknown }>;

  constructor(opts: CrowdedHttpOptions) {
    this.backend = opts.backend;
    this.token = opts.token;
    this.pageSize = opts.pageSize ?? 100;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    const on = (v: string | undefined): boolean => v === 'true' || v === '1' || v === 'on';
    this.table = {
      decide: { describe: "The bank decides a chapter's application (outcome: Approved | Denied | AwaitingDocuments); sends the signed application webhook", args: ['chapterId', 'outcome'], run: (a) => this.decide(a['chapterId'] ?? '', outcomeOf(a['outcome'])) },
      pay: { describe: 'A funder pays a payment page (intentRef <chapter>:<collection>:<intent>); sends collect.payment.succeeded', args: ['intentRef'], run: (a) => this.pay(a['intentRef'] ?? '') },
      settleAch: { describe: 'An ACH moves on to sent (pending, processing, sent); sends each step', args: ['paymentRef'], run: (a) => this.settleAch(a['paymentRef'] ?? '') },
      returnAch: { describe: 'An ACH is returned (only a sent one can be); the payment reads as returned from now on; sends finance.ach_payment.returned', args: ['paymentRef'], run: (a) => this.returnAch(a['paymentRef'] ?? '') },
      deliver: { describe: 'Send every queued or refused batch now (newest first while out-of-order is on)', args: [], run: () => this.flush() },
      redeliver: { describe: 'Send a batch again, byte for byte (a duplicate)', args: ['batchId'], run: (a) => this.redeliver(a['batchId'] ?? '') },
      outOfOrder: { describe: 'on | off: hold batches and release them newest first on deliver', args: ['on'], run: (a) => (this.outOfOrder = on(a['on'])) },
      badSignature: { describe: 'on | off: sign deliveries with a wrong key', args: ['on'], run: (a) => (this.badSignature = on(a['on'])) },
    };
  }

  // ---- HTTP ---------------------------------------------------------------------------------------------------------

  /** `path` is what follows `/crowded`: `/api/v1/...` is Crowded's API, `/control/<name>` is the panel's. */
  async route(req: { method: string; path: string; search?: string; headers: HeaderMap; rawBody: string }): Promise<PanelResponse> {
    try {
      if (req.path === '/api/v1' || req.path.startsWith('/api/v1/')) return await this.api(req.method, req.path.slice('/api/v1'.length) || '/', req.search ?? '', req.headers, req.rawBody);
      const control = /^\/control\/([A-Za-z]+)$/.exec(req.path);
      if (control && req.method === 'POST') return await this.controlRoute(control[1]!, req.rawBody);
      return { status: 404, body: { error: 'not_found' } };
    } catch (e) {
      return problem(500, `The simulator failed: ${(e as Error).message}`);
    }
  }

  private async api(method: string, rest: string, search: string, headers: HeaderMap, rawBody: string): Promise<PanelResponse> {
    const isPublic = method === 'GET' && rest === '/webhooks/event-types';
    const auth = headers['authorization'];
    if (!isPublic && (typeof auth !== 'string' || auth !== `Bearer ${this.token}`)) return problem(401, 'Unauthorized');
    let body: unknown;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return problem(400, 'The body is not JSON', 'VALIDATION_ERROR');
      }
    }
    const query = new URLSearchParams(search);
    if (rest === '/webhooks' || rest.startsWith('/webhooks/')) return this.webhooks(method, rest, query, body);

    // Everything else is the in-memory Crowded, reached the way the adapter's client reaches it.
    const res = await this.backend.fetch(`http://crowded.sim.invalid/api/v1${rest}${search}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
      ...(rawBody ? { body: rawBody } : {}),
    });
    let text = await res.text();
    const payment = method === 'GET' && res.ok ? /^\/chapters\/([^/]+)\/payments\/([^/]+)$/.exec(rest) : null;
    if (payment && this.returned.has(`${payment[1]}:${payment[2]}`)) {
      const parsed = JSON.parse(text) as { data?: Json };
      if (isRecord(parsed.data)) text = JSON.stringify({ ...parsed, data: { ...parsed.data, status: 'returned' } });
    }
    return { status: res.status, body: text, contentType: 'application/json; charset=utf-8' };
  }

  // ---- webhook management (api-inventory 4.14) ------------------------------------------------------------------------

  private view(r: Registration, withSecret = false): Json {
    return {
      id: r.id,
      url: r.url,
      events: r.events,
      deliveryMode: r.deliveryMode,
      description: r.description,
      isActive: r.isActive,
      hasAuthorizationHeader: r.authorizationHeader !== undefined,
      ...(withSecret ? { secret: r.secret } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private webhooks(method: string, rest: string, q: URLSearchParams, body: unknown): PanelResponse {
    if (method === 'GET' && rest === '/webhooks/event-types') {
      const events = [...WEBHOOK_EVENT_TYPES];
      const byNamespace: Record<string, string[]> = {};
      for (const e of events) (byNamespace[e.split('.')[0]!] ??= []).push(e);
      return data({ events, byNamespace, wildcardSupported: true });
    }
    if (method === 'POST' && rest === '/webhooks') return this.create(body);
    if (method === 'GET' && rest === '/webhooks') {
      const live = [...this.registrations.values()].filter((r) => r.isActive).reverse();
      const limit = Math.max(1, Math.min(Number(q.get('pagination[limit]') ?? 10) || 10, this.pageSize));
      const offset = Math.max(0, Number(q.get('pagination[offset]') ?? 0) || 0);
      return data(live.slice(offset, offset + limit).map((r) => this.view(r)), 200, { pagination: { total: live.length, limit, offset, sort: 'createdAt', order: 'DESC' } });
    }
    const one = /^\/webhooks\/([A-Za-z0-9_-]{1,64})$/.exec(rest);
    if (one) {
      const r = this.registrations.get(one[1]!);
      if (!r || !r.isActive) return problem(404, 'Webhook not found');
      if (method === 'GET') return data(this.view(r));
      if (method === 'DELETE') {
        // A soft delete: a delivery already in flight may still complete, but nothing still queued is sent to it.
        r.isActive = false;
        r.updatedAt = this.now().toISOString();
        for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.registrationId === r.id) this.entries.splice(i, 1);
        return { status: 204, body: '', contentType: 'text/plain; charset=utf-8' };
      }
    }
    return problem(404, 'No such route');
  }

  private create(body: unknown): PanelResponse {
    const d = isRecord(body) && isRecord(body['data']) ? body['data'] : isRecord(body) ? body : {};
    const bad = (message: string): PanelResponse => problem(400, message, 'VALIDATION_ERROR');
    // The URL is kept exactly as given (no toString normalising); the parse below only validates it.
    const rawUrl = typeof d['url'] === 'string' ? d['url'] : '';
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return bad('url is required');
    }
    // The real service takes HTTPS only. Plain http to this machine is what lets a local receiver be registered against the simulator.
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) return bad('url must be HTTPS (http only to localhost, on the simulator)');
    const events = d['events'];
    if (!Array.isArray(events) || events.length === 0 || events.some((e) => typeof e !== 'string' || !(e === '*' || WEBHOOK_EVENT_TYPES.includes(e)))) return bad('events must list subscribable event types, or ["*"]');
    const mode = d['deliveryMode'] ?? 'at_least_once';
    if (mode !== 'at_least_once' && mode !== 'at_most_once') return bad('deliveryMode must be at_least_once or at_most_once');
    if (d['description'] !== undefined && (typeof d['description'] !== 'string' || d['description'].length > 500)) return bad('description is at most 500 characters');
    if (d['secret'] !== undefined && (typeof d['secret'] !== 'string' || !SECRET_FORMAT.test(d['secret']))) return bad('secret must be 32-128 characters of A-Za-z0-9_-+/=');
    if (d['authorizationHeader'] !== undefined && (typeof d['authorizationHeader'] !== 'string' || d['authorizationHeader'].length > 2048)) return bad('authorizationHeader is at most 2048 characters');
    const at = this.now().toISOString();
    const r: Registration = {
      id: randomUUID(),
      url: rawUrl,
      events: (events as string[]).includes('*') ? ['*'] : [...(events as string[])],
      deliveryMode: mode,
      description: typeof d['description'] === 'string' ? d['description'] : null,
      isActive: true,
      // Generated when absent; shown once, on create, as the real service does.
      secret: typeof d['secret'] === 'string' ? d['secret'] : randomBytes(32).toString('base64url'),
      authorizationHeader: typeof d['authorizationHeader'] === 'string' ? d['authorizationHeader'] : undefined,
      createdAt: at,
      updatedAt: at,
    };
    this.registrations.set(r.id, r);
    return data(this.view(r, true), 201);
  }

  // ---- control hooks: what happens outside the API --------------------------------------------------------------------

  controls(): ControlDescriptor[] {
    return Object.entries(this.table).map(([name, c]) => ({ name, describe: c.describe, args: c.args }));
  }

  private async controlRoute(name: string, rawBody: string): Promise<PanelResponse> {
    const control = this.table[name];
    if (!control) return { status: 404, body: { error: 'unknown_control', control: name } };
    let args: Json = {};
    if (rawBody) {
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (isRecord(parsed)) args = parsed;
      } catch {
        return { status: 400, body: { error: 'bad_request', detail: 'The body is not JSON' } };
      }
    }
    try {
      const a = Object.fromEntries(control.args.map((k) => [k, String(args[k] ?? '')]));
      return { status: 200, body: { ok: true, result: await control.run(a) } as Json };
    } catch (e) {
      return { status: 422, body: { ok: false, error: name, detail: (e as Error).message } };
    }
  }

  /** The bank decides a chapter's application and Crowded sends the event. */
  async decide(chapterId: string, outcome: 'Approved' | 'Denied' | 'AwaitingDocuments' = 'Approved'): Promise<ControlResult> {
    this.backend.decide(chapterId, outcome);
    const eventType = outcome === 'Approved' ? 'finance.application.approved' : outcome === 'Denied' ? 'finance.application.denied' : 'finance.application.submitted';
    return this.emit([{ eventType, chapterId, data: { chapterId, status: outcome.toLowerCase() } }]);
  }

  /** A funder pays; the batch is the fake's own `collect.payment.succeeded`, signed here with the registration's secret. */
  async pay(intentRef: string): Promise<ControlResult> {
    return this.release(this.queue(this.backend.pay(intentRef).rawBody));
  }

  /** One step of an ACH (pending, processing, sent) and its event. */
  async advanceAch(paymentRef: string): Promise<ControlResult> {
    return this.release(await this.step(paymentRef));
  }

  /** The ACH goes on until it is sent, and every step is announced. */
  async settleAch(paymentRef: string): Promise<ControlResult> {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      if ((await this.paymentStatus(paymentRef)) === 'sent') break;
      ids.push(...(await this.step(paymentRef)));
    }
    return this.release(ids);
  }

  /**
   * The ACH comes back. Only a `sent` payment can be returned: a pending, processing, canceled or failed one is refused.
   * The fake has no returned status, so the simulator answers every read of this payment as `returned` from now on,
   * which is what the receiver's re-read sees. The fake's own balances are not touched.
   */
  async returnAch(paymentRef: string): Promise<ControlResult> {
    const status = await this.paymentStatus(paymentRef);
    if (status === 'returned') throw new Error('payment is already returned');
    if (status !== 'sent') throw new Error(`payment is ${status}; only a sent payment can be returned`);
    this.returned.add(paymentRef);
    return this.release(this.queueAch(paymentRef, 'returned'));
  }

  /** Any batch of events, in Crowded's envelope. */
  async emit(events: CrowdedEvent[]): Promise<ControlResult> {
    return this.release(this.queue(this.backend.webhook(events).rawBody));
  }

  // ---- delivery ---------------------------------------------------------------------------------------------------------

  /** Batches queued and not delivered (or abandoned). */
  pending(): { batchId: string; registrationId: string; attempt: number }[] {
    return this.entries.filter((e) => !e.delivered && !e.abandoned).map((e) => ({ batchId: e.batchId, registrationId: e.registrationId, attempt: e.attempt }));
  }

  /** Tries every pending batch once, oldest first, or newest first while out-of-order is on. A refused one stays for the next call. */
  async flush(): Promise<Delivery[]> {
    const due = this.entries.filter((e) => !e.delivered && !e.abandoned);
    if (this.outOfOrder) due.reverse();
    const out: Delivery[] = [];
    for (const e of due) out.push(await this.attempt(e));
    return out;
  }

  /** The same bytes once more: Crowded's duplicates. */
  async redeliver(batchId: string): Promise<Delivery[]> {
    const known = this.entries.filter((e) => e.batchId === batchId);
    if (known.length === 0) throw new Error(`unknown batch ${batchId}`);
    // An at_most_once batch that failed was tried once and is gone: it is not sent again.
    const again = known.filter((e) => !e.abandoned);
    const out: Delivery[] = [];
    for (const e of again) out.push(await this.attempt(e));
    return out;
  }

  private async release(batchIds: string[]): Promise<ControlResult> {
    return { batchIds, delivered: this.outOfOrder ? [] : await this.flush() };
  }

  /** Queues one entry per active registration that subscribed to something in the batch, with the bytes that will be signed. */
  private queue(rawBody: string): string[] {
    const batch = JSON.parse(rawBody) as Batch;
    const ids = new Set<string>();
    for (const reg of this.registrations.values()) {
      if (!reg.isActive) continue;
      const events = batch.events.filter((e) => reg.events.includes('*') || reg.events.includes(e.eventType));
      if (events.length === 0) continue;
      this.entries.push({ batchId: batch.batchId, registrationId: reg.id, body: JSON.stringify({ ...batch, count: events.length, events }), attempt: 0, delivered: false, abandoned: false });
      ids.add(batch.batchId);
    }
    return [...ids];
  }

  private async attempt(e: Entry): Promise<Delivery> {
    const reg = this.registrations.get(e.registrationId)!;
    // The bytes signed are the bytes sent: nothing re-serialises between the two.
    const bytes = Buffer.from(e.body, 'utf8');
    const signature = sign(this.badSignature ? `${reg.secret}.wrong` : reg.secret, bytes);
    e.attempt += 1;
    const d: Delivery = { batchId: e.batchId, registrationId: e.registrationId, attempt: e.attempt, delivered: false };
    try {
      const res = await this.fetchFn(reg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-batch': e.batchId,
          'x-webhook-batch-count': String((JSON.parse(e.body) as Batch).count),
          'x-webhook-signature': signature,
          'x-webhook-attempt': String(e.attempt),
          'user-agent': 'Crowded-Webhooks/1.0',
          ...(reg.authorizationHeader ? { authorization: reg.authorizationHeader } : {}),
        },
        body: new Uint8Array(bytes),
        signal: globalThis.AbortSignal.timeout(30_000),
      });
      d.status = res.status;
      d.response = (await res.text().catch(() => '')).slice(0, 500);
      d.delivered = res.status >= 200 && res.status < 300;
    } catch (err) {
      d.error = err instanceof Error ? err.name : 'error';
    }
    if (d.delivered) e.delivered = true;
    else if (reg.deliveryMode === 'at_most_once' || e.attempt >= MAX_DELIVERY_ATTEMPTS) e.abandoned = true;
    return d;
  }

  // ---- ACH ------------------------------------------------------------------------------------------------------------

  /** The payment's status as the API answers it now (a returned payment reads `returned`). */
  private async paymentStatus(paymentRef: string): Promise<string> {
    const [chapterId, paymentId, ...extra] = paymentRef.split(':');
    if (!chapterId || !paymentId || extra.length > 0) throw new Error('unknown payment');
    if (this.returned.has(paymentRef)) return 'returned'; // only a payment that was read and found is ever added to the set
    const res = await this.backend.fetch(`http://crowded.sim.invalid/api/v1/chapters/${encodeURIComponent(chapterId)}/payments/${encodeURIComponent(paymentId)}`, { method: 'GET', headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error('unknown payment');
    const body = (await res.json()) as { data?: { status?: unknown } };
    return String(body.data?.status ?? '').toLowerCase();
  }

  private async step(paymentRef: string): Promise<string[]> {
    const before = await this.paymentStatus(paymentRef);
    if (before !== 'pending' && before !== 'processing') throw new Error(`payment is ${before}; nothing to advance`);
    this.backend.advanceAch(paymentRef);
    return this.queueAch(paymentRef, await this.paymentStatus(paymentRef));
  }

  private queueAch(paymentRef: string, status: string): string[] {
    if (!['processing', 'sent', 'returned', 'canceled', 'failed'].includes(status)) return [];
    const [chapterId, paymentId] = paymentRef.split(':');
    const raw = this.backend.webhook([{ eventType: `finance.ach_payment.${status}`, chapterId: chapterId!, data: { id: paymentId!, paymentId: paymentId!, chapterId: chapterId!, status } }]).rawBody;
    return this.queue(raw);
  }
}

function outcomeOf(v: string | undefined): 'Approved' | 'Denied' | 'AwaitingDocuments' {
  if (v === undefined || v === '') return 'Approved';
  if (v === 'Approved' || v === 'Denied' || v === 'AwaitingDocuments') return v;
  throw new Error('outcome must be Approved, Denied or AwaitingDocuments');
}
