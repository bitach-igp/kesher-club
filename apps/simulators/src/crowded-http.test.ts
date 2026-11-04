// TST-INS-022 TST-INS-023 TST-INS-024 TST-INS-025 Crowded over HTTP (T-0660). FakeCrowded is served under /crowded/api/v1 with Crowded's shapes
// (bearer auth, the `data` envelope, paging with meta.pagination, a 201 whose status is Rejected, the webhook management endpoints the registration
// script uses), and the simulator signs and POSTs batched webhooks to the registered URL: HMAC-SHA256 over the exact bytes it sends, at least once,
// optionally newest first. The adapter's client, fake and verifier come from the @kesher/adapters package (a devDependency of this one).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrowdedClient, FakeCrowded, computeCrowdedSignature, verifyCrowdedSignature } from '@kesher/adapters';
import { CrowdedHttpSimulator, MAX_DELIVERY_ATTEMPTS, WEBHOOK_EVENT_TYPES, type CrowdedBackend } from './crowded-http.ts';
import { SimulatorHost } from './host.ts';
import { createServer, handle } from './server.ts';

const TOKEN = 'sim-token-0001';
const SECRET = 'sim-webhook-secret-0123456789-abcdef';
const BASE = '/crowded/api/v1';
const SIM_HOST = 'https://crowded.sim.invalid';
const TOOL = fileURLToPath(new URL('../../../tools/crowded-webhooks.mjs', import.meta.url));
const pexec = promisify(execFile);
/** Crowded's JSON carries cents as numbers. */
const wire = (m: bigint): number => Number(m);

interface Received {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
interface Receiver {
  url: string;
  got: Received[];
  /** The status the receiver answers with. */
  reply: number;
  close(): Promise<void>;
}

const listen = (server: http.Server): Promise<number> => new Promise((resolve) => server.listen(0, () => resolve((server.address() as AddressInfo).port)));
const close = (server: http.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

async function receiver(): Promise<Receiver> {
  const r: Receiver = { url: '', got: [], reply: 200, close: async () => undefined };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c as Buffer));
    r.got.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(r.reply, { 'content-type': 'application/json' }).end('{}');
  });
  const port = await listen(server);
  r.url = `http://localhost:${port}/webhooks/crowded`;
  r.close = () => close(server);
  return r;
}

let fake: FakeCrowded;
let crowded: CrowdedHttpSimulator;
let panel: http.Server;
let origin = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  fake = new FakeCrowded({ token: TOKEN, pageSize: 2 });
  crowded = new CrowdedHttpSimulator({ backend: fake, token: TOKEN });
  panel = createServer(new SimulatorHost(), { crowded });
  origin = `http://localhost:${await listen(panel)}`;
});
afterEach(async () => {
  await close(panel);
  for (const c of closers.splice(0)) await c();
});

