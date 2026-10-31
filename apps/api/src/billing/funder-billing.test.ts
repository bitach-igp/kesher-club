// TST-BIL-004 the funder's memberships and cancelling one (T-0310, REQ-BIL-004): Ben pays for Dana. Ben's list names
// her; Dana's list shows her own as a member. Ben cancels: the vendor ends it at the end of the paid period, the
// membership stays active with that date, and a retry is the same cancel. Dana's $500.00 is untouched. Dana cannot
// cancel what Ben pays for (403); Tal, a stranger, gets 404; cancelling an ended membership answers 409.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
let membershipId: string;
const NOW = new Date('2026-11-10T09:00:00Z');
const people: Record<string, { partyId: string; token: string }> = {};
const party = (who: string) => people[who]!.partyId;
const call = (who: string, method: string, url: string, key?: string) =>
  dispatch(app, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${people[who]!.token}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: '', now: NOW });
type Listed = { id: string; role: string; memberName?: string; status: string; cancelAt?: string; price: { minor: string } };

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  for (const who of ['ben', 'dana', 'tal']) {
    const partyId = uuidv7(NOW);
    people[who] = { partyId, token: (await app.services.tokens.issue({ partyId, deviceId: 'phone', roles: ['member'] })).accessToken };
  }
  await app.services.displayNames.set(party('dana'), { firstName: 'Dana', lastName: 'Example' }, NOW);
  await app.services.plans.ensurePlan('demo-club-us', 'Demo Club US');
  await app.services.plans.createVersion({ planCode: 'demo-club-us', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  membershipId = (await app.services.memberships.create({ idempotencyKey: 'ben-funds-dana', memberPartyId: party('dana'), funderPartyId: party('ben'), funderEmail: 'ben@example.com', planCode: 'demo-club-us' }, NOW)).id;
  const { accounts, ledger } = app.services;
  const wallet = await accounts.memberAccount(party('dana'), 'wallet', 'USD');
  await ledger.post({ idempotencyKey: 'dana-load', kind: 'load', effectiveAt: NOW, postings: [{ accountId: await accounts.systemAccount('partner_settlement', 'USD'), currency: 'USD', amountMinor: 50_000n }, { accountId: wallet, currency: 'USD', amountMinor: -50_000n }] });
}, 60_000);
afterAll(async () => db.close());

describe("the funder's memberships (TST-BIL-004, T-0310)", () => {
  it("Ben's list names Dana; Dana's shows hers as the member", async () => {
    expect(((await call('ben', 'GET', '/memberships')).body as { items: Listed[] }).items).toEqual([expect.objectContaining({ id: membershipId, role: 'funder', memberName: 'Dana E.', status: 'active', price: { minor: '4900', currency: 'USD' } })]);
    const dana = ((await call('dana', 'GET', '/memberships')).body as { items: Listed[] }).items;
    expect(dana).toEqual([expect.objectContaining({ id: membershipId, role: 'member' })]);
    expect(dana[0]).not.toHaveProperty('memberName');
    expect(((await call('tal', 'GET', '/memberships')).body as { items: Listed[] }).items).toEqual([]);
  });

  it('Dana cannot cancel what Ben pays for (403); Tal gets 404; Ben cancels at period end, once, and Dana keeps her money', async () => {
    expect((await call('dana', 'POST', `/memberships/${membershipId}/cancel`, 'dana-cancels-1')).status).toBe(403);
    expect((await call('tal', 'POST', `/memberships/${membershipId}/cancel`, 'tal-cancels-1')).status).toBe(404);
    const r = await call('ben', 'POST', `/memberships/${membershipId}/cancel`, 'ben-cancels-1');
    expect(r.status).toBe(200);
    const m = r.body as Listed;
    expect(m).toMatchObject({ id: membershipId, status: 'active', cancelAt: expect.any(String) });
    // A retry, with the same key or another, is the same cancel.
    expect((await call('ben', 'POST', `/memberships/${membershipId}/cancel`, 'ben-cancels-1')).body).toMatchObject({ cancelAt: m.cancelAt });
    expect((await call('ben', 'POST', `/memberships/${membershipId}/cancel`, 'ben-cancels-2')).body).toMatchObject({ cancelAt: m.cancelAt });
    expect((await app.services.accounts.purses(party('dana'))).find((p) => p.currency === 'USD')!.available).toEqual(money(50_000n, 'USD'));
  });

  it('cancelling a membership that has ended answers 409', async () => {
    await app.services.memberships.setStatus(membershipId, 'cancelled', NOW);
    const r = await call('ben', 'POST', `/memberships/${membershipId}/cancel`, 'ben-cancels-3');
    expect([r.status, (r.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
  });
});
