// T-1026 (T-0771 slice 4): what createApp reads off the funding and billing bindings. Two consumers in the composition root look at
// a binding: `bindingFor('funding', market)?.provider ?? 'simulator'` (the provider key of the funding_subaccount refs handed to
// `subAccountChapters`) and `bindingFor('billing', market)?.mode === 'sim'` (mounts `/hooks/simulator`). The tables below were written
// green on the old code and pin the value passed and the route mounted for every funding choice x mode x market and billing choice x mode x market.
import { computeCrowdedSignature } from '@kesher/adapters';
import { Secret } from '@kesher/domain';
import type { Market, Mode, ProviderRegistry } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { generateSigningKey } from './auth/tokens.ts';
import { StaticFlags } from './billing/capabilities.ts';
import type { Database, SqlClient } from './db.ts';
import { createRegistry, overridesFromConfig, systemClock } from './registry.ts';
import { dispatch } from './server.ts';
import { createTestDatabase, type TestDatabase } from './test-db.ts';

const SECRET = 'crowded_endpoint_secret_0123456789abcdef';
const now = new Date('2026-11-25T10:00:00Z');
const MARKETS: readonly Market[] = ['US', 'IL'];
const MODES: readonly Mode[] = ['sim', 'sandbox', 'live'];
const REF_QUERY = /external_ref r where r\.entity_type = \$1 and r\.provider = \$2 and r\.external_id = \$3/;

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);
afterAll(async () => db.close());

/** A Database that records the (entity_type, provider, external_id) of every sub-account ref lookup, and passes everything through. */
function recording(inner: Database): { db: Database; lookups: unknown[][] } {
  const lookups: unknown[][] = [];
  const wrapped: Database = {
    query: ((text: string, params?: readonly unknown[]) => {
      if (REF_QUERY.test(text)) lookups.push([...(params ?? [])]);
      return inner.query(text, params);
    }) as SqlClient['query'],
    transaction: (fn) => inner.transaction(fn),
  };
  return { db: wrapped, lookups };
}

/** The simulators' registry with one capability re-bound to `provider` in `mode` (both markets), the simulator's port behind it. */
function rebound(capability: string, provider: string, mode: Mode): ProviderRegistry {
  const host = new SimulatorHost();
  const port = host.registry.resolve(capability, 'US');
  host.registry.register(capability, provider, () => port);
  for (const market of MARKETS) host.registry.bind({ capability, market, provider, mode });
  return host.registry;
}

const stripeRegistry = (): ProviderRegistry => {
  const config = { PROVIDER_INSTITUTION_BANKING: 'sim', PROVIDER_FUNDING: 'stripe', STRIPE_API_KEY: new Secret('sk_test_x'), STRIPE_WEBHOOK_SECRET: [new Secret('whsec_x')], STRIPE_PLAN_PRODUCTS: { club: 'prod_club' } } as unknown as Parameters<typeof overridesFromConfig>[0];
  return createRegistry('sandbox', systemClock(), overridesFromConfig(config, db)).registry;
};

async function build(registry: ProviderRegistry, market: Market, database: Database) {
  return createApp({ db: database, registry, market, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now, flags: new StaticFlags(undefined, { 'institutions.usBanking': true }), crowdedWebhookSecrets: [SECRET] });
}

let n = 0;
/** Delivers one signed Crowded `collect.payment.succeeded` of a chapter nobody knows: the receiver asks the sub-account lookup about it. */
async function probe(app: Awaited<ReturnType<typeof build>>): Promise<void> {
  const chapter = `probe-${++n}`;
  const event = { eventId: `evt-probe-${n}`, eventType: 'collect.payment.succeeded', version: '1.0', timestamp: '2026-11-25T09:59:00Z', context: { partnerId: 'p1', chapterId: chapter }, data: { paymentId: 'pay-1' } };
  const rawBody = JSON.stringify({ batchId: `b-${n}`, count: 1, events: [event] });
  const r = await dispatch(app, { method: 'POST', url: '/v1/webhooks/crowded', headers: { 'x-webhook-signature': computeCrowdedSignature(SECRET, rawBody) }, rawBody, now });
  expect(r.status).toBe(200);
  await app.services.webhooks.replay({ provider: 'crowded', now }); // the route only stores a batch; the router replays it
}

const simHook = async (app: Awaited<ReturnType<typeof build>>, eventId: string) =>
  dispatch(app, { method: 'POST', url: '/v1/hooks/simulator', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId }), now });

