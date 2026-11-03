// TST-INS-025 (T-0649, REQ-INS-025): the Crowded webhook receiver. A signature over the raw bytes; the same payload re-serialised
// fails; a missing or sha1= header fails; a batch of three with one duplicate stores two; flag off answers 404; an older event
// after a newer one leaves the state the re-read returned; an unknown event type is stored and ignored; either rotation secret works.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeCrowdedSignature, CrowdedClient, CrowdedInstitutionBankingAdapter, FakeCrowded } from '@kesher/adapters';
import type { AchStatus, ApplicationStatus, InstitutionBankingPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { CrowdedWebhook, type CrowdedHandlers } from './crowded.ts';
import { InboundEventStore } from './store.ts';

const SECRET = 'crowded_endpoint_secret_0123456789abcdef';
const PREVIOUS = 'crowded_previous_secret_0123456789abcdef';
const now = new Date('2026-11-03T10:00:00Z');
const FLAG = 'institutions.usBanking';

let db: TestDatabase;
let on: App;
let off: App;
const event = (eventId: string, eventType: string, chapterId = 'ch1', data: Record<string, unknown> = {}) => ({ eventId, eventType, version: '1.0', timestamp: '2026-11-03T09:59:00Z', context: { partnerId: 'p1', chapterId }, data });
const batch = (...events: ReturnType<typeof event>[]) => JSON.stringify({ batchId: 'b1', count: events.length, events });
const post = (app: App, rawBody: string, headers: Record<string, string> = {}) => dispatch(app, { method: 'POST', url: '/v1/webhooks/crowded', headers, rawBody, now });
const signed = (rawBody: string, secret = SECRET) => ({ 'x-webhook-signature': computeCrowdedSignature(secret, rawBody) });
const count = async (table: 'inbound_event' | 'inbound_rejected') => Number((await db.query<{ n: string }>(`select count(*)::text as n from ops.${table} where provider = 'crowded'`)).rows[0]!.n);

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  const base = { db, registry: host.registry, market: 'IL' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example' };
  on = createApp({ ...base, flags: new StaticFlags(undefined, { [FLAG]: true }), crowdedWebhookSecrets: [SECRET, PREVIOUS] });
  off = createApp({ ...base, flags: new StaticFlags(), crowdedWebhookSecrets: [SECRET] });
}, 60_000);
afterAll(async () => db.close());

describe('POST /webhooks/crowded', () => {
  it('with the flag off answers 404 FEATURE_OFF and stores nothing, even for a signed delivery', async () => {
    const body = batch(event('off-1', 'finance.application.approved'));
    const r = await post(off, body, signed(body));
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).toContain('FEATURE_OFF');
    expect(await count('inbound_event')).toBe(0);
  });

  it('a signature over the raw bytes is stored and answered 200; the same payload with other whitespace is 401 and claims no event id', async () => {
    const body = batch(event('sig-1', 'finance.application.approved'));
    const ok = await post(on, body, signed(body));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: 1, stored: 1, duplicates: 0 });

    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    const bad = await post(on, pretty, signed(body));
    expect(bad.status).toBe(401);
    expect(await count('inbound_rejected')).toBe(1);
    // The rejected row holds a hash, never the body.
    const row = (await db.query<{ payload: Record<string, unknown> }>(`select payload from ops.inbound_rejected where provider = 'crowded'`)).rows[0]!;
    expect(row.payload).toMatchObject({ reason: 'MISMATCH', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(row.payload)).not.toContain('sig-1');
    // The genuine delivery of the same event id is still processed once: the forged one claimed nothing.
    const again = await post(on, body, signed(body));
    expect(again.body).toEqual({ received: 1, stored: 0, duplicates: 1 });
  });

  it('a missing, sha1= or malformed header is 401', async () => {
    const body = batch(event('hdr-1', 'finance.application.approved'));
    const good = signed(body)['x-webhook-signature'];
    for (const headers of [{}, { 'x-webhook-signature': good.replace('sha256=', 'sha1=') }, { 'x-webhook-signature': good.slice(7) }, { 'x-webhook-signature': 'sha256=zz' }]) {
      expect((await post(on, body, headers)).status).toBe(401);
    }
    expect((await db.query(`select 1 from ops.inbound_event where event_id = 'hdr-1'`)).rows).toHaveLength(0);
  });

  it('a batch of three with one duplicate stores two, in order', async () => {
    const body = batch(event('batch-1', 'collect.payment.succeeded'), event('batch-2', 'finance.ach_payment.sent', 'ch1', { id: 'p1' }), event('batch-1', 'collect.payment.succeeded'));
    const r = await post(on, body, signed(body));
    expect(r.body).toEqual({ received: 3, stored: 2, duplicates: 1 });
    const ids = (await db.query<{ event_id: string }>(`select event_id from ops.inbound_event where event_id like 'batch-%' order by event_id`)).rows.map((x) => x.event_id);
    expect(ids).toEqual(['batch-1', 'batch-2']);
  });

  it('accepts the previous secret during a rotation, and refuses any other', async () => {
    const body = batch(event('rot-1', 'platform.chapter.updated'));
    expect((await post(on, body, signed(body, PREVIOUS))).status).toBe(200);
    expect((await post(on, batch(event('rot-2', 'platform.chapter.updated')), signed(batch(event('rot-2', 'platform.chapter.updated')), 'some_other_secret_0123456789abcdef0123'))).status).toBe(401);
  });

  it('with no secret configured every delivery is refused', async () => {
    const none = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', flags: new StaticFlags(undefined, { [FLAG]: true }) });
    const body = batch(event('none-1', 'platform.chapter.updated'));
    expect((await post(none, body, signed(body))).status).toBe(401);
  });

  it('a signed delivery that is not a batch is refused (400/422) and stores nothing of it; one bad event refuses the whole batch', async () => {
    for (const body of ['not json', JSON.stringify({}), JSON.stringify({ events: [] }), JSON.stringify({ events: [{ eventType: 'x' }] }), JSON.stringify({ events: [event('ok-1', 'x'), { eventId: '', eventType: 'x' }] })]) {
      expect([400, 422]).toContain((await post(on, body, signed(body))).status);
    }
    expect((await db.query(`select 1 from ops.inbound_event where event_id = 'ok-1'`)).rows).toHaveLength(0);
  });

  it('the generic /hooks/crowded route never accepts a Crowded delivery', async () => {
    const body = batch(event('gen-1', 'platform.chapter.updated'));
    const r = await dispatch(on, { method: 'POST', url: '/v1/hooks/crowded', headers: signed(body), rawBody: body, now });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await db.query(`select 1 from ops.inbound_event where event_id = 'gen-1'`)).rows).toHaveLength(0);
  });
});

