// TST-NOT-002: outbound webhooks use Standard Webhooks signing with retries (exponential backoff,
// 72 h) and a replay UI. Given a 500 from the receiver, retries at 5 s, 5 m, 30 m, 2 h, 8 h, 24 h.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { EventsSimulator, RETRY_SCHEDULE_MS, fixedClock, type AdvanceableClock, type DeliveryAttempt, type EventsPort } from '@kesher/ports';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { SimulatorHost } from '@kesher/simulators';
import { createApp, type App } from '../app.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { dispatch } from '../server.ts';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { OutboxPublisher, enqueue } from '../transfers/outbox.ts';
import { OutboundEventsService, assertPublicHttpsUrl } from './outbound.ts';
import { PostgresPreferenceStore } from '../notify/preferences.ts';

let db: TestDatabase;
let clock: AdvanceableClock;
let sim: EventsSimulator;
let svc: OutboundEventsService;
let institutionId: string;
const staff = uuidv7();

beforeAll(async () => {
  db = await createTestDatabase();
  clock = fixedClock('2026-11-01T10:00:00Z') as AdvanceableClock;
  sim = new EventsSimulator(clock);
  svc = new OutboundEventsService(db, sim);
  institutionId = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshiva', 'IL')`, [institutionId]);
}, 60_000);
afterAll(async () => db.close());