describe('createApp reads the funding binding for the sub-account ref provider (T-0771 slice 4)', () => {
  type Cell = { label: string; make: () => ProviderRegistry; expected: string };
  const cells: Cell[] = [
    { label: 'PROVIDER_FUNDING=sim (simulator, sim)', make: () => createRegistry('sim').registry, expected: 'simulator' },
    { label: 'PROVIDER_FUNDING=stripe (stripe, sandbox)', make: stripeRegistry, expected: 'stripe' },
    ...['simulator', 'stripe', 'crowded', 'acme'].flatMap((provider) => MODES.map((mode) => ({ label: `${provider} bound in ${mode}`, make: () => rebound('funding', provider, mode), expected: provider }))),
  ];

  it('old-vs-new table: the provider handed to subAccountChapters is the funding binding\'s provider, whatever the mode and the market', async () => {
    for (const cell of cells) {
      for (const market of MARKETS) {
        const spy = recording(db);
        await probe(await build(cell.make(), market, spy.db));
        expect(spy.lookups, `${cell.label} / ${market}`).toEqual([['funding_subaccount', cell.expected, expect.stringMatching(/^s:probe-\d+$/)]]);
      }
    }
  });

  it('the provider is read from the app\'s own market only', async () => {
    const host = new SimulatorHost();
    const port = host.registry.resolve('funding', 'US');
    host.registry.register('funding', 'us-only-name', () => port);
    host.registry.bind({ capability: 'funding', market: 'US', provider: 'us-only-name', mode: 'sim' });
    for (const [market, expected] of [['US', 'us-only-name'], ['IL', 'simulator']] as const) {
      const spy = recording(db);
      await probe(await build(host.registry, market, spy.db));
      expect(spy.lookups[0]?.[1], market).toBe(expected);
    }
  });

  it('a registry that reports no funding binding (resolve still works) falls back to "simulator"; a real ProviderRegistry cannot, since createApp resolves funding first', async () => {
    const host = new SimulatorHost();
    const blind = new Proxy(host.registry, { get: (t, k) => (k === 'bindingFor' ? (c: string, m: Market) => (c === 'funding' ? undefined : t.bindingFor(c, m)) : Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k)) });
    const spy = recording(db);
    await probe(await build(blind, 'US', spy.db));
    expect(spy.lookups).toEqual([['funding_subaccount', 'simulator', expect.stringMatching(/^s:probe-\d+$/)]]);
  });
});

describe('createApp mounts /hooks/simulator from the billing binding\'s mode (T-0771 slice 4)', () => {
  type Cell = { label: string; make: () => ProviderRegistry; mounted: boolean };
  const cells: Cell[] = [
    { label: 'PROVIDER_FUNDING=sim (billing simulator, sim)', make: () => createRegistry('sim').registry, mounted: true },
    { label: 'PROVIDER_FUNDING=stripe (billing stripe, sandbox)', make: stripeRegistry, mounted: false },
    ...['simulator', 'stripe', 'acme'].flatMap((provider) => MODES.map((mode) => ({ label: `billing ${provider} bound in ${mode}`, make: () => rebound('billing', provider, mode), mounted: mode === 'sim' }))),
  ];

  it('old-vs-new table: mounted exactly when the billing binding is in sim mode, whatever the provider and the market', async () => {
    for (const cell of cells) {
      for (const market of MARKETS) {
        const app = await build(cell.make(), market, db);
        const r = await simHook(app, `evt-sim-${++n}`);
        expect(r.status, `${cell.label} / ${market}`).toBe(cell.mounted ? 200 : 404);
        if (!cell.mounted) expect(JSON.stringify(r.body)).toContain('NOT_FOUND');
      }
    }
  });

  it('mounted, the route verifies: a delivery without the sim signature is 401, and it is read from the billing binding, not the funding one', async () => {
    const app = await build(createRegistry('sim').registry, 'US', db);
    const bad = await dispatch(app, { method: 'POST', url: '/v1/hooks/simulator', headers: { 'x-sim-signature': 'nope' }, rawBody: JSON.stringify({ eventId: `evt-bad-${++n}` }), now });
    expect(bad.status).toBe(401);
    const host = new SimulatorHost();
    const port = host.registry.resolve('funding', 'US');
    host.registry.register('funding', 'stripe', () => port);
    for (const market of MARKETS) host.registry.bind({ capability: 'funding', market, provider: 'stripe', mode: 'sandbox' });
    expect((await simHook(await build(host.registry, 'US', db), `evt-fund-${++n}`)).status).toBe(200); // funding sandbox, billing sim: still mounted
    expect((await simHook(await build(rebound('billing', 'simulator', 'sandbox'), 'US', db), `evt-bill-${++n}`)).status).toBe(404); // billing sandbox, funding sim: not
  });

  it('the route follows the app\'s own market: billing in sim for US only mounts it for a US app and not for an IL one', async () => {
    const host = new SimulatorHost();
    const port = host.registry.resolve('billing', 'US');
    host.registry.register('billing', 'acme', () => port);
    host.registry.bind({ capability: 'billing', market: 'US', provider: 'acme', mode: 'sim' });
    host.registry.bind({ capability: 'billing', market: 'IL', provider: 'acme', mode: 'sandbox' });
    expect((await simHook(await build(host.registry, 'US', db), `evt-mkt-${++n}`)).status).toBe(200);
    expect((await simHook(await build(host.registry, 'IL', db), `evt-mkt-${++n}`)).status).toBe(404);
  });
});