describe('processing: events are hints, the provider is re-read', () => {
  function rig(handlers: CrowdedHandlers, port: Partial<InstitutionBankingPort>) {
    const store = new InboundEventStore(db);
    const crowded = new CrowdedWebhook({ store, flags: new StaticFlags(undefined, { [FLAG]: true }), secrets: () => [SECRET], port: () => port as InstitutionBankingPort, handlers });
    const feed = async (e: ReturnType<typeof event>) => {
      const { event: stored } = await store.record({ provider: 'crowded', eventId: e.eventId, signatureOk: true, payload: e, receivedAt: now });
      await crowded.process(stored);
    };
    return { feed };
  }

  it('an older event after a newer one leaves the state the re-read returned: the body never decides', async () => {
    const states: AchStatus[] = [];
    const reads = vi.fn(async () => 'sent' as AchStatus); // the provider's state is `sent` now, whatever order events arrive in
    const { feed } = rig({ ach: async (_ref, status) => void states.push(status) }, { achStatus: reads });
    await feed(event('ord-2', 'finance.ach_payment.sent', 'ch1', { id: 'pay1', status: 'sent' }));
    await feed(event('ord-1', 'finance.ach_payment.processing', 'ch1', { id: 'pay1', status: 'processing' }));
    expect(states).toEqual(['sent', 'sent']);
    expect(reads).toHaveBeenCalledWith('ch1:pay1');
  });

  it('an application event passes the re-read status, not the body\'s claim', async () => {
    const seen: [string, ApplicationStatus][] = [];
    const { feed } = rig({ application: async (ref, status) => void seen.push([ref, status]) }, { applicationStatus: async () => 'pending' });
    await feed(event('app-1', 'finance.application.approved', 'ch7', { status: 'approved' }));
    expect(seen).toEqual([['ch7', 'pending']]);
  });

  it('collection events point at the entity; unknown and wire events are stored and ignored', async () => {
    const collected = vi.fn(async () => undefined);
    const never = vi.fn(async () => 'sent' as AchStatus);
    const { feed } = rig({ collected, ach: async () => undefined }, { achStatus: never });
    await feed(event('col-1', 'collect.payment.succeeded', 'ch2'));
    await feed(event('col-2', 'collect.refund.initiated', 'ch2'));
    await feed(event('unk-1', 'something.we.never.heard.of', 'ch2'));
    await feed(event('wire-1', 'finance.wire_payment.sent', 'ch2', { id: 'w1' }));
    await feed(event('plat-1', 'platform.contact.created', 'ch2'));
    expect(collected.mock.calls).toEqual([['ch2'], ['ch2']]);
    expect(never).not.toHaveBeenCalled();
  });

  it('an object id from the body that is not a plain id never reaches a URL', async () => {
    const fake = new FakeCrowded({ token: 'tok' });
    const adapter = new CrowdedInstitutionBankingAdapter({ client: new CrowdedClient({ baseUrl: 'https://sandbox.fake.invalid/api/v1', token: 'tok', fetch: fake.fetch }) });
    const store = new InboundEventStore(db);
    const crowded = new CrowdedWebhook({ store, flags: new StaticFlags(undefined, { [FLAG]: true }), secrets: () => [SECRET], port: () => adapter, handlers: { ach: async () => undefined, application: async () => undefined } });
    for (const [i, [chapter, id]] of [['..', 'p1'], ['ch1', '../x'], ['ch1/applications', 'p1'], ['ch1', 'p1?x=1']].entries()) {
      const e = event(`evil-${i}`, 'finance.ach_payment.sent', chapter, { id });
      const { event: stored } = await store.record({ provider: 'crowded', eventId: e.eventId, signatureOk: true, payload: e, receivedAt: now });
      await expect(crowded.process(stored)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const app = event('evil-app', 'finance.application.approved', '../etc');
    const { event: stored } = await store.record({ provider: 'crowded', eventId: app.eventId, signatureOk: true, payload: app, receivedAt: now });
    await expect(crowded.process(stored)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fake.calls).toHaveLength(0);
  });

  it('a handler failure is recorded for replay, not lost', async () => {
    const store = new InboundEventStore(db);
    const crowded = new CrowdedWebhook({ store, flags: new StaticFlags(undefined, { [FLAG]: true }), secrets: () => [SECRET], port: () => ({ applicationStatus: async () => 'approved' }) as unknown as InstitutionBankingPort, handlers: { application: async () => Promise.reject(new Error('db down')) } });
    const { event: stored } = await store.record({ provider: 'crowded', eventId: 'fail-1', signatureOk: true, payload: event('fail-1', 'finance.application.approved'), receivedAt: now });
    await expect(crowded.process(stored)).rejects.toThrow('db down');
  });
});
