// TST-WAL-007 the funder's household (T-0534, REQ-WAL-007): Ben funds Dana, who holds $500.00 and last spent $12.00 at
// a café in Israel, and has invited Avi. Ben's household lists Dana with her balances and that spend, and Avi as
// invited. Past-due still shows Dana's balance (dunning never freezes money already loaded). Ben asking for another
// household id, Dana's or Tal's, answers 404, as does Dana asking for Ben's; a member Ben no longer funds drops out.
// With wallet.enabled off, FEATURE_OFF.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { Household } from './household.ts';

let db: TestDatabase;
let app: App;
let off: App;
let sim: SimulatorHost;
const NOW = new Date('2026-11-10T09:00:00Z');
const people: Record<string, { partyId: string; token: string }> = {};

const household = (who: string, id: string, a: App = app) => dispatch(a, { method: 'GET', url: `/v1/households/${id}`, headers: { authorization: `Bearer ${people[who]!.token}` }, rawBody: '', now: NOW });
const party = (who: string) => people[who]!.partyId;

beforeAll(async () => {
  db = await createTestDatabase();
  sim = new SimulatorHost();
  const opts = { db, registry: sim.registry, market: 'US' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags(undefined, { 'wallet.enabled': false }) });
  for (const who of ['ben', 'tal', 'dana', 'noa']) {
    const partyId = uuidv7(NOW);
    people[who] = { partyId, token: (await app.services.tokens.issue({ partyId, deviceId: 'phone', roles: ['member'] })).accessToken };
  }
  await app.services.displayNames.set(party('dana'), { firstName: 'Dana', lastName: 'Example' }, NOW);
  await app.services.displayNames.set(party('noa'), { firstName: 'Noa', lastName: 'Example' }, NOW);
  await app.services.plans.ensurePlan('demo-club-us', 'Demo Club US');
  await app.services.plans.createVersion({ planCode: 'demo-club-us', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  for (const [funder, member] of [['ben', 'dana'], ['ben', 'noa'], ['tal', 'tal']] as const) {
    await app.services.memberships.create({ idempotencyKey: `seed-${funder}-${member}`, memberPartyId: party(member), funderPartyId: party(funder), funderEmail: `${funder}@example.com`, planCode: 'demo-club-us' }, NOW);
  }
  // Dana's purse: $500.00 loaded, then a $12.00 card authorisation at a café in Israel, as the ledger records them.
  const wallet = await app.services.accounts.memberAccount(party('dana'), 'wallet', 'USD');
  const pending = await app.services.accounts.memberAccount(party('dana'), 'pending', 'USD');
  await app.services.ledger.post({ idempotencyKey: 'test-dana-load', kind: 'load', effectiveAt: NOW, postings: [{ accountId: await app.services.accounts.systemAccount('partner_settlement', 'USD'), currency: 'USD', amountMinor: 51_200n }, { accountId: wallet, currency: 'USD', amountMinor: -51_200n }] });
  await app.services.ledger.post({ idempotencyKey: 'test-dana-auth', kind: 'auth_hold', effectiveAt: NOW, postings: [{ accountId: wallet, currency: 'USD', amountMinor: 1_200n }, { accountId: pending, currency: 'USD', amountMinor: -1_200n }], metadata: { cardId: 'card-1', authId: 'auth-1', mcc: '5814', country: 'IL' } });
  // Ben has also invited Avi, who has not accepted yet.
  await db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) values ('kyc-ben', $1, 'T1', 'US', 'simulator', 'approved', $2, $2::timestamptz + interval '1 day', $2)`, [party('ben'), NOW]);
  await app.services.funderInvites.create(party('ben'), { memberName: 'Avi Example', phone: '+15555550102', planCode: 'demo-club-us' }, 'ben-invites-avi', NOW);
}, 60_000);
afterAll(async () => db.close());

describe("the funder's household (TST-WAL-007, T-0534)", () => {
  it('lists each member Ben funds with balances and last spend, and Avi as invited', async () => {
    const r = await household('ben', party('ben'));
    expect(r.status).toBe(200);
    const h = r.body as Household;
    expect(h).toMatchObject({ id: party('ben'), funderId: party('ben') });
    expect(h.members.map((m) => m.displayName)).toEqual(['Dana E.', 'Noa E.']);
    expect(h.members[0]).toMatchObject({
      partyId: party('dana'),
      membershipStatus: 'active',
      planCode: 'demo-club-us',
      balances: expect.arrayContaining([{ minor: '50000', currency: 'USD' }]),
      lastSpend: { amount: { minor: '1200', currency: 'USD' }, at: NOW.toISOString(), mcc: '5814', country: 'IL' },
    });
    expect(h.members[1]).not.toHaveProperty('lastSpend');
    expect(h.invites).toEqual([{ inviteId: expect.any(String), memberName: 'Avi Example', membershipStatus: 'invited', planCode: 'demo-club-us', expiresAt: expect.any(String) }]);
    // What the funder privacy notice keeps from them never appears.
    expect(JSON.stringify(h)).not.toMatch(/note|concierge|case/i);
  });

  it('past-due still shows the balance; a member no longer funded drops out', async () => {
    const dana = (await app.services.memberships.forMember(party('dana')))!;
    await app.services.memberships.setStatus(dana.id, 'past_due', NOW);
    expect(((await household('ben', party('ben'))).body as Household).members[0]).toMatchObject({ membershipStatus: 'past_due', balances: expect.arrayContaining([{ minor: '50000', currency: 'USD' }]) });
    const noa = (await app.services.memberships.forMember(party('noa')))!;
    await app.services.memberships.setStatus(noa.id, 'cancelled', NOW);
    expect(((await household('ben', party('ben'))).body as Household).members.map((m) => m.displayName)).toEqual(['Dana E.']);
  });

  it('any other household id answers 404: Ben asking for Dana\'s or Tal\'s, Dana asking for Ben\'s, or no id at all', async () => {
    for (const [who, id] of [['ben', party('dana')], ['ben', party('tal')], ['dana', party('ben')], ['ben', 'not-an-id']] as const) {
      const r = await household(who, id);
      expect([r.status, (r.body as { code: string }).code], `${who} → ${id}`).toEqual([404, 'NOT_FOUND']);
    }
  });

  it('with wallet.enabled off, FEATURE_OFF', async () => {
    const r = await household('ben', party('ben'), off);
    expect([r.status, (r.body as { code: string }).code]).toEqual([404, 'FEATURE_OFF']);
  });
});
