// TST-WAL-009 a funded member's activity (T-0537, REQ-WAL-009): Ben funds Dana. This month she spent $12.00 at a café
// (MCC 5814) and $30.00 at a grocer (5411), had an $8.00 authorisation released, and sent Avi $20.00 with a note; last
// month she spent at a grocer too. Ben sees her transactions across both purses (the P2P is a P2P, out, with no name
// or note), this month's spend by category (groceries $30.00, food and drink $12.00; the released one and last month's
// are not counted), and her cards. Ben asking for Avi, whom he does not fund, through his own household or through
// Tal's, answers 404, as does Dana asking for herself through Ben's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { categoryOf, type MemberActivity } from './household.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const LAST_MONTH = new Date('2026-10-20T09:00:00Z');
const people: Record<string, { partyId: string; token: string }> = {};
const party = (who: string) => people[who]!.partyId;
const view = (who: string, household: string, member: string) => dispatch(app, { method: 'GET', url: `/v1/households/${household}/members/${member}`, headers: { authorization: `Bearer ${people[who]!.token}` }, rawBody: '', now: NOW });

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
  for (const who of ['ben', 'tal', 'dana', 'avi']) {
    const partyId = uuidv7(NOW);
    people[who] = { partyId, token: (await app.services.tokens.issue({ partyId, deviceId: 'phone', roles: ['member'] })).accessToken };
  }
  await app.services.displayNames.set(party('dana'), { firstName: 'Dana', lastName: 'Example' }, NOW);
  await app.services.plans.ensurePlan('demo-club-us', 'Demo Club US');
  await app.services.plans.createVersion({ planCode: 'demo-club-us', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  await app.services.memberships.create({ idempotencyKey: 'ben-funds-dana', memberPartyId: party('dana'), funderPartyId: party('ben'), funderEmail: 'ben@example.com', planCode: 'demo-club-us' }, NOW);
  await app.services.memberships.create({ idempotencyKey: 'tal-funds-avi', memberPartyId: party('avi'), funderPartyId: party('tal'), funderEmail: 'tal@example.com', planCode: 'demo-club-us' }, NOW);

  const { accounts, ledger } = app.services;
  const wallet = await accounts.memberAccount(party('dana'), 'wallet', 'USD');
  const pending = await accounts.memberAccount(party('dana'), 'pending', 'USD');
  const aviWallet = await accounts.memberAccount(party('avi'), 'wallet', 'USD');
  const partner = await accounts.systemAccount('partner_settlement', 'USD');
  const post = (kind: string, key: string, legs: [string, bigint][], at: Date, metadata: Record<string, unknown> = {}) =>
    ledger.post({ idempotencyKey: key, kind, effectiveAt: at, postings: legs.map(([accountId, amountMinor]) => ({ accountId, currency: 'USD' as const, amountMinor })), metadata });
  await post('load', 'dana-load', [[partner, 60_000n], [wallet, -60_000n]], LAST_MONTH);
  await post('auth_hold', 'dana-grocer-old', [[wallet, 2_500n], [pending, -2_500n]], LAST_MONTH, { authId: 'old', mcc: '5411', country: 'US' });
  await post('auth_hold', 'dana-cafe', [[wallet, 1_200n], [pending, -1_200n]], NOW, { authId: 'cafe', mcc: '5814', country: 'IL' });
  await post('auth_hold', 'dana-grocer', [[wallet, 3_000n], [pending, -3_000n]], NOW, { authId: 'grocer', mcc: '5411', country: 'IL' });
  await post('auth_hold', 'dana-released', [[wallet, 800n], [pending, -800n]], NOW, { authId: 'gone', mcc: '5812', country: 'IL' });
  await post('auth_release', 'dana-released-back', [[pending, 800n], [wallet, -800n]], NOW, { authId: 'gone' });
  await post('p2p', 'dana-to-avi', [[wallet, 2_000n], [aviWallet, -2_000n]], NOW, { note: 'Pizza money', toPartyId: party('avi') });
}, 60_000);
afterAll(async () => db.close());

describe("a funded member's activity (TST-WAL-009, T-0537)", () => {
  it("Ben sees Dana's transactions, this month's spend by category and her cards; the P2P carries no name or note", async () => {
    const r = await view('ben', party('ben'), party('dana'));
    expect(r.status).toBe(200);
    const a = r.body as MemberActivity;
    expect(a).toMatchObject({ partyId: party('dana'), displayName: 'Dana E.', cards: [] });
    expect(a.spendByCategory).toEqual([
      { category: 'groceries', amount: { minor: '3000', currency: 'USD' } },
      { category: 'food_drink', amount: { minor: '1200', currency: 'USD' } },
    ]);
    const p2p = a.transactions.find((t) => t.kind === 'p2p')!;
    expect(p2p).toMatchObject({ direction: 'out', amount: { minor: '2000', currency: 'USD' }, state: 'settled' });
    expect(JSON.stringify(a)).not.toMatch(/Pizza|note|counterparty|untrusted/);
    expect(JSON.stringify(a)).not.toContain(party('avi'));
    expect(a.transactions.map((t) => t.kind).sort()).toEqual(['card', 'card', 'card', 'card', 'load', 'p2p']);
  });

  it('a member Ben does not fund, or another household, answers 404 alike', async () => {
    for (const [who, household, member] of [['ben', party('ben'), party('avi')], ['ben', party('tal'), party('avi')], ['dana', party('ben'), party('dana')], ['ben', party('ben'), 'not-an-id']] as const) {
      const r = await view(who, household, member);
      expect([r.status, (r.body as { code: string }).code], `${who} ${member}`).toEqual([404, 'NOT_FOUND']);
    }
  });

  it('names categories from the merchant code, and anything unknown as other', () => {
    expect(['5814', '5411', '5541', '4511', '7832', '5651', '6011', undefined].map(categoryOf)).toEqual(['food_drink', 'groceries', 'transport', 'travel', 'entertainment', 'shopping', 'other', 'other']);
  });
});
