// TST-WAL-008 a purse's transactions (T-0536, REQ-WAL-008): Dana's $500.00 load and three card authorisations, as the
// ledger records them. Newest first: the $12.00 hold at MCC 5814 in IL is out and pending; the authorisation that
// cleared reads settled, once; the one released reads reversed, and its release is no row of its own; the load is in
// and settled. Fifty a page, and the cursor continues without repeats. Another member's purse answers 404, as does
// one that is not a purse; with wallet.enabled off, FEATURE_OFF.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type Currency } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { Transaction } from './transactions.ts';

let db: TestDatabase;
let app: App;
let off: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const people: Record<string, { partyId: string; token: string }> = {};
let wallet: string;

const list = (who: string, account: string, query = '', a: App = app) => dispatch(a, { method: 'GET', url: `/v1/accounts/${account}/transactions${query}`, headers: { authorization: `Bearer ${people[who]!.token}` }, rawBody: '', now: NOW });

async function post(kind: string, key: string, legs: [string, bigint][], when: Date, metadata: Record<string, unknown> = {}, currency: Currency = 'USD') {
  await app.services.ledger.post({ idempotencyKey: key, kind, effectiveAt: when, postings: legs.map(([accountId, amountMinor]) => ({ accountId, currency, amountMinor })), metadata });
}

beforeAll(async () => {
  db = await createTestDatabase();
  const opts = { db, registry: new SimulatorHost().registry, market: 'US' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags(undefined, { 'wallet.enabled': false }) });
  for (const who of ['dana', 'avi']) {
    const partyId = uuidv7(NOW);
    people[who] = { partyId, token: (await app.services.tokens.issue({ partyId, deviceId: 'phone', roles: ['member'] })).accessToken };
  }
  const { accounts } = app.services;
  wallet = await accounts.memberAccount(people['dana']!.partyId, 'wallet', 'USD');
  const pending = await accounts.memberAccount(people['dana']!.partyId, 'pending', 'USD');
  const partner = await accounts.systemAccount('partner_settlement', 'USD');
  await post('load', 'tx-load', [[partner, 50_000n], [wallet, -50_000n]], at(0));
  // An authorisation that cleared, one released, and one still held.
  await post('auth_hold', 'tx-hold-a1', [[wallet, 3_000n], [pending, -3_000n]], at(1), { authId: 'a1', mcc: '5411', country: 'US' });
  await post('card_clearing', 'tx-clear-a1', [[pending, 3_000n], [partner, -3_000n]], at(2), { authId: 'a1' });
  await post('auth_hold', 'tx-hold-a2', [[wallet, 800n], [pending, -800n]], at(3), { authId: 'a2', mcc: '5812', country: 'IL' });
  await post('auth_release', 'tx-release-a2', [[pending, 800n], [wallet, -800n]], at(4), { authId: 'a2' });
  await post('auth_hold', 'tx-hold-a3', [[wallet, 1_200n], [pending, -1_200n]], at(5), { authId: 'a3', mcc: '5814', country: 'IL' });
}, 60_000);
afterAll(async () => db.close());

describe("a purse's transactions (TST-WAL-008, T-0536)", () => {
  it('newest first: a held card spend pending with its category and country, a cleared one settled once, a released one reversed, the load in', async () => {
    const r = await list('dana', wallet);
    expect(r.status).toBe(200);
    const items = (r.body as { items: Transaction[] }).items;
    expect(items.map((t) => [t.kind, t.direction, t.amount.minor, t.state, t.mcc ?? null, t.country ?? null])).toEqual([
      ['card', 'out', '1200', 'pending', '5814', 'IL'],
      ['card', 'out', '800', 'reversed', '5812', 'IL'],
      ['card', 'out', '3000', 'settled', '5411', 'US'],
      ['load', 'in', '50000', 'settled', null, null],
    ]);
    expect(items[0]).toMatchObject({ amount: { currency: 'USD' }, at: at(5).toISOString() });
    expect(r.body).not.toHaveProperty('nextCursor');
  });

  it('pages by the cursor without repeats, even when rows share a millisecond', async () => {
    const partner = await app.services.accounts.systemAccount('partner_settlement', 'USD');
    for (let i = 0; i < 60; i++) await post('load', `tx-many-${i}`, [[partner, 100n], [wallet, -100n]], at(10));
    const first = await list('dana', wallet);
    const page1 = first.body as { items: Transaction[]; nextCursor?: string };
    expect(page1.items).toHaveLength(50);
    const page2 = (await list('dana', wallet, `?cursor=${page1.nextCursor}`)).body as { items: Transaction[]; nextCursor?: string };
    expect(page2.items).toHaveLength(14);
    expect(page2.nextCursor).toBeUndefined();
    expect(new Set([...page1.items, ...page2.items].map((t) => t.id)).size).toBe(64);
    expect(((await list('dana', wallet, '?limit=5')).body as { items: Transaction[] }).items).toHaveLength(5);
    expect((await list('dana', wallet, '?cursor=bm90LWEtY3Vyc29y')).status).toBe(422);
  });

  it("another member's purse, or one that is not a wallet, answers 404; with wallet.enabled off, FEATURE_OFF", async () => {
    expect((await list('avi', wallet)).status).toBe(404);
    const pending = await app.services.accounts.memberAccount(people['dana']!.partyId, 'pending', 'USD');
    expect((await list('dana', pending)).status).toBe(404);
    expect((await list('dana', 'not-an-id')).status).toBe(404);
    const r = await list('dana', wallet, '', off);
    expect([r.status, (r.body as { code: string }).code]).toEqual([404, 'FEATURE_OFF']);
  });
});
