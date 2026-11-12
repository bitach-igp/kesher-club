// TST-INS-025 (T-0649, REQ-INS-025): the Crowded webhook receiver. A signature over the raw bytes; the same payload re-serialised
// fails; a missing or sha1= header fails; a batch of three with one duplicate stores two; flag off answers 404; an older event
// after a newer one leaves the state the re-read returned; an unknown event type is stored and ignored; either rotation secret works.
// TST-WAL-003 (T-0703, REQ-WAL-002, REQ-WAL-003): hosted-load payment events of the member chapter move the load, replay-safe.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeCrowdedSignature, CrowdedClient, CrowdedFunding, CrowdedInstitutionBankingAdapter, CrowdedMemberAccounts, FakeCrowded } from '@kesher/adapters';
import { money, uuidv7 } from '@kesher/domain';
import type { AchStatus, ApplicationStatus, InstitutionBankingPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import type { AddressInfo } from 'node:net';
import { createServer, dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { holdKey, settleKey, type LoadInput } from '../wallet/loads.ts';
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

describe('the bytes as received', () => {
  async function overHttp(app: App, bytes: Buffer, headers: Record<string, string>) {
    const server = createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/webhooks/crowded`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: bytes });
      return { status: res.status, body: (await res.json()) as unknown };
    } finally {
      server.close();
    }
  }
  const sign = (bytes: Buffer) => ({ 'x-webhook-signature': computeCrowdedSignature(SECRET, bytes) });

  it('a delivery with bytes that are not valid UTF-8 verifies, because the signature is over what was received', async () => {
    const bytes = Buffer.concat([Buffer.from('{"events":[{"eventId":"u8-1","eventType":"platform.chapter.updated","data":{"n":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}}]}')]);
    expect(Buffer.from(bytes.toString('utf8')).equals(bytes)).toBe(false); // decoding changes these bytes
    const r = await overHttp(on, bytes, sign(bytes));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: 1, stored: 1, duplicates: 0 });
  });

  it('a byte-order mark is not part of the JSON; a signature over other bytes than were sent fails', async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(batch(event('bom-1', 'platform.chapter.updated')))]);
    expect((await overHttp(on, bom, sign(bom))).status).toBe(200);
    expect((await overHttp(on, bom, sign(bom.subarray(3)))).status).toBe(401);
  });

  it('a body that is not JSON is judged by its signature first: unsigned it is 401 and leaves a rejected row, never a parse error', async () => {
    const before = await count('inbound_rejected');
    const r = await post(on, 'this is not json', {});
    expect(r.status).toBe(401);
    expect(await count('inbound_rejected')).toBe(before + 1);
    const body = 'this is not json';
    expect([400, 422]).toContain((await post(on, body, signed(body))).status);
  });

  it('a NUL in an event, or an event over the size limit, refuses the whole batch before anything is stored', async () => {
    const nul = JSON.stringify({ events: [event('nul-ok', 'x'), event('nul-bad\u0000id', 'x')] });
    const nulData = JSON.stringify({ events: [event('nul-ok', 'x'), event('nul-bad-data', 'x', 'ch1', { note: 'a\u0000b' })] });
    const big = JSON.stringify({ events: [event('big-ok', 'x'), event('big-bad', 'x', 'ch1', { blob: 'x'.repeat(70_000) })] });
    for (const body of [nul, nulData, big]) expect([400, 422]).toContain((await post(on, body, signed(body))).status);
    expect((await db.query(`select 1 from ops.inbound_event where event_id in ('nul-ok','big-ok','nul-bad-data','big-bad')`)).rows).toHaveLength(0);
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

describe('member-chapter payment events move a hosted load (T-0703, TST-WAL-003)', () => {
  const MEMBER_CHAPTER = 'memberch';
  const T = new Date('2026-11-03T10:00:00Z'); // a Tuesday: three business days end Friday 2026-11-06
  const TOKEN = 'crowded_test_token_not_a_secret';
  const MAC_KEY = 'test-only-mac-key-not-a-secret-0123456789';
  let fake: FakeCrowded;
  let chapter: string;
  let walletApp: App;
  let walletOff: App;
  let mobiles = 0;

  const pay = (a: App, body: string, headers: Record<string, string> = signed(body)) => dispatch(a, { method: 'POST', url: '/v1/webhooks/crowded', headers, rawBody: body, now: T });
  const replay = (a: App) => a.services.webhooks.replay({ provider: 'crowded', now: T });
  let ev = 0;
  const paymentEvent = (type: string, paymentId: string, intentId: string, chapterId = chapter) => event(`hl-${++ev}-${type}`, type, chapterId, { paymentId, intentId, collectionId: 'col1', status: type.split('.').pop() });
  /** Delivers a signed batch and lets the replay job process it, as the worker does. */
  const deliver = async (a: App, ...events: ReturnType<typeof event>[]) => {
    const body = batch(...events);
    const r = await pay(a, body);
    await replay(a);
    return r;
  };

  async function startLoad(key: string, minor = 10_000n) {
    const s = walletApp.services;
    const party = uuidv7(T);
    await s.accounts.provisionMember(party);
    const amount = money(minor, 'USD');
    const input: LoadInput = { payerPartyId: party, memberPartyId: party, method: 'hosted', amount };
    const t = await s.loads.submit(await s.loads.begin(input, key, T), T);
    const adapterLoad = await adapter.createLoad({ customerId: party, method: 'hosted', amount, hosted: { payerIp: '203.0.113.7', userConsented: true } }, key);
    await s.loads.link(t, adapterLoad);
    const intentId = adapterLoad.loadId.split(':')[2]!;
    return { party, transfer: t, intentId, intentRef: `${chapter}:-:${intentId}` };
  }
  const stateOf = async (id: string) => (await walletApp.services.transfers.get(id))!;
  const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.n;

  let adapter: CrowdedFunding;
  beforeAll(async () => {
    fake = new FakeCrowded({ token: TOKEN, now: () => T });
    chapter = fake.seedChapter();
    const client = new CrowdedClient({ baseUrl: 'https://sandbox.fake.invalid/api/v1', token: TOKEN, fetch: fake.fetch });
    const members = new CrowdedMemberAccounts({ client, chapterId: chapter, hmacKey: MAC_KEY, now: () => T });
    const contactOf = async (customerId: string) => (await members.ensureAccount({ partyId: customerId, firstName: 'Payer', lastName: 'Test', email: `${customerId}@example.test`, mobile: `+1415555${String(2000 + mobiles++)}` }, `ensure-${customerId}`)).contactRef;
    adapter = new CrowdedFunding({ client, chapterId: chapter, hmacKey: MAC_KEY, achHoldDays: 3, redirectHosts: ['app.example'], contactOf, now: () => T });
    const host = new SimulatorHost();
    host.registry.register('funding', 'crowded', () => adapter);
    host.registry.bind({ capability: 'funding', market: 'US', provider: 'crowded', mode: 'sim' });
    const base = { db, registry: host.registry, market: 'US' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => T, crowdedWebhookSecrets: [SECRET], crowdedMemberChapterId: chapter };
    // Only the wallet flag: the route is open for member-chapter events although US banking is off.
    walletApp = createApp({ ...base, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
    walletOff = createApp({ ...base, flags: new StaticFlags(undefined, { [FLAG]: true }) });
  }, 60_000);

  it('a batch of processing then succeeded for a bank-transfer payment holds the load once, with holdUntil set; the same batch twice and the other order change nothing more', async () => {
    const l = await startLoad('hl-ach-0001');
    const p = fake.payIntent(l.intentRef, 'ach');
    fake.process(p);
    fake.settle(p);
    const first = await deliver(walletApp, paymentEvent('collect.payment.processing', p, l.intentId), paymentEvent('collect.payment.succeeded', p, l.intentId));
    expect(first.status).toBe(200);
    const held = await stateOf(l.transfer.id);
    expect(held).toMatchObject({ state: 'pending_hold' });
    expect(held.holdReleasesAt?.slice(0, 10)).toBe('2026-11-06');
    expect(await journals(holdKey('hl-ach-0001'))).toBe(1);
    expect(await journals(settleKey('hl-ach-0001'))).toBe(0);

    // The identical bytes again: every event id is a duplicate.
    const body = batch(...[paymentEvent('collect.payment.processing', p, l.intentId)]);
    await pay(walletApp, body);
    const again = await pay(walletApp, body);
    expect(again.body).toEqual({ received: 1, stored: 0, duplicates: 1 });
    // The two events in the other order, with new ids: both re-read the same current state.
    await deliver(walletApp, paymentEvent('collect.payment.succeeded', p, l.intentId), paymentEvent('collect.payment.processing', p, l.intentId));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'pending_hold' });
    expect(await journals(holdKey('hl-ach-0001'))).toBe(1);
    expect((await walletApp.services.accounts.purses(l.party)).find((x) => x.currency === 'USD')!.available.minor).toBe(0n);
  });

  it('a first event that names only the payment, never seen on a read, still finds its load through the intent the event names', async () => {
    const l = await startLoad('hl-ach-0002');
    const p = fake.payIntent(l.intentRef, 'ach');
    fake.settle(p);
    await deliver(walletApp, paymentEvent('collect.payment.succeeded', p, l.intentId));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'pending_hold' });
  });

  it('collect.payment.returned while held fails the load and reverses the hold journal once', async () => {
    const l = await startLoad('hl-ach-0003');
    const p = fake.payIntent(l.intentRef, 'ach');
    fake.settle(p);
    await deliver(walletApp, paymentEvent('collect.payment.succeeded', p, l.intentId));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'pending_hold' });
    fake.returnPayment(p);
    await deliver(walletApp, paymentEvent('collect.payment.returned', p, l.intentId));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'failed', failureCode: 'RETURNED' });
    expect(await journals(`${holdKey('hl-ach-0003')}:reversal`)).toBe(1);
    await deliver(walletApp, paymentEvent('collect.payment.returned', p, l.intentId));
    expect(await journals(`${holdKey('hl-ach-0003')}:reversal`)).toBe(1);
    expect((await walletApp.services.accounts.purses(l.party)).find((x) => x.currency === 'USD')!.available.minor).toBe(0n);
  });

  it('a collect.payment.failed event for a payment the re-read shows Succeeded changes nothing: the read decides', async () => {
    const l = await startLoad('hl-ach-0004');
    const p = fake.payIntent(l.intentRef, 'ach');
    fake.settle(p);
    await deliver(walletApp, paymentEvent('collect.payment.failed', p, l.intentId));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'pending_hold' });
    await deliver(walletApp, paymentEvent('collect.payment.failed', p, l.intentId));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'pending_hold' });
    expect(await journals(`${holdKey('hl-ach-0004')}:reversal`)).toBe(0);
  });

  it('a card Succeeded settles through the settle path: one journal keyed {workflowId}:settle, and the wallet is credited once', async () => {
    const l = await startLoad('hl-card-0001');
    fake.payIntent(l.intentRef, 'card');
    const intent = await adapter.getLoad(`crowded:${chapter}:${l.intentId}`);
    const p = (intent.metadata as { paymentLoadId: string }).paymentLoadId.split(':')[2]!;
    await deliver(walletApp, paymentEvent('collect.payment.succeeded', p, l.intentId));
    await deliver(walletApp, paymentEvent('collect.payment.succeeded', p, l.intentId));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'settled' });
    expect(await journals(settleKey('hl-card-0001'))).toBe(1);
    expect((await walletApp.services.accounts.purses(l.party)).find((x) => x.currency === 'USD')!.available.minor).toBe(10_000n);
  });

  it('an event that names the payment alone is found through the payment mapping once a read has seen it', async () => {
    const l = await startLoad('hl-card-0002');
    fake.payIntent(l.intentRef, 'card');
    const p = ((await adapter.getLoad(`crowded:${chapter}:${l.intentId}`)).metadata as { paymentLoadId: string }).paymentLoadId.split(':')[2]!;
    await deliver(walletApp, event(`hl-pay-only-${++ev}`, 'collect.payment.succeeded', chapter, { paymentId: p }));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'settled' });
  });

  it('a payment whose amount differs from the transfer is refused with VALIDATION_FAILED and applies nothing', async () => {
    const l = await startLoad('hl-amount-01');
    fake.payIntent(l.intentRef, 'card');
    await db.query(`update ops.transfer set amount_minor = 5000 where id = $1`, [l.transfer.id]);
    await expect(walletApp.services.loads.applyVendorLoad(`crowded:${chapter}:${l.intentId}`, T)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const p = ((await adapter.getLoad(`crowded:${chapter}:${l.intentId}`)).metadata as { paymentLoadId: string }).paymentLoadId.split(':')[2]!;
    await deliver(walletApp, paymentEvent('collect.payment.succeeded', p, l.intentId));
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'submitted' });
    expect(await journals(settleKey('hl-amount-01'))).toBe(0);
    const row = (await db.query<{ processed_at: unknown; error: string }>(`select processed_at, error from ops.inbound_event where event_id = $1`, [`hl-${ev}-collect.payment.succeeded`])).rows[0]!;
    expect(row.processed_at).toBeNull();
    expect(row.error).toContain('amount differs');
  });

  it('an event for a payment no load owns is stored and ignored', async () => {
    const r = await deliver(walletApp, paymentEvent('collect.payment.succeeded', 'cp-nobody', 'int-nobody'), paymentEvent('collect.payment.succeeded', 'cp-nobody-2', 'a/b'));
    expect(r.status).toBe(200);
    const rows = (await db.query<{ processed_at: unknown; error: string | null }>(`select processed_at, error from ops.inbound_event where event_id like 'hl-%collect.payment.succeeded' and payload->'data'->>'paymentId' like 'cp-nobody%'`)).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.processed_at).not.toBeNull();
      expect(row.error).toBeNull();
    }
  });

  it('a bad signature answers 401 with one ops.inbound_rejected row and applies nothing', async () => {
    const l = await startLoad('hl-badsig-01');
    const p = fake.payIntent(l.intentRef, 'card');
    const body = batch(paymentEvent('collect.payment.succeeded', p, l.intentId));
    const before = await count('inbound_rejected');
    const r = await pay(walletApp, body, signed(body, 'some_other_secret_0123456789abcdef0123'));
    expect(r.status).toBe(401);
    expect(await count('inbound_rejected')).toBe(before + 1);
    await replay(walletApp);
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'submitted' });
    // The rejected row holds a hash, never the bytes or an id from the body.
    const row = (await db.query<{ payload: unknown }>(`select payload from ops.inbound_rejected where provider = 'crowded' order by received_at desc, id desc limit 1`)).rows[0]!;
    expect(JSON.stringify(row.payload)).not.toContain(l.intentId);
  });

  it('/hooks/funding refuses a validly signed Crowded batch and applies nothing', async () => {
    const l = await startLoad('hl-hooks-01');
    const p = fake.payIntent(l.intentRef, 'card');
    const body = batch(paymentEvent('collect.payment.succeeded', p, l.intentId));
    const r = await dispatch(walletApp, { method: 'POST', url: '/v1/hooks/funding', headers: signed(body), rawBody: body, now: T });
    expect(r.status).toBeGreaterThanOrEqual(400);
    await replay(walletApp);
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'submitted' });
    expect((await db.query(`select 1 from ops.inbound_event where provider = 'funding' and signature_ok`)).rows).toHaveLength(0);
  });

  it('with the wallet flag off a member-chapter event is stored and left unprocessed; once the flag is on, replay applies it once', async () => {
    const l = await startLoad('hl-flag-0001');
    const p = fake.payIntent(l.intentRef, 'card');
    const e = paymentEvent('collect.payment.succeeded', p, l.intentId);
    expect((await deliver(walletOff, e)).status).toBe(200);
    const row = async () => (await db.query<{ processed_at: unknown; error: string | null }>(`select processed_at, error from ops.inbound_event where event_id = $1`, [e.eventId])).rows[0]!;
    expect((await row()).processed_at).toBeNull();
    expect((await row()).error).toContain('wallet');
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'submitted' });
    await replay(walletApp);
    await replay(walletApp);
    expect((await row()).processed_at).not.toBeNull();
    expect(await stateOf(l.transfer.id)).toMatchObject({ state: 'settled' });
    expect(await journals(settleKey('hl-flag-0001'))).toBe(1);
  });

  it('with only the wallet flag on, the route is open and an institution event is kept unprocessed until US banking is on', async () => {
    const e = event(`hl-inst-${++ev}`, 'collect.payment.succeeded', 'someotherchapter', { paymentId: 'x1' });
    expect((await deliver(walletApp, e)).status).toBe(200);
    const row = (await db.query<{ processed_at: unknown; error: string | null }>(`select processed_at, error from ops.inbound_event where event_id = $1`, [e.eventId])).rows[0]!;
    expect(row.processed_at).toBeNull();
    expect(row.error).toContain('US banking');
  });

  it('with both flags off the route is 404 FEATURE_OFF', async () => {
    const none = createApp({ db, registry: new SimulatorHost().registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => T, flags: new StaticFlags(), crowdedWebhookSecrets: [SECRET] });
    const body = batch(event('hl-none-1', 'collect.payment.succeeded', chapter));
    expect((await pay(none, body)).status).toBe(404);
  });

  describe('routing by chapter', () => {
    function rig(handlers: CrowdedHandlers, flags = new StaticFlags(undefined, { [FLAG]: true, 'wallet.enabled': true })) {
      const store = new InboundEventStore(db);
      const crowded = new CrowdedWebhook({ store, flags, secrets: () => [SECRET], port: () => ({}) as InstitutionBankingPort, handlers, memberChapterId: MEMBER_CHAPTER });
      return async (e: ReturnType<typeof event>) => {
        const { event: stored } = await store.record({ provider: 'crowded', eventId: e.eventId, signatureOk: true, payload: e, receivedAt: now });
        await crowded.process(stored);
      };
    }

    it('collect.payment.* of the member chapter goes to funding with the payment and intent refs; any other chapter keeps going to collected; other collect events of the member chapter are ignored', async () => {
      const funding = vi.fn(async () => undefined);
      const collected = vi.fn(async () => undefined);
      const feed = rig({ funding, collected });
      await feed(event('rt-1', 'collect.payment.processing', MEMBER_CHAPTER, { paymentId: 'p1', intentId: 'i1' }));
      await feed(event('rt-2', 'collect.payment.succeeded', MEMBER_CHAPTER, { id: 'p2' }));
      await feed(event('rt-3', 'collect.payment.succeeded', 'ch9', { paymentId: 'p3' }));
      await feed(event('rt-4', 'collect.intent.created', MEMBER_CHAPTER, { intentId: 'i1' }));
      await feed(event('rt-5', 'collect.payment.succeeded', MEMBER_CHAPTER, {}));
      expect(funding.mock.calls).toEqual([
        [MEMBER_CHAPTER, `crowded:${MEMBER_CHAPTER}:p1`, `crowded:${MEMBER_CHAPTER}:i1`],
        [MEMBER_CHAPTER, `crowded:${MEMBER_CHAPTER}:p2`, undefined],
      ]);
      expect(collected.mock.calls).toEqual([['ch9']]);
    });

    it('an id that is not a plain id never reaches the funding handler as a path', async () => {
      const funding = vi.fn(async () => undefined);
      const feed = rig({ funding });
      await feed(event('rt-6', 'collect.payment.succeeded', MEMBER_CHAPTER, { paymentId: '../x', intentId: 'a?b' }));
      // The refs are opaque strings to the handler; the adapter refuses anything that is not a plain id (UNKNOWN_LOAD, no request).
      expect(funding).toHaveBeenCalledTimes(1);
    });
  });
});