/** `token` null sends no Authorization header. */
const api = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
  const res = await fetch(`${origin}${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as { data?: any; meta?: any; message?: string; statusCode?: number }) : undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/** Registers a receiver the way the script does: POST /webhooks with our own secret. */
async function registered(events: string[] = ['*']): Promise<Receiver> {
  const r = await receiver();
  closers.push(r.close);
  const made = await api('POST', '/webhooks', { url: r.url, events, deliveryMode: 'at_least_once', description: 'test', secret: SECRET });
  expect(made.status).toBe(201);
  return r;
}

/** An organization, a chapter and an opened application, over HTTP; the bank decides through the simulator's control. */
async function chapter(name = 'Yeshivat Ohr'): Promise<string> {
  const org = await api('POST', '/organizations', { data: { name } });
  const ch = await api('POST', '/chapters', { data: { name, organizationId: org.json!.data.id, businessVertical: 'EducationalServices' } });
  const id = String(ch.json!.data.id);
  expect((await api('POST', `/chapters/${id}/applications/form`, { data: { contactIp: '198.51.100.4' } })).status).toBe(201);
  return id;
}

/** An approved chapter with money and one pending ACH out of it: `<chapter>:<payment>`. */
async function pendingAch(): Promise<string> {
  const id = await chapter('Ach School');
  await crowded.decide(id);
  fake.fund(id, 1_000_000n);
  const r = await api('POST', `/chapters/${id}/payments`, {
    data: { type: 'achCounterparty', payments: [{ counterpartyId: 'cp_kesher', amount: wire(50_000n), description: 'KESHER', addenda: 'KC-TEST', sameDay: false, applyFee: true, idempotencyKey: randomUUID() }] },
  });
  expect(r.status).toBe(201);
  return `${id}:${r.json!.data.id}`;
}

const eventTypes = (r: Receiver): string[] => r.got.flatMap((g) => (JSON.parse(g.body.toString('utf8')) as { events: { eventType: string }[] }).events.map((e) => e.eventType));

/** A backend whose payment read answers a fixed status, for the return rules the fake cannot reach on its own (failed). */
const backendWithStatus = (status: string): CrowdedBackend => ({
  fetch: async () => new Response(JSON.stringify({ data: { id: 'pay_x', status } }), { status: 200, headers: { 'content-type': 'application/json' } }),
  decide: () => undefined,
  pay: () => {
    throw new Error('no intents here');
  },
  advanceAch: () => undefined,
  webhook: (events) => ({ headers: {}, rawBody: JSON.stringify({ batchId: 'b_stub', count: events.length, events: events.map((e, i) => ({ eventId: `ev_stub_${i}`, eventType: e.eventType, version: '1.0', timestamp: '2026-11-03T09:00:00.000Z', context: {}, data: e.data ?? {} })) }) }),
});

describe('the API under /crowded/api/v1 (T-0660)', () => {
  it('answers 401 without the bearer token, and with a wrong one', async () => {
    expect((await api('GET', '/organizations', undefined, null)).status).toBe(401);
    expect((await api('GET', '/organizations', undefined, 'not-the-token')).status).toBe(401);
    expect((await api('POST', '/webhooks', { url: 'https://x.example/webhooks/crowded', events: ['*'] }, null)).status).toBe(401);
    expect((await api('GET', '/webhooks', undefined, null)).status).toBe(401);
    expect((await api('GET', '/organizations')).status).toBe(200);
    // The event types are public, as documented.
    const types = await api('GET', '/webhooks/event-types', undefined, null);
    expect(types.status).toBe(200);
    expect(types.json!.data.events).toEqual([...WEBHOOK_EVENT_TYPES]);
  });

  it('wraps answers in `data`, pages with meta.pagination, and the adapter\'s iterator reads the same pages from either side', async () => {
    for (const n of ['A', 'B', 'C', 'D', 'E']) expect((await api('POST', '/organizations', { data: { name: `Org ${n}` } })).status).toBe(201);
    const first = await api('GET', '/organizations?pagination[limit]=10&pagination[offset]=0');
    // The provider's cap (2 here) wins over the limit asked for.
    expect(first.json!.data).toHaveLength(2);
    expect(first.json!.meta.pagination).toMatchObject({ total: 5, limit: 2, offset: 0 });
    expect((await api('GET', '/organizations?pagination[limit]=2&pagination[offset]=4')).json!.data).toHaveLength(1);

    const direct = new CrowdedClient({ baseUrl: `${SIM_HOST}/api/v1`, token: TOKEN, fetch: fake.fetch });
    const overHttp = new CrowdedClient({ baseUrl: `${SIM_HOST}${BASE}`, token: TOKEN, fetch: (input, init) => fetch(String(input).replace(SIM_HOST, origin), init) });
    const calls = () => fake.calls.map((c) => ({ method: c.method, path: c.path, query: c.query }));
    const before = fake.calls.length;
    const ids = async (c: CrowdedClient) => {
      const out: string[] = [];
      for await (const o of c.list('/organizations')) out.push(String((o as { id: unknown }).id));
      return out;
    };
    const a = await ids(direct);
    const mid = fake.calls.length;
    const b = await ids(overHttp);
    expect(a).toHaveLength(5);
    expect(b).toEqual(a);
    // The same three page requests, in the same order, with the same offsets.
    expect(calls().slice(before, mid)).toEqual(calls().slice(mid));
    expect(calls().slice(mid).map((c) => c.query['pagination[offset]'])).toEqual(['0', '2', '4']);
  });

  it('passes a 201 whose status is Rejected through as it is', async () => {
    const id = await chapter('Rejecting School');
    await crowded.decide(id);
    const r = await api('POST', `/chapters/${id}/payments`, { data: { type: 'achCounterparty', payments: [{ counterpartyId: 'ach_rejected_201_x', amount: wire(50_000n), addenda: 'KC-REJ', idempotencyKey: randomUUID() }] } });
    expect(r.status).toBe(201);
    expect(r.json!.data).toMatchObject({ method: 'ach', status: 'Rejected' });
  });

  it('answers errors in Crowded\'s shape and never throws on a body that is not JSON', async () => {
    const res = await fetch(`${origin}${BASE}/organizations`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: 'not json {' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ statusCode: 400, message: expect.any(String) });
    expect((await api('GET', '/no/such/route')).status).toBe(404);
    expect((await api('GET', '/chapters/ch_nobody/accounts')).status).toBe(404);
  });
});

describe('webhook management, as the script uses it (T-0660)', () => {
  it('creates a registration (our secret, shown once), lists and reads it without the secret, and deletes it', async () => {
    const made = await api('POST', '/webhooks', { url: 'http://localhost:3999/webhooks/crowded', events: ['finance.application.approved'], deliveryMode: 'at_least_once', description: 'Kesher receiver', secret: SECRET });
    expect(made.status).toBe(201);
    expect(made.json!.data).toMatchObject({ url: 'http://localhost:3999/webhooks/crowded', events: ['finance.application.approved'], deliveryMode: 'at_least_once', isActive: true, hasAuthorizationHeader: false, secret: SECRET });
    const id = String(made.json!.data.id);

    const list = await api('GET', '/webhooks');
    expect(list.json!.data.map((w: { id: string }) => w.id)).toEqual([id]);
    expect(list.json!.meta.pagination).toMatchObject({ total: 1 });
    expect(list.text).not.toContain(SECRET);
    expect((await api('GET', `/webhooks/${id}`)).text).not.toContain(SECRET);

    expect((await api('DELETE', `/webhooks/${id}`)).status).toBe(204);
    expect((await api('GET', '/webhooks')).json!.data).toEqual([]);
    expect((await api('DELETE', `/webhooks/${id}`)).status).toBe(404);
    expect((await api('GET', `/webhooks/${id}`)).status).toBe(404);
  });

  it('pages the registrations across page boundaries, newest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(String((await api('POST', '/webhooks', { url: `https://webhooks.example/hook-${i}`, events: ['*'] })).json!.data.id));
    const page = async (offset: number, limit: number) => (await api('GET', `/webhooks?pagination[limit]=${limit}&pagination[offset]=${offset}`)).json!;
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const p = await page(offset, 2);
      expect(p.meta.pagination).toMatchObject({ total: 5, limit: 2, offset });
      seen.push(...p.data.map((w: { id: string }) => w.id));
    }
    expect(seen).toEqual([...ids].reverse());
    expect((await page(4, 2)).data).toHaveLength(1);
    expect((await page(6, 2)).data).toEqual([]);
    expect((await page(0, 50)).data).toHaveLength(5); // one page when the limit covers them all
  });

  it('generates a secret when none is given, and refuses a bad URL, bad events or a bad secret', async () => {
    const made = await api('POST', '/webhooks', { url: 'https://webhooks.example/webhooks/crowded', events: ['*'] });
    expect(made.status).toBe(201);
    expect(String(made.json!.data.secret)).toMatch(/^[A-Za-z0-9_\-+/=]{32,128}$/);
    for (const bad of [
      { url: 'http://webhooks.example/webhooks/crowded', events: ['*'] }, // plain http is localhost-only here
      { url: 'http://localhost.evil.example/webhooks/crowded', events: ['*'] },
      { url: 'ftp://localhost/webhooks/crowded', events: ['*'] },
      { url: 'https://webhooks.example/webhooks/crowded', events: [] },
      { url: 'https://webhooks.example/webhooks/crowded', events: ['*'], secret: 'short' },
      { url: 'https://webhooks.example/webhooks/crowded', events: ['*'], deliveryMode: 'sometimes' },
      { events: ['*'] },
    ]) {
      const r = await api('POST', '/webhooks', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.text).not.toContain('short');
    }
  });

  it('also takes the body inside the `data` envelope, as the adapter\'s client sends bodies', async () => {
    const r = await api('POST', '/webhooks', { data: { url: 'http://localhost:3999/webhooks/crowded', events: ['*'], secret: SECRET } });
    expect(r.status).toBe(201);
    expect(r.json!.data.url).toBe('http://localhost:3999/webhooks/crowded');
  });

  it('keeps the registered URL exactly as given, with no toString normalising', async () => {
    // `new URL(...).toString()` would add the trailing slash; the simulator stores the string it was given.
    const r = await api('POST', '/webhooks', { url: 'http://localhost:3998', events: ['*'] });
    expect(r.status).toBe(201);
    expect(r.json!.data.url).toBe('http://localhost:3998');
    const id = String(r.json!.data.id);
    expect((await api('GET', `/webhooks/${id}`)).json!.data.url).toBe('http://localhost:3998');
    expect((await api('GET', '/webhooks')).json!.data[0].url).toBe('http://localhost:3998');
  });
});