describe('outbound webhooks (REQ-NOT-002)', () => {
  it('registers an https endpoint, returns the secret once, and never stores it', async () => {
    const ep = await svc.createEndpoint({ institutionId, url: 'https://console.yeshiva.example/hooks/kesher', eventTypes: ['collection.paid', 'allowance.run.completed'], createdBy: staff }, clock.now());
    expect(ep.secret).toMatch(/^whsec_/);
    const row = await db.query('select * from notify.outbound_endpoint where endpoint_id = $1', [ep.endpointId]);
    expect(JSON.stringify(row.rows)).not.toContain(ep.secret);
    await expect(svc.createEndpoint({ institutionId, url: 'http://plain.example', eventTypes: ['collection.paid'], createdBy: staff }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(svc.createEndpoint({ institutionId, url: 'https://x.example', eventTypes: ['made.up' as never], createdBy: staff }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('an institution-facing outbox message becomes a signed, thin webhook; other messages are ignored', async () => {
    const ci = uuidv7();
    await db.transaction((tx) => enqueue(tx, 'collection', ci, 'collection.paid', { institutionId, collectionItemId: ci, memberName: 'Noa Levi', amount: { minor: '120000', currency: 'ILS' } }));
    await db.transaction((tx) => enqueue(tx, 'transfer', uuidv7(), 'transfer.settled', { amount: { minor: '1', currency: 'USD' } }));
    const r = await new OutboxPublisher(db, svc).publishBatch();
    expect(r.failed).toBe(0);
    expect(sim.delivered.length).toBe(1);
    const body = JSON.parse(sim.delivered[0]!.body) as { type: string; data: Record<string, string> };
    expect(body.type).toBe('collection.paid');
    expect(body.data).toEqual({ institutionId, collectionItemId: ci, aggregateId: ci }); // ids only: no name, no amount
    expect(sim.delivered[0]!.headers['webhook-signature']).toMatch(/^v1,/);
    const listed = await svc.messages(institutionId);
    expect(listed.length).toBe(1);
    expect(listed[0]!.attempts[0]!.status).toBe('succeeded');
  });

  it('a failing receiver follows the retry ladder, and ops can replay a message to one endpoint', async () => {
    const other = uuidv7();
    await db.query(`insert into org.institution (id, name, market) values ($1, 'Seminary', 'IL')`, [other]);
    const ep = await svc.createEndpoint({ institutionId: other, url: 'https://sem.example/hooks/fail', eventTypes: ['allowance.run.completed'], createdBy: staff }, clock.now());
    await db.transaction((tx) => enqueue(tx, 'allowance_run', uuidv7(), 'allowance.run.completed', { institutionId: other, paid: '12', failures: '0' }));
    await new OutboxPublisher(db, svc).publishBatch();
    const [msg] = await svc.messages(other);
    expect(msg!.attempts[0]).toMatchObject({ status: 'failed', attemptNumber: 1 });
    expect(Date.parse(msg!.attempts[0]!.nextRetryAt!) - clock.now().getTime()).toBe(RETRY_SCHEDULE_MS[0]);
    for (const ms of RETRY_SCHEDULE_MS) {
      clock.advance(ms);
      sim.runRetries();
    }
    const after = await svc.messages(other);
    expect(after[0]!.attempts.at(-1)).toMatchObject({ attemptNumber: 7, status: 'exhausted' });
    const replayed = await svc.replay(msg!.messageId, ep.endpointId, staff, clock.now());
    expect(replayed.attemptNumber).toBe(8);
    await expect(svc.replay(msg!.messageId, 'ep_other', staff, clock.now())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('secret rotation keeps the old secret valid for 24 h and is recorded', async () => {
    const ep = await svc.createEndpoint({ institutionId, url: 'https://console.yeshiva.example/hooks/v2', eventTypes: ['collection.paid'], createdBy: staff }, clock.now());
    const rotated = await svc.rotateSecret(ep.endpointId, clock.now());
    expect(rotated.secret).not.toBe(ep.secret);
    expect(rotated.previousSecretValidUntil).toBe(new Date(clock.now().getTime() + 24 * 3_600_000).toISOString());
    expect((await db.query<{ rotated_at: string | null }>('select rotated_at from notify.outbound_endpoint where endpoint_id = $1', [ep.endpointId])).rows[0]!.rotated_at).toBeTruthy();
  });
});

describe('notification preferences store (REQ-NOT-001)', () => {
  it('round-trips preferences and refuses opting out of security or emergency', async () => {
    const store = new PostgresPreferenceStore(db);
    const party = uuidv7();
    expect(await store.get(party)).toBeUndefined();
    const saved = await store.set(party, { optOut: ['marketing'], channels: { money: ['email'] }, timeZone: 'America/New_York', quietHours: { start: '22:00', end: '08:00' } }, clock.now());
    expect(await store.get(party)).toEqual(saved);
    await expect(store.set(party, { optOut: ['security' as never] }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(store.set(party, { timeZone: 'Mars/Olympus' }, clock.now())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('endpoint URLs are public https host names (SSRF)', () => {
  it.each([
    'http://hooks.example/x',
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://0x7f.1/x',
    'https://2130706433/x',
    'https://localhost/x',
    'https://metadata.google.internal/x',
    'https://printer.local/x',
    'https://intranet/x',
    'https://user:pw@hooks.example/x',
    'https://hooks.example:8443/x',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertPublicHttpsUrl(url)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
  it('accepts a public https name', () => {
    expect(() => assertPublicHttpsUrl('https://hooks.yeshiva.example:443/kesher?x=1')).not.toThrow();
  });
});

describe('webhook endpoint routes (T-0688, REQ-NOT-002)', () => {
  const NOW = new Date('2026-11-10T09:00:00Z');
  let hdb: TestDatabase;
  let host: SimulatorHost;
  let on: App;
  let off: App;
  let adminToken: string;
  const ohr = uuidv7(NOW);
  const sem = uuidv7(NOW);
  const who: Record<string, string> = {};
  const tok: Record<string, string> = {};

  const call = (app: App, method: string, url: string, token: string, body?: unknown, key?: string) =>
    dispatch(app, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
  type Created = { endpointId: string; secret: string; url: string };

  beforeAll(async () => {
    hdb = await createTestDatabase();
    host = new SimulatorHost();
    const pair = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
    const base = { db: hdb, market: 'IL' as const, issuer: 'https://api.kesher.example', clock: () => NOW, staffJwks: [jwk] };
    on = createApp({ ...base, registry: host.registry, signingKey: await generateSigningKey(), flags: new StaticFlags(undefined, { 'webhooks.outbound': true }) });
    off = createApp({ ...base, registry: new SimulatorHost().registry, signingKey: await generateSigningKey(), flags: new StaticFlags() });
    adminToken = await new SignJWT({ roles: ['admin'] }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject('ops-1').setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(pair.privateKey);
    await hdb.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Seminary', 'IL')`, [ohr, sem]);
    for (const [name, inst, role] of [['rivka', ohr, 'admin'], ['coordinator', ohr, 'staff'], ['sarah', sem, 'admin']] as const) {
      who[name] = uuidv7(NOW);
      await hdb.query('insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)', [who[name], inst, role]);
      // The two apps share one signing key per app: tokens are minted per app below.
    }
    tok['rivka'] = (await on.services.tokens.issue({ partyId: who['rivka']!, deviceId: 'web', roles: ['member', 'org_admin'] })).accessToken;
    tok['coordinator'] = (await on.services.tokens.issue({ partyId: who['coordinator']!, deviceId: 'web', roles: ['member', 'org_staff'] })).accessToken;
    tok['sarah'] = (await on.services.tokens.issue({ partyId: who['sarah']!, deviceId: 'web', roles: ['member', 'org_admin'] })).accessToken;
    tok['rivkaOff'] = (await off.services.tokens.issue({ partyId: who['rivka']!, deviceId: 'web', roles: ['member', 'org_admin'] })).accessToken;
    tok['adminOff'] = adminToken;
  }, 60_000);
  afterAll(async () => hdb.close());

  it('with the flag off every route answers FEATURE_OFF 404, an admin\'s replay too', async () => {
    const e = `/institutions/${ohr}/webhook-endpoints`;
    const r = [
      await call(off, 'POST', e, tok['rivkaOff']!, { url: 'https://hooks.example/a', eventTypes: ['collection.paid'] }, 'create-off-0001'),
      await call(off, 'GET', e, tok['rivkaOff']!),
      await call(off, 'PATCH', `${e}/ep_1`, tok['rivkaOff']!, { rotateSecret: true }, 'rotate-off-0001'),
      await call(off, 'DELETE', `${e}/ep_1`, tok['rivkaOff']!),
      await call(off, 'GET', `/institutions/${ohr}/webhook-deliveries`, tok['rivkaOff']!),
      await call(off, 'POST', '/admin/webhook-deliveries/msg_1/replay', adminToken, { endpointId: 'ep_1' }, 'replay-off-0001'),
    ];
    for (const x of r) expect(x).toMatchObject({ status: 404, body: { code: 'FEATURE_OFF' } });
  });

  let ep: Created;
  it('an admin creates an endpoint: the secret comes once and is never stored, listed or logged', async () => {
    const e = `/institutions/${ohr}/webhook-endpoints`;
    const bad = await call(on, 'POST', e, tok['rivka']!, { url: 'https://169.254.169.254/x', eventTypes: ['collection.paid'] }, 'create-bad-0001');
    expect(bad).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } });
    expect((await call(on, 'POST', e, tok['rivka']!, { url: 'https://hooks.ohr.example/kesher', eventTypes: ['collection.paid'] })).status).toBe(422); // no key
    const r = await call(on, 'POST', e, tok['rivka']!, { url: 'https://hooks.ohr.example/kesher', eventTypes: ['collection.paid'] }, 'create-ok-00001');
    expect(r.status).toBe(201);
    ep = r.body as Created;
    expect(ep.secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await hdb.query('select * from notify.outbound_endpoint')).rows)).not.toContain(ep.secret);
    expect(JSON.stringify((await hdb.query('select * from audit.entry')).rows)).not.toContain(ep.secret);
    const list = await call(on, 'GET', e, tok['coordinator']!); // any staff reads
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(ep.secret);
    expect(list.body).toMatchObject({ items: [{ endpointId: ep.endpointId, url: 'https://hooks.ohr.example/kesher', eventTypes: ['collection.paid'] }] });
  });

  it('plain staff cannot manage endpoints (403); another institution reads as 404 and cannot touch it', async () => {
    const e = `/institutions/${ohr}/webhook-endpoints`;
    expect((await call(on, 'POST', e, tok['coordinator']!, { url: 'https://hooks.ohr.example/b', eventTypes: ['collection.paid'] }, 'create-staff-001')).status).toBe(403);
    expect((await call(on, 'GET', e, tok['sarah']!)).status).toBe(404);
    // Sarah is admin of Seminary: Ohr's endpoint id under her own institution is 404 as well, and survives.
    const own = `/institutions/${sem}/webhook-endpoints/${ep.endpointId}`;
    expect((await call(on, 'PATCH', own, tok['sarah']!, { rotateSecret: true }, 'rotate-other-001')).status).toBe(404);
    expect((await call(on, 'DELETE', own, tok['sarah']!)).status).toBe(404);
    expect((await call(on, 'DELETE', `${e}/${ep.endpointId}`, tok['sarah']!)).status).toBe(404);
    expect(((await call(on, 'GET', e, tok['rivka']!)).body as { items: unknown[] }).items.length).toBe(1);
  });

  it('rotation returns a new secret once, with the old one valid for 24 h', async () => {
    const r = await call(on, 'PATCH', `/institutions/${ohr}/webhook-endpoints/${ep.endpointId}`, tok['rivka']!, { rotateSecret: true }, 'rotate-ok-00001');
    expect(r.status).toBe(200);
    const b = r.body as Created & { previousSecretValidUntil: string };
    expect(b.secret).toMatch(/^whsec_/);
    expect(b.secret).not.toBe(ep.secret);
    expect(b.previousSecretValidUntil).toBeTruthy();
    expect((await call(on, 'PATCH', `/institutions/${ohr}/webhook-endpoints/${ep.endpointId}`, tok['rivka']!, { eventTypes: [] }, 'rotate-bad-0001')).status).toBe(422);
  });

  it('delivery attempts are listed, and ops replays one delivery once per Idempotency-Key', async () => {
    const ci = uuidv7(NOW);
    await hdb.transaction((tx) => enqueue(tx, 'collection', ci, 'collection.paid', { institutionId: ohr, collectionItemId: ci }));
    await new OutboxPublisher(hdb, on.services.outbound).publishBatch();
    const d = await call(on, 'GET', `/institutions/${ohr}/webhook-deliveries`, tok['coordinator']!);
    const items = (d.body as { items: { messageId: string; attempts: { status: string; endpointId: string }[] }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.attempts[0]).toMatchObject({ status: 'succeeded', endpointId: ep.endpointId });
    expect((await call(on, 'GET', `/institutions/${ohr}/webhook-deliveries`, tok['sarah']!)).status).toBe(404);
    const url = `/admin/webhook-deliveries/${items[0]!.messageId}/replay`;
    expect((await call(on, 'POST', url, adminToken, { endpointId: ep.endpointId })).status).toBe(422); // no key
    expect((await call(on, 'POST', url, tok['rivka']!, { endpointId: ep.endpointId }, 'replay-ok-00001')).status).toBe(403); // not staff
    const one = await call(on, 'POST', url, adminToken, { endpointId: ep.endpointId }, 'replay-ok-00001');
    expect(one).toMatchObject({ status: 200, body: { attemptNumber: 2, status: 'succeeded' } });
    const again = await call(on, 'POST', url, adminToken, { endpointId: ep.endpointId }, 'replay-ok-00001');
    expect((again.body as { attemptId: string }).attemptId).toBe((one.body as { attemptId: string }).attemptId);
    expect((await call(on, 'POST', url, adminToken, { endpointId: 'ep_unknown' }, 'replay-bad-0001')).status).toBe(404);
    expect((await call(on, 'POST', '/admin/webhook-deliveries/msg_nope/replay', adminToken, { endpointId: ep.endpointId }, 'replay-bad-0002')).status).toBe(404);
  });

  it('deleting an endpoint removes it from the list, stops replays to it, and a second delete is 404', async () => {
    const e = `/institutions/${ohr}/webhook-endpoints/${ep.endpointId}`;
    expect((await call(on, 'DELETE', e, tok['coordinator']!)).status).toBe(403);
    expect((await call(on, 'DELETE', e, tok['rivka']!)).status).toBe(204);
    expect((await call(on, 'DELETE', e, tok['rivka']!)).status).toBe(404);
    expect(((await call(on, 'GET', `/institutions/${ohr}/webhook-endpoints`, tok['rivka']!)).body as { items: unknown[] }).items).toEqual([]);
    const [m] = (await hdb.query<{ message_id: string }>('select message_id from notify.outbound_message')).rows;
    expect((await call(on, 'POST', `/admin/webhook-deliveries/${m!.message_id}/replay`, adminToken, { endpointId: ep.endpointId }, 'replay-del-0001')).status).toBe(404);
    // With no live endpoint left nothing is sent for a new event.
    const before = host.simulators.events.delivered.length;
    const publish = async () => {
      const ci = uuidv7(NOW);
      await hdb.transaction((tx) => enqueue(tx, 'collection', ci, 'collection.paid', { institutionId: ohr, collectionItemId: ci }));
      await new OutboxPublisher(hdb, on.services.outbound).publishBatch();
    };
    await publish();
    expect(host.simulators.events.delivered.length).toBe(before);
    // A new endpoint later does not bring the deleted one back.
    const fresh = (await call(on, 'POST', `/institutions/${ohr}/webhook-endpoints`, tok['rivka']!, { url: 'https://hooks.ohr.example/new', eventTypes: ['collection.paid'] }, 'create-new-0001')).body as Created;
    await publish();
    expect(host.simulators.events.delivered.slice(before).map((r) => r.url)).toEqual([fresh.url]);
  });

  it('deleting one of two endpoints stops deliveries to it only; the other keeps receiving', async () => {
    const e = `/institutions/${ohr}/webhook-endpoints`;
    const a = (await call(on, 'POST', e, tok['rivka']!, { url: 'https://a.ohr.example/h', eventTypes: ['collection.paid'] }, 'create-two-a001')).body as Created;
    await call(on, 'POST', e, tok['rivka']!, { url: 'https://b.ohr.example/h', eventTypes: ['collection.paid'] }, 'create-two-b001');
    expect((await call(on, 'DELETE', `${e}/${a.endpointId}`, tok['rivka']!)).status).toBe(204);
    const before = host.simulators.events.delivered.length;
    const ci = uuidv7(NOW);
    await hdb.transaction((tx) => enqueue(tx, 'collection', ci, 'collection.paid', { institutionId: ohr, collectionItemId: ci }));
    await new OutboxPublisher(hdb, on.services.outbound).publishBatch();
    const urls = host.simulators.events.delivered.slice(before).map((r) => r.url);
    expect(urls).toContain('https://b.ohr.example/h');
    expect(urls).not.toContain('https://a.ohr.example/h');
    expect(urls).not.toContain('https://hooks.ohr.example/kesher');
  });

  it('a reused Idempotency-Key with a different URL is 409; the URL is stored normalised', async () => {
    const e = `/institutions/${ohr}/webhook-endpoints`;
    const one = await call(on, 'POST', e, tok['rivka']!, { url: 'https://HOOKS.ohr.example/Norm', eventTypes: ['collection.paid'] }, 'create-reuse-001');
    expect((one.body as Created).url).toBe('https://hooks.ohr.example/Norm');
    expect((await hdb.query<{ url: string }>('select url from notify.outbound_endpoint where endpoint_id = $1', [(one.body as Created).endpointId])).rows[0]!.url).toBe('https://hooks.ohr.example/Norm');
    const other = await call(on, 'POST', e, tok['rivka']!, { url: 'https://other.ohr.example/x', eventTypes: ['collection.paid'] }, 'create-reuse-001');
    expect(other).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});

// T-0777: messages() reads every message's attempts concurrently; the result order and the error that surfaces
// stay what the one-by-one loop gave (the first failing message in list order, whatever the timing).
describe('messages() reads attempts concurrently (T-0777)', () => {
  type Row = { messageId: string; eventType: string; sentAt: string; attempts: readonly DeliveryAttempt[] };
  let nextOutbox = 900_000;
  const attempt = (messageId: string, n: number): DeliveryAttempt => ({ attemptId: `${messageId}:${n}`, messageId, attemptNumber: n, status: 'succeeded' }) as unknown as DeliveryAttempt;
  /** Seeds `count` messages for a fresh institution, newest first by sent_at; returns their ids in list order. */
  const seed = async (count: number): Promise<{ inst: string; ids: string[] }> => {
    const inst = uuidv7();
    await db.query(`insert into org.institution (id, name, market) values ($1, 'Seed', 'IL')`, [inst]);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `msg_${inst.slice(-6)}_${String(i).padStart(3, '0')}`;
      ids.push(id);
      // i = 0 is the newest, so list order equals seed order.
      await db.query('insert into notify.outbound_message (message_id, outbox_id, institution_id, event_type, sent_at) values ($1, $2, $3, $4, $5)', [id, nextOutbox++, inst, i % 2 ? 'collection.paid' : 'payout.status_changed', new Date(Date.UTC(2026, 10, 1, 12, 0, 0) - i * 60_000)]);
    }
    return { inst, ids };
  };
  const portOf = (listAttempts: (id: string) => Promise<readonly DeliveryAttempt[]>): EventsPort => ({ listAttempts }) as unknown as EventsPort;
  /** The loop as it was before T-0777, kept as the oracle for the differential test. */
  const oldMessages = async (port: EventsPort, inst: string, limit = 50): Promise<Row[]> => {
    const r = await db.query<{ message_id: string; event_type: string; sent_at: string | Date }>('select message_id, event_type, sent_at from notify.outbound_message where institution_id = $1 order by sent_at desc limit $2', [inst, limit]);
    const out: Row[] = [];
    for (const m of r.rows) out.push({ messageId: m.message_id, eventType: m.event_type, sentAt: new Date(m.sent_at).toISOString(), attempts: await port.listAttempts(m.message_id) });
    return out;
  };
  const attemptsFor = (id: string, i: number): DeliveryAttempt[] => Array.from({ length: [0, 1, 3][i % 3]! }, (_, n) => attempt(id, n + 1));
  const settle = async <T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> => p.then((ok) => ({ ok }), (err: unknown) => ({ err }));
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('returns items newest first with each message\'s own attempts, for zero, one and three attempts', async () => {
    const { inst, ids } = await seed(7);
    const byId = new Map(ids.map((id, i) => [id, attemptsFor(id, i)]));
    // Resolve in reverse of list order so a result built in completion order would be wrong.
    const port = portOf(async (id) => { await delay((ids.length - ids.indexOf(id)) * 3); return byId.get(id)!; });
    const got = await new OutboundEventsService(db, port).messages(inst);
    expect(got.map((m) => m.messageId)).toEqual(ids);
    expect(got.map((m) => m.attempts.length)).toEqual([0, 1, 3, 0, 1, 3, 0]);
    expect(got.map((m) => m.attempts)).toEqual(ids.map((id) => byId.get(id)));
    expect(got[0]).toMatchObject({ eventType: 'payout.status_changed', sentAt: '2026-11-01T12:00:00.000Z' });
  });

  it('honours the limit and answers [] without a port read for an institution with no messages', async () => {
    const { inst, ids } = await seed(5);
    const asked: string[] = [];
    const port = portOf(async (id) => { asked.push(id); return []; });
    const svc2 = new OutboundEventsService(db, port);
    expect((await svc2.messages(inst, 3)).map((m) => m.messageId)).toEqual(ids.slice(0, 3));
    expect([...asked].sort()).toEqual(ids.slice(0, 3).sort());
    asked.length = 0;
    expect(await svc2.messages(uuidv7())).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('a port read that rejects rejects the call with that error', async () => {
    const { inst, ids } = await seed(4);
    const boom = new Error('port down');
    const port = portOf(async (id) => { if (id === ids[2]) throw boom; return []; });
    await expect(new OutboundEventsService(db, port).messages(inst)).rejects.toBe(boom);
  });

  it('with two failing reads the first in list order surfaces, even when the later one fails first, and a synchronous throw counts the same', async () => {
    const { inst, ids } = await seed(5);
    const slowEarly = new Error('index 1, slow');
    const fastLate = new Error('index 3, fast');
    const slow = portOf(async (id) => {
      if (id === ids[1]) { await delay(25); throw slowEarly; }
      if (id === ids[3]) throw fastLate;
      return [];
    });
    await expect(new OutboundEventsService(db, slow).messages(inst)).rejects.toBe(slowEarly);
    const syncEarly = new Error('index 0, sync');
    const sync = portOf((id) => { if (id === ids[0]) throw syncEarly; if (id === ids[4]) return Promise.reject(new Error('index 4')); return Promise.resolve([]); });
    await expect(new OutboundEventsService(db, sync).messages(inst)).rejects.toBe(syncEarly);
  });

  it('starts every attempts read before the first one resolves (concurrency)', async () => {
    const { inst, ids } = await seed(50);
    const started: string[] = [];
    const gates: (() => void)[] = [];
    const port = portOf((id) => new Promise<readonly DeliveryAttempt[]>((resolve) => { started.push(id); gates.push(() => resolve([attempt(id, 1)])); }));
    const pending = new OutboundEventsService(db, port).messages(inst);
    try {
      await delay(30);
      expect(started.length).toBe(50);
    } finally {
      for (const g of gates) g();
    }
    const got = await pending;
    expect(got.map((m) => m.messageId)).toEqual(ids);
    expect(started.length).toBe(50); // each message read exactly once
    expect(new Set(started).size).toBe(50);
  });

  it('differential: the old one-by-one loop and messages() agree on results and on the surfacing error', async () => {
    const { inst, ids } = await seed(9);
    const scenarios: { name: string; port: EventsPort }[] = [
      { name: 'all resolve, staggered', port: portOf(async (id) => { await delay((ids.indexOf(id) % 3) * 4); return attemptsFor(id, ids.indexOf(id)); }) },
      { name: 'all empty', port: portOf(async () => []) },
      { name: 'one rejects', port: portOf(async (id) => { if (id === ids[5]) throw new Error('five'); return []; }) },
      { name: 'two reject, later one first', port: portOf(async (id) => { if (id === ids[2]) { await delay(20); throw new Error('two'); } if (id === ids[6]) throw new Error('six'); return []; }) },
      { name: 'first rejects', port: portOf(async (id) => { if (id === ids[0]) throw new Error('zero'); return []; }) },
    ];
    for (const { name, port } of scenarios) {
      for (const limit of [50, 4]) {
        const was = await settle(oldMessages(port, inst, limit));
        const now = await settle(new OutboundEventsService(db, port).messages(inst, limit));
        if ('err' in was) expect(now, `${name} limit ${limit}`).toEqual({ err: was.err });
        else expect(JSON.stringify(now), `${name} limit ${limit}`).toBe(JSON.stringify(was));
      }
    }
  });
});
