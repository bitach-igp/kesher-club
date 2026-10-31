// TST-BIL-003 accepting a funder's invite (T-0307, REQ-BIL-003): Dana previews Ben's invite (who pays, the plan, its
// price) and accepts it twice: one active membership at $49.00 with Ben as funder, on the version the invite pinned
// even though a dearer one is offered since, and one subscription at the vendor. Someone else accepting it after
// answers 409; an expired invite answers 409 and charges nothing; Ben accepting his own answers 422; a declined card
// answers 422 and leaves the invite open; a rotated link answers 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { FunderInvite } from './funder-invites.ts';

let db: TestDatabase;
let app: App;
let sim: SimulatorHost;
const NOW = new Date('2026-11-10T09:00:00Z');
const LATER = new Date(NOW.getTime() + 7 * 86_400_000 + 1);
const FINANCE_A = { partyId: uuidv7(NOW), role: 'finance', subject: 'finance-a' };
const FINANCE_B = { partyId: uuidv7(NOW), role: 'finance', subject: 'finance-b' };
const people: Record<string, { partyId: string; token: string }> = {};

const call = (who: string, method: string, url: string, body?: unknown, key?: string, now = NOW) =>
  dispatch(app, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${people[who]!.token}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const accept = (who: string, token: string, key: string, now = NOW) => call(who, 'POST', `/funder-invites/${token}/accept`, undefined, key, now);
/** The funder invites someone by phone and returns the link's token, as the member would find it in their SMS. */
async function invite(funder: string, phone: string, memberName: string, key: string): Promise<{ id: string; token: string }> {
  const r = await call(funder, 'POST', '/funder-invites', { memberName, phone, planCode: 'demo-club-us' }, key);
  expect(r.status, `${key}: ${JSON.stringify(r.body)}`).toBe(201);
  const url = sim.simulators.notify.sent.filter((n) => n.to === phone).at(-1)!.data['inviteUrl']!;
  return { id: (r.body as FunderInvite).id, token: new URL(url).searchParams.get('token')! };
}
const subscriptions = async () => (await db.query<{ n: number }>(`select count(*)::int as n from ops.external_ref where entity_type = 'membership'`)).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase();
  sim = new SimulatorHost();
  app = createApp({ db, registry: sim.registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  for (const who of ['ben', 'tal', 'dana', 'avi', 'eli']) {
    const partyId = uuidv7(NOW);
    people[who] = { partyId, token: (await app.services.tokens.issue({ partyId, deviceId: 'phone', roles: ['member'] })).accessToken };
  }
  for (const who of ['ben', 'tal']) {
    await db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) values ($1, $2, 'T1', 'US', 'simulator', 'approved', $3, $3::timestamptz + interval '1 day', $3)`, [`kyc-${who}`, people[who]!.partyId, NOW]);
  }
  await app.services.displayNames.set(people['ben']!.partyId, { firstName: 'Ben', lastName: 'Example' }, NOW);
  // Tal's card is the simulator's declining one.
  await app.services.memberships.ensureCustomer(people['tal']!.partyId, 'tal@declined.example');
  for (const who of ['ben', 'tal']) expect((await call(who, 'POST', '/me/billing/setup-sheet')).status).toBe(200);
  const v = await app.services.planCatalogue.propose({ planCode: 'demo-club-us', name: 'Demo Club US', market: 'US', priceMinor: 4_900n, currency: 'USD', termMonths: 10, entitlements: {}, fxMarkupBps: 75n, effectiveFrom: NOW, reason: 'Demo price' }, FINANCE_A, NOW);
  await app.services.planCatalogue.approve('demo-club-us', v.version.version, FINANCE_B, NOW);
}, 60_000);
afterAll(async () => db.close());

describe('accepting a funder invite (TST-BIL-003, T-0307)', () => {
  let dana: { id: string; token: string };

  it('Dana sees who pays and what; accepting twice is one active membership at the pinned $49.00 with Ben as funder, one subscription', async () => {
    dana = await invite('ben', '+15555550101', 'Dana Example', 'ben-dana');
    // A dearer version is offered after the invite went out: Dana still joins on the one Ben chose.
    const v2 = await app.services.planCatalogue.propose({ planCode: 'demo-club-us', name: 'Demo Club US', market: 'US', priceMinor: 5_900n, currency: 'USD', termMonths: 10, entitlements: {}, fxMarkupBps: 75n, effectiveFrom: NOW, reason: 'Second year' }, FINANCE_A, NOW);
    await app.services.planCatalogue.approve('demo-club-us', v2.version.version, FINANCE_B, NOW);

    const preview = await call('dana', 'GET', `/funder-invites/${dana.token}`);
    expect(preview.body).toEqual({ funderName: 'Ben E.', memberName: 'Dana Example', planCode: 'demo-club-us', planName: 'Demo Club US', price: { minor: '4900', currency: 'USD' }, termMonths: 10, status: 'open' });

    const first = await accept('dana', dana.token, 'dana-accepts-1');
    expect(first.status).toBe(200);
    const body = first.body as { invite: FunderInvite; membership: { id: string } };
    expect(body).toMatchObject({ invite: { status: 'accepted', membershipId: body.membership.id }, membership: { planCode: 'demo-club-us', planVersion: 1, status: 'active', price: { minor: '4900', currency: 'USD' } } });
    const again = await accept('dana', dana.token, 'dana-accepts-2');
    expect((again.body as { membership: { id: string } }).membership.id).toBe(body.membership.id);
    expect(await subscriptions()).toBe(1);
    // Ben is now Dana's funder: what loads and card controls check.
    expect(await app.services.memberships.forMember(people['dana']!.partyId)).toMatchObject({ funderPartyId: people['ben']!.partyId, status: 'active', price: money(4_900n, 'USD') });
    expect((await call('dana', 'GET', `/funder-invites/${dana.token}`)).body).toMatchObject({ status: 'accepted' });
  });

  it('someone else accepting an accepted invite answers 409; Ben accepting his own answers 422; a rotated link answers 404', async () => {
    expect((await accept('avi', dana.token, 'avi-too-late')).status).toBe(409);
    const eli = await invite('ben', '+15555550105', 'Eli Example', 'ben-invites-eli');
    expect((await accept('ben', eli.token, 'ben-self')).status).toBe(422);
    await call('ben', 'POST', `/funder-invites/${eli.id}/resend`);
    expect((await accept('eli', eli.token, 'eli-old-link')).status).toBe(404);
    expect((await call('eli', 'GET', `/funder-invites/${eli.token}`)).status).toBe(404);
    expect(await subscriptions()).toBe(1);
  });

  it('an expired invite answers 409 and charges nothing; a declined card answers 422 and leaves the invite open', async () => {
    const avi = await invite('ben', '+15555550102', 'Avi Example', 'ben-invites-avi');
    const late = await accept('avi', avi.token, 'avi-late', LATER);
    expect([late.status, (late.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);

    const eli = await invite('tal', '+15555550106', 'Eli Example', 'tal-invites-eli');
    const declined = await accept('eli', eli.token, 'eli-declined');
    expect([declined.status, (declined.body as { code: string }).code]).toEqual([422, 'VALIDATION_FAILED']);
    expect(((await call('tal', 'GET', '/funder-invites')).body as { items: FunderInvite[] }).items[0]).toMatchObject({ id: eli.id, status: 'open' });
    expect(await subscriptions()).toBe(1);
    expect(await app.services.memberships.forMember(people['avi']!.partyId)).toBeUndefined();
  });
});