describe('signed, batched webhooks (T-0660, REQ-INS-025)', () => {
  it('signs the exact bytes it sends: the receiver\'s check passes over them, and fails over a re-serialised body or another secret', async () => {
    const rx = await registered();
    const id = await chapter();
    const out = await crowded.decide(id);
    expect(out.delivered).toHaveLength(1);
    expect(rx.got).toHaveLength(1);
    const got = rx.got[0]!;
    const header = got.headers['x-webhook-signature'] as string;
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyCrowdedSignature({ header, rawBody: got.body, secrets: [SECRET] })).toBeUndefined();
    expect(header).toBe(computeCrowdedSignature(SECRET, got.body));
    expect(verifyCrowdedSignature({ header, rawBody: got.body, secrets: ['another-secret-0123456789-abcdef-xyz'] })).toBe('MISMATCH');
    // The same JSON with different whitespace is different bytes, and the signature does not cover it.
    const reserialised = JSON.stringify(JSON.parse(got.body.toString('utf8')), null, 1);
    expect(verifyCrowdedSignature({ header, rawBody: reserialised, secrets: [SECRET] })).toBe('MISMATCH');

    const batch = JSON.parse(got.body.toString('utf8')) as { batchId: string; count: number; events: { eventId: string; eventType: string; context: { chapterId: string } }[] };
    expect(batch).toMatchObject({ count: 1, events: [{ eventType: 'finance.application.approved', context: { chapterId: id } }] });
    expect(got.headers['x-webhook-batch']).toBe(batch.batchId);
    expect(got.headers['x-webhook-batch-count']).toBe('1');
    expect(got.headers['x-webhook-attempt']).toBe('1');
    expect(got.headers['user-agent']).toBe('Crowded-Webhooks/1.0');
    expect(got.headers['content-type']).toContain('application/json');
  });

  it('signs a payment\'s batch with the registered secret, not the fake\'s placeholder', async () => {
    const rx = await registered();
    const id = await chapter('Paying School');
    await crowded.decide(id);
    const col = await api('POST', `/chapters/${id}/collections`, { data: { title: 'Tuition', requestedAmount: wire(25_000n) } });
    const intent = await api('POST', `/chapters/${id}/collections/${col.json!.data.id}/intents`, { data: { firstName: 'Dana', lastName: 'Levi', email: 'dana@example.org', mobile: '+14155550100', requestedAmount: wire(25_000n), payerIp: '198.51.100.7', userConsented: true } });
    rx.got.length = 0;
    const out = await crowded.pay(`${id}:${col.json!.data.id}:${intent.json!.data.id}`);
    expect(out.delivered.map((d) => d.status)).toEqual([200]);
    const got = rx.got[0]!;
    expect(got.headers['x-webhook-signature']).not.toBe('sha256=fake');
    expect(verifyCrowdedSignature({ header: got.headers['x-webhook-signature'] as string, rawBody: got.body, secrets: [SECRET] })).toBeUndefined();
    expect(eventTypes(rx)).toEqual(['collect.payment.succeeded']);
  });

  it('delivers at least once: a refusal is retried with the same bytes, and a batch can be sent again', async () => {
    const rx = await registered();
    rx.reply = 500;
    const id = await chapter();
    const first = await crowded.decide(id);
    expect(first.delivered).toMatchObject([{ status: 500, delivered: false, attempt: 1 }]);
    expect(crowded.pending()).toHaveLength(1);

    rx.reply = 200;
    const retry = await crowded.flush();
    expect(retry).toMatchObject([{ status: 200, delivered: true, attempt: 2 }]);
    expect(crowded.pending()).toHaveLength(0);
    expect(rx.got).toHaveLength(2);
    expect(rx.got[1]!.body.equals(rx.got[0]!.body)).toBe(true);
    expect(rx.got[1]!.headers['x-webhook-attempt']).toBe('2');
    expect(verifyCrowdedSignature({ header: rx.got[1]!.headers['x-webhook-signature'] as string, rawBody: rx.got[1]!.body, secrets: [SECRET] })).toBeUndefined();

    // The same batch once more: a duplicate, byte for byte.
    const batchId = (JSON.parse(rx.got[0]!.body.toString('utf8')) as { batchId: string }).batchId;
    expect(await crowded.redeliver(batchId)).toMatchObject([{ status: 200, attempt: 3 }]);
    expect(rx.got).toHaveLength(3);
    expect(rx.got[2]!.body.equals(rx.got[0]!.body)).toBe(true);
    await expect(crowded.redeliver('b_unknown')).rejects.toThrow(/unknown batch/i);
  });

  it('an unreachable receiver is a failed attempt, not an error; at_most_once tries once', async () => {
    const dead = await receiver();
    await dead.close();
    expect((await api('POST', '/webhooks', { url: dead.url, events: ['*'], secret: SECRET })).status).toBe(201);
    const id = await chapter();
    const out = await crowded.decide(id);
    expect(out.delivered).toMatchObject([{ delivered: false, attempt: 1, error: expect.any(String) }]);
    expect(crowded.pending()).toHaveLength(1);

    const once = await receiver();
    closers.push(once.close);
    once.reply = 500;
    await crowded.flush(); // the dead one fails again; it stays pending
    const hooks = (await api('GET', '/webhooks')).json!.data as { id: string }[];
    for (const h of hooks) await api('DELETE', `/webhooks/${h.id}`);
    expect((await api('POST', '/webhooks', { url: once.url, events: ['*'], secret: SECRET, deliveryMode: 'at_most_once' })).status).toBe(201);
    const id2 = await chapter('Second School');
    await crowded.decide(id2);
    once.reply = 200;
    await crowded.flush();
    // The 500 was its only attempt: nothing more goes to it for that batch.
    expect(once.got).toHaveLength(1);
  });

  it('an at_most_once batch that failed is gone: redeliver does not send it again, nor mark it delivered', async () => {
    const once = await receiver();
    closers.push(once.close);
    once.reply = 500;
    expect((await api('POST', '/webhooks', { url: once.url, events: ['*'], secret: SECRET, deliveryMode: 'at_most_once' })).status).toBe(201);
    const out = await crowded.decide(await chapter());
    expect(out.delivered).toMatchObject([{ status: 500, delivered: false, attempt: 1 }]);
    expect(crowded.pending()).toEqual([]); // abandoned, not waiting
    once.reply = 200;
    expect(await crowded.redeliver(out.batchIds[0]!)).toEqual([]);
    expect(await crowded.flush()).toEqual([]);
    expect(once.got).toHaveLength(1);
  });

  it('delivers only the event types a registration subscribed to', async () => {
    const rx = await registered(['finance.application.denied']);
    const id = await chapter();
    expect((await crowded.decide(id, 'Approved')).batchIds).toEqual([]);
    expect(rx.got).toHaveLength(0);
    const denied = await chapter('Denied School');
    await crowded.decide(denied, 'Denied');
    expect(eventTypes(rx)).toEqual(['finance.application.denied']);
  });

  it('with out-of-order on, batches wait and are released newest first; the ACH steps arrive sent before processing', async () => {
    const rx = await registered();
    const ref = await pendingAch();
    rx.got.length = 0;
    crowded.outOfOrder = true;
    const held = await crowded.settleAch(ref);
    expect(held.delivered).toEqual([]);
    expect(held.batchIds).toHaveLength(2);
    expect(rx.got).toHaveLength(0);
    expect(crowded.pending()).toHaveLength(2);
    await crowded.flush();
    expect(eventTypes(rx)).toEqual(['finance.ach_payment.sent', 'finance.ach_payment.processing']);
    expect(crowded.pending()).toHaveLength(0);
    // Back to in order: delivered as it happens.
    crowded.outOfOrder = false;
    const [chapterId] = ref.split(':');
    await crowded.decide(chapterId!, 'AwaitingDocuments');
    expect(eventTypes(rx).at(-1)).toBe('finance.application.submitted');
  });

  it('a wrong-signature switch signs with another key, so a receiver refuses and the batch stays to be retried', async () => {
    const rx = await registered();
    rx.reply = 401;
    crowded.badSignature = true;
    const id = await chapter();
    await crowded.decide(id);
    const bad = rx.got[0]!;
    expect(verifyCrowdedSignature({ header: bad.headers['x-webhook-signature'] as string, rawBody: bad.body, secrets: [SECRET] })).toBe('MISMATCH');
    expect(crowded.pending()).toHaveLength(1);
    crowded.badSignature = false;
    rx.reply = 200;
    await crowded.flush();
    const good = rx.got[1]!;
    expect(verifyCrowdedSignature({ header: good.headers['x-webhook-signature'] as string, rawBody: good.body, secrets: [SECRET] })).toBeUndefined();
  });

  it('an ACH return needs a sent payment: settled first it reads as returned and arrives as a returned event; pending, canceled and failed are refused', async () => {
    const rx = await registered();
    const ref = await pendingAch();
    rx.got.length = 0;
    const [chapterId, paymentId] = ref.split(':');
    const read = () => api('GET', `/chapters/${chapterId}/payments/${paymentId}`);
    expect((await read()).json!.data.status).toBe('pending');
    await expect(crowded.returnAch(ref)).rejects.toThrow(/only a sent/);

    // Sent: it can come back.
    await crowded.settleAch(ref);
    expect((await read()).json!.data.status).toBe('sent');
    rx.got.length = 0;
    await crowded.returnAch(ref);
    expect((await read()).json!.data.status).toBe('returned');
    expect(eventTypes(rx)).toEqual(['finance.ach_payment.returned']);
    const event = (JSON.parse(rx.got[0]!.body.toString('utf8')) as { events: { context: { chapterId: string }; data: { id: string } }[] }).events[0]!;
    expect(event.context.chapterId).toBe(chapterId);
    expect(event.data.id).toBe(paymentId);
    await expect(crowded.returnAch(ref)).rejects.toThrow(/already returned/i);
    await expect(crowded.returnAch(`${chapterId}:pay_nobody`)).rejects.toThrow(/unknown payment/i);

    // Canceled: refused.
    const ref2 = await pendingAch();
    const [ch2, pay2] = ref2.split(':');
    expect((await api('POST', `/chapters/${ch2}/payments/${pay2}/cancel`)).status).toBe(200);
    await expect(crowded.returnAch(ref2)).rejects.toThrow(/only a sent/);

    // Failed: refused.
    const failed = new CrowdedHttpSimulator({ backend: backendWithStatus('failed'), token: TOKEN });
    await expect(failed.returnAch('ch_x:pay_x')).rejects.toThrow(/only a sent/);
  });

  it('drops queued deliveries when their registration is deleted', async () => {
    const rx = await registered();
    crowded.outOfOrder = true; // the batch waits for flush
    const out = await crowded.decide(await chapter());
    expect(out.delivered).toEqual([]);
    expect(crowded.pending()).toHaveLength(1);
    const hooks = (await api('GET', '/webhooks')).json!.data as { id: string }[];
    expect(hooks).toHaveLength(1);
    expect((await api('DELETE', `/webhooks/${hooks[0]!.id}`)).status).toBe(204);
    expect(crowded.pending()).toEqual([]); // the queued entry went with the registration
    expect(await crowded.flush()).toEqual([]);
    expect(rx.got).toHaveLength(0);
  });

  it('caps delivery attempts: after MAX_DELIVERY_ATTEMPTS refusals the batch is abandoned', async () => {
    const rx = await registered();
    rx.reply = 500;
    await crowded.decide(await chapter()); // attempt 1
    for (let i = 2; i <= MAX_DELIVERY_ATTEMPTS; i++) await crowded.flush();
    expect(rx.got).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(rx.got.at(-1)!.headers['x-webhook-attempt']).toBe(String(MAX_DELIVERY_ATTEMPTS));
    expect(crowded.pending()).toEqual([]);
    expect(await crowded.flush()).toEqual([]); // nothing left to try
    expect(rx.got).toHaveLength(MAX_DELIVERY_ATTEMPTS);
  });

  it('refuses to advance a payment that is no longer moving', async () => {
    const ref = await pendingAch();
    await crowded.settleAch(ref);
    await expect(crowded.advanceAch(ref)).rejects.toThrow(/nothing to advance/i);
  });
});

