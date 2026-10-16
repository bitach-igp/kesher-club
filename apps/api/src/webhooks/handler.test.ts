// TST-LED-003: a replayed webhook, processed twice, yields exactly one journal. Plus THR-02:
// forged signatures never credit a wallet, timestamps outside tolerance are refused, and the
// replay tool re-drives events whose processing failed.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { makeRequest } from '../http.ts';
import { AccountService } from '../ledger/accounts.ts';
import { PostgresLedger } from '../ledger/post.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { WebhookRouter } from './handler.ts';
import { InboundEventStore } from './store.ts';
import { simulatorVerifier, standardWebhooksVerifier, stripeVerifier } from './verify.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
let accounts: AccountService;
let store: InboundEventStore;
let router: WebhookRouter;
let partner: string;
let wallet: string;
let processed = 0;
let failNext = false;
const now = new Date('2026-11-01T10:00:00Z');
const STRIPE_SECRET = 'whsec_test_stripe';

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  store = new InboundEventStore(db);
  router = new WebhookRouter(store);
  partner = await accounts.systemAccount('partner_settlement', 'USD');
  const party = uuidv7();
  await accounts.provisionMember(party);
  wallet = await accounts.memberAccount(party, 'wallet', 'USD');
  const credit = async (e: { provider: string; eventId: string; payload: unknown }) => {
    if (failNext) {
      failNext = false;
      throw new Error('ledger temporarily unavailable');
    }
    processed += 1;
    const minor = BigInt((e.payload as { amountMinor: string }).amountMinor);
    await ledger.post({ idempotencyKey: `${e.provider}:${e.eventId}`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: minor }, { accountId: wallet, currency: 'USD', amountMinor: -minor }] });
  };
  router.bind('simulator', { verifier: simulatorVerifier, process: credit });
  router.bind('stripe', { verifier: stripeVerifier([STRIPE_SECRET]), process: credit });
  router.bind('institution-svix', { verifier: standardWebhooksVerifier(['whsec_' + Buffer.from('secret-bytes').toString('base64')]), process: async () => undefined });
}, 60_000);
afterAll(async () => db.close());

const post = (provider: string, headers: Record<string, string>, body: unknown, at = now) =>
  router.handler()(makeRequest({ method: 'POST', path: `/hooks/${provider}`, params: { provider }, headers, rawBody: typeof body === 'string' ? body : JSON.stringify(body), body, now: at }));

describe('providerWebhook', () => {
  it('stores, processes and answers 200; a replay is deduped and leaves exactly one journal (TST-LED-003)', async () => {
    const body = { eventId: 'evt-1', amountMinor: '10000' };
    const first = await post('simulator', { 'x-sim-signature': 'sim' }, body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ eventId: 'evt-1', duplicate: false });
    const second = await post('simulator', { 'x-sim-signature': 'sim' }, body);
    expect(second.body).toEqual({ eventId: 'evt-1', duplicate: true });
    expect((await db.query('select 1 from ledger.journal where idempotency_key = $1', ['simulator:evt-1'])).rowCount).toBe(1);
    expect(await ledger.balance(wallet, 'USD')).toBe(-10_000n);
  });

  it('a forged signature is stored for forensics, answered 401, and never processed (THR-02)', async () => {
    const before = processed;
    const res = await post('simulator', { 'x-sim-signature': 'forged' }, { eventId: 'evt-forged', amountMinor: '99999999' });
    expect(res.status).toBe(401);
    expect(processed).toBe(before);
    const stored = await store.get('simulator', 'evt-forged');
    expect(stored?.signatureOk).toBe(false);
    expect(await ledger.balance(wallet, 'USD')).toBe(-10_000n);
    // A later, correctly signed delivery of the same id is still refused: the stored row wins and it was unverified.
    const again = await post('simulator', { 'x-sim-signature': 'sim' }, { eventId: 'evt-forged', amountMinor: '1' });
    expect(again.status).toBe(401);
  });

  it('Stripe-style signatures verify with the secret and fail with the wrong one', async () => {
    const raw = JSON.stringify({ id: 'evt_stripe_1', amountMinor: '500' });
    const t = Math.floor(now.getTime() / 1000);
    const sig = createHmac('sha256', STRIPE_SECRET).update(`${t}.${raw}`).digest('hex');
    const ok = await post('stripe', { 'stripe-signature': `t=${t},v1=${sig}` }, raw);
    expect(ok.status).toBe(200);
    const bad = await post('stripe', { 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` }, JSON.stringify({ id: 'evt_stripe_2', amountMinor: '500' }));
    expect(bad.status).toBe(401);
  });

  it('Standard Webhooks signatures are checked with the id.timestamp.body string and a 5-minute tolerance', async () => {
    const raw = JSON.stringify({ type: 'collection.paid' });
    const ts = Math.floor(now.getTime() / 1000);
    const sig = createHmac('sha256', 'secret-bytes').update(`msg_1.${ts}.${raw}`).digest('base64');
    const ok = await post('institution-svix', { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` }, raw);
    expect(ok.status).toBe(200);
    const stale = await post('institution-svix', { 'webhook-id': 'msg_2', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` }, raw, new Date(now.getTime() + 6 * 60_000));
    expect(stale.status).toBe(401);
  });

  it('unknown providers are 404 and a body without an event id is 422', async () => {
    expect((await post('nope', {}, { eventId: 'x' })).status).toBe(404);
    expect((await post('simulator', { 'x-sim-signature': 'sim' }, { amountMinor: '1' })).status).toBe(422);
  });

  it('a processing failure is recorded and the replay tool drives it to completion, still one journal', async () => {
    failNext = true;
    const res = await post('simulator', { 'x-sim-signature': 'sim' }, { eventId: 'evt-retry', amountMinor: '700' });
    expect(res.status).toBe(200);
    const stored = await store.get('simulator', 'evt-retry');
    expect(stored?.processedAt).toBeUndefined();
    expect(stored?.error).toContain('temporarily');
    expect((await store.pending()).map((e) => e.eventId)).toContain('evt-retry');
    expect(await store.lagMs(new Date(now.getTime() + 60_000))).toBe(60_000);
    const replay = await router.replay({ now: new Date(now.getTime() + 60_000) });
    expect(replay).toEqual({ attempted: 1, succeeded: 1 });
    expect((await store.get('simulator', 'evt-retry'))?.processedAt).toBeTruthy();
    expect((await db.query('select 1 from ledger.journal where idempotency_key = $1', ['simulator:evt-retry'])).rowCount).toBe(1);
    expect(await store.lagMs(now)).toBe(0);
  });
});