describe('the control panel (T-0660)', () => {
  const host = () => new SimulatorHost();
  const ctx = (token: string | null = TOKEN) => ({ crowded, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('mounts /crowded in handle(): the bearer comes from the request\'s headers, and a body that is not JSON is Crowded\'s 400, not an exception', async () => {
    expect((await handle(host(), 'GET', `${BASE}/organizations`, '', ctx(null))).status).toBe(401);
    const ok = await handle(host(), 'GET', `${BASE}/organizations`, '', ctx());
    expect(ok.status).toBe(200);
    expect(JSON.parse(String(ok.body))).toMatchObject({ data: [], meta: { pagination: { total: 0 } } });
    expect((await handle(host(), 'POST', `${BASE}/organizations`, 'not json', ctx())).status).toBe(400);
    expect((await handle(host(), 'GET', '/crowded/elsewhere', '', ctx())).status).toBe(404);
    // Without a Crowded simulator in the context the route does not exist.
    expect((await handle(host(), 'GET', `${BASE}/organizations`, '')).status).toBe(404);
  });

  it('has hooks to decide an application, pay a collection, settle or return an ACH, release held batches and flip the switches', async () => {
    const names = crowded.controls().map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['decide', 'pay', 'settleAch', 'returnAch', 'deliver', 'redeliver', 'outOfOrder', 'badSignature']));
    const rx = await registered();
    const id = await chapter();
    const decided = await handle(host(), 'POST', '/crowded/control/decide', JSON.stringify({ chapterId: id, outcome: 'Denied' }), ctx());
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ ok: true });
    expect(eventTypes(rx)).toEqual(['finance.application.denied']);

    expect((await handle(host(), 'POST', '/crowded/control/outOfOrder', JSON.stringify({ on: 'true' }), ctx())).status).toBe(200);
    expect(crowded.outOfOrder).toBe(true);
    const ref = await pendingAch();
    const settled = await handle(host(), 'POST', '/crowded/control/settleAch', JSON.stringify({ paymentRef: ref }), ctx());
    expect(settled.status).toBe(200);
    expect(crowded.pending().length).toBeGreaterThan(0);
    expect((await handle(host(), 'POST', '/crowded/control/deliver', '', ctx())).status).toBe(200);
    expect(crowded.pending()).toHaveLength(0);
    expect((await handle(host(), 'POST', '/crowded/control/returnAch', JSON.stringify({ paymentRef: ref }), ctx())).status).toBe(200);
    expect((await handle(host(), 'POST', '/crowded/control/badSignature', JSON.stringify({ on: 'true' }), ctx())).status).toBe(200);
    expect(crowded.badSignature).toBe(true);

    const bad = await handle(host(), 'POST', '/crowded/control/decide', JSON.stringify({ chapterId: 'ch_nobody' }), ctx());
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ ok: false });
    expect((await handle(host(), 'POST', '/crowded/control/nothing', '', ctx())).status).toBe(404);
    expect((await handle(host(), 'POST', '/crowded/control/decide', 'not json', ctx())).status).toBe(400);
  });

  it('lists the controls on the panel page', async () => {
    const page = await handle(host(), 'GET', '/', '', ctx());
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain('/crowded/control/decide');
    expect(String(page.body)).toContain('/crowded/control/returnAch');
    // Without the Crowded simulator the page has none of it.
    expect(String((await handle(host(), 'GET', '/', '')).body)).not.toContain('/crowded/control');
  });
});

// Each case starts node processes: 30 s each, since a full parallel run of the workspace starves them (the default 5 s timed out there).
describe('tools/crowded-webhooks.mjs --simulator (T-0660)', { timeout: 30_000 }, () => {
  const baseEnv = (base: string, token: string) => ({ ...process.env, CROWDED_BASE_URL: base, CROWDED_API_TOKEN: token, CROWDED_WEBHOOK_SECRET: SECRET });
  const run = async (args: string[], base: string, token = 'tool-token-secret-1') => {
    try {
      const r = await pexec(process.execPath, [TOOL, ...args], { env: baseEnv(base, token) });
      return { code: 0, out: r.stdout, err: r.stderr };
    } catch (e) {
      const x = e as { code: number; stdout: string; stderr: string };
      return { code: x.code, out: x.stdout, err: x.stderr };
    }
  };
  const LOCAL = 'http://localhost:4010/crowded/api/v1';

  it('accepts an http://localhost base URL only with --simulator', async () => {
    const without = await run(['list', '--dry-run'], LOCAL);
    expect(without.code).toBe(1);
    expect(without.err).toMatch(/https/);
    const withFlag = await run(['list', '--dry-run', '--simulator'], LOCAL);
    expect(withFlag.code).toBe(0);
    expect(JSON.parse(withFlag.out)).toMatchObject({ dryRun: true, method: 'GET', url: `${LOCAL}/webhooks` });
    expect(withFlag.out).not.toContain('tool-token-secret-1');
  });

  it('still refuses every other plain-http host, even with --simulator', async () => {
    for (const base of ['http://example.com/api/v1', 'http://localhost.evil.example/api/v1', 'http://192.168.0.5:4010/api/v1', 'ftp://localhost/api/v1']) {
      const r = await run(['list', '--dry-run', '--simulator'], base);
      expect(r.code, base).toBe(1);
    }
    // The flag changes nothing for an https base.
    expect((await run(['list', '--dry-run', '--simulator'], 'https://sandbox-api.crowdedfinance.com/api/v1')).code).toBe(0);
  });

  it('registers a localhost receiver only with --simulator, and never prints the secret', async () => {
    const url = 'http://localhost:4011/webhooks/crowded';
    const without = await run(['create', '--url', url, '--dry-run'], 'https://sandbox-api.crowdedfinance.com/api/v1');
    expect(without.code).toBe(1);
    const withFlag = await run(['create', '--url', url, '--dry-run', '--simulator'], LOCAL);
    expect(withFlag.code).toBe(0);
    const printed = JSON.parse(withFlag.out) as { body: { url: string; secret: string } };
    expect(printed.body).toMatchObject({ url, secret: '<redacted>' });
    expect(withFlag.out).not.toContain(SECRET);
    expect((await run(['create', '--url', 'http://example.com/webhooks/crowded', '--dry-run', '--simulator'], LOCAL)).code).toBe(1);
  });

  it('refuses an http receiver when CROWDED_BASE_URL is https, even with --simulator; the path rule is the same for http and https', async () => {
    const HTTPS = 'https://sandbox-api.crowdedfinance.com/api/v1';
    const r = await run(['create', '--url', 'http://localhost:4011/webhooks/crowded', '--dry-run', '--simulator'], HTTPS);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/simulator/);
    // With a localhost base the http receiver is accepted, with the same path shape as https (/webhooks/crowded or /v1/webhooks/crowded).
    expect((await run(['create', '--url', 'http://localhost:4011/v1/webhooks/crowded', '--dry-run', '--simulator'], LOCAL)).code).toBe(0);
    expect((await run(['create', '--url', 'https://webhooks.example/v1/webhooks/crowded', '--dry-run', '--simulator'], LOCAL)).code).toBe(0);
    expect((await run(['create', '--url', 'http://localhost:4011/other/webhooks/crowded', '--dry-run', '--simulator'], LOCAL)).code).toBe(1);
    expect((await run(['create', '--url', 'https://webhooks.example/other/webhooks/crowded', '--dry-run'], HTTPS)).code).toBe(1);
  });

  it('registers against a running simulator: the receiver and the simulator then share the secret the script sent', async () => {
    const rx = await receiver();
    closers.push(rx.close);
    const made = await run(['create', '--url', rx.url, '--simulator'], `${origin}${BASE}`, TOKEN);
    expect(made.err).toBe('');
    expect(JSON.parse(made.out)).toMatchObject({ status: 201, body: { data: { url: rx.url, secret: '<withheld>' } } });
    const listed = await run(['list', '--simulator'], `${origin}${BASE}`, TOKEN);
    expect(listed.err).toBe('');
    expect(JSON.parse(listed.out).body.data).toHaveLength(1);
    await crowded.decide(await chapter());
    expect(verifyCrowdedSignature({ header: rx.got[0]!.headers['x-webhook-signature'] as string, rawBody: rx.got[0]!.body, secrets: [SECRET] })).toBeUndefined();
  });
});
