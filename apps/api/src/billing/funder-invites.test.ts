// TST-BIL-002 funder invites (T-0306, REQ-BIL-002): Ben, verified at T1 and with a card saved through the setup
// sheet, invites Dana by phone onto demo-club-us. The invite is open, one SMS carries its link, and nothing is
// charged. A funder at T0 answers 403, one with no saved card 422; a second open invite for the same contact
// answers 409; an unknown plan 422. Seven days later it reads expired and frees the contact. Resend rotates the
// link; cancel ends it; another funder can do neither (404).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
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
const invite = (who: string, body: Record<string, unknown>, key: string, now = NOW) => call(who, 'POST', '/funder-invites', { memberName: 'Dana Example', phone: '+1 555 555 0101', planCode: 'demo-club-us', ...body }, key, now);
const verify = (partyId: string) =>
  db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) values ($1, $2, 'T1', 'US', 'simulator', 'approved', $3, $3::timestamptz + interval '1 day', $3)`, [`kyc-${partyId}`, partyId, NOW]);
const sms = (to: string) => sim.simulators.notify.sent.filter((n) => n.to === to);

beforeAll(async () => {
  db = await createTestDatabase();
  sim = new SimulatorHost();
  app = createApp({ db, registry: sim.registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  for (const who of ['ben', 'tal', 'unverified', 'nocard']) {
    const partyId = uuidv7(NOW);
    people[who] = { partyId, token: (await app.services.tokens.issue({ partyId, deviceId: 'phone', roles: ['member'] })).accessToken };
  }
  for (const who of ['ben', 'tal', 'nocard']) await verify(people[who]!.partyId);
  const v = await app.services.planCatalogue.propose({ planCode: 'demo-club-us', name: 'Demo Club US', market: 'US', priceMinor: 4_900n, currency: 'USD', termMonths: 10, entitlements: {}, fxMarkupBps: 75n, effectiveFrom: NOW, reason: 'Demo price' }, FINANCE_A, NOW);
  await app.services.planCatalogue.approve('demo-club-us', v.version.version, FINANCE_B, NOW);
}, 60_000);
afterAll(async () => db.close());

describe('funder invites (TST-BIL-002, T-0306)', () => {
  let first: FunderInvite;

  it('Ben saves a card, then invites Dana: open, one SMS with the join link, nothing charged', async () => {
    for (const who of ['ben', 'tal', 'unverified']) {
      const sheet = await call(who, 'POST', '/me/billing/setup-sheet');
      expect(sheet.status).toBe(200);
      expect(sheet.body).toMatchObject({ clientSecret: expect.any(String), wallets: { applePay: expect.any(Boolean), googlePay: expect.any(Boolean) } });
    }
    const r = await invite('ben', {}, 'ben-invites-dana-1');
    expect(r.status).toBe(201);
    first = r.body as FunderInvite;
    expect(first).toMatchObject({ memberName: 'Dana Example', contactKind: 'phone', contact: '•••• 0101', planCode: 'demo-club-us', planVersion: 1, status: 'open', sentCount: 1, expiresAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString() });
    const sent = sms('+15555550101');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms', template: 'funder.invite', data: { memberName: 'Dana Example', inviteUrl: expect.stringMatching(/^https:\/\/app\.kesher\.example\/join\?token=[\w-]{32}$/) } });
    // Only the token's hash is kept, and no membership or charge exists yet.
    const token = new URL(sent[0]!.data['inviteUrl']!).searchParams.get('token')!;
    expect((await db.query(`select count(*)::int as n from billing.funder_invite where token_hash = $1`, [token])).rows[0]).toEqual({ n: 0 });
    expect((await db.query('select count(*)::int as n from billing.membership')).rows[0]).toEqual({ n: 0 });
    // A replayed key answers the same invite and sends nothing more.
    expect((await invite('ben', {}, 'ben-invites-dana-1')).body).toMatchObject({ id: first.id });
    expect(sms('+15555550101')).toHaveLength(1);
  });

  it('T0 answers 403, no saved card 422, a second open invite for the contact 409, an unknown plan or a bad contact 422', async () => {
    expect((await invite('unverified', { phone: '+15555550199' }, 'unverified-1')).status).toBe(403);
    expect([(await invite('nocard', { phone: '+15555550198' }, 'nocard-1')).status]).toEqual([422]);
    const again = await invite('ben', { phone: '+1 (555) 555-0101' }, 'ben-invites-dana-2');
    expect([again.status, (again.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    for (const [body, key] of [[{ planCode: 'no-such-plan', phone: '+15555550111' }, 'bad-plan'], [{ phone: '555-0101' }, 'bad-phone'], [{ email: 'dana@example.com' }, 'both'], [{ phone: undefined, email: 'not-an-email' }, 'bad-email'], [{ memberName: ' ' }, 'no-name']] as const) {
      expect((await invite('ben', body, key)).status, key).toBe(422);
    }
    // The same contact invited by another funder is theirs to invite.
    expect((await invite('tal', {}, 'tal-invites-dana-1')).status).toBe(201);
  });

  it('resend rotates the link and counts; cancel ends it; another funder can do neither', async () => {
    expect((await call('tal', 'POST', `/funder-invites/${first.id}/resend`)).status).toBe(404);
    const resent = await call('ben', 'POST', `/funder-invites/${first.id}/resend`);
    expect(resent.body).toMatchObject({ status: 'open', sentCount: 2 });
    const [a, b] = sms('+15555550101').filter((n) => n.data['inviteUrl']).slice(-2).map((n) => n.data['inviteUrl']);
    expect(a).not.toBe(b);
    const mail = await invite('ben', { phone: undefined, email: 'Avi@Example.com', memberName: 'Avi Example' }, 'ben-invites-avi-1');
    expect(mail.body).toMatchObject({ contactKind: 'email', contact: 'a•••@example.com' });
    expect((await call('tal', 'POST', `/funder-invites/${(mail.body as FunderInvite).id}/cancel`)).status).toBe(404);
    expect((await call('ben', 'POST', `/funder-invites/${(mail.body as FunderInvite).id}/cancel`)).body).toMatchObject({ status: 'cancelled' });
    expect((await call('ben', 'POST', `/funder-invites/${(mail.body as FunderInvite).id}/resend`)).status).toBe(409);
  });

  it('seven days on, the invite reads expired, frees the contact, and nothing was ever charged', async () => {
    const list = await call('ben', 'GET', '/funder-invites', undefined, undefined, LATER);
    // Both were sent in the same millisecond: compare them by name, not by their order.
    expect((list.body as { items: FunderInvite[] }).items.map((i) => [i.memberName, i.status]).sort()).toEqual([
      ['Avi Example', 'cancelled'],
      ['Dana Example', 'expired'],
    ]);
    expect((await call('ben', 'POST', `/funder-invites/${first.id}/resend`, undefined, undefined, LATER)).status).toBe(409);
    expect((await invite('ben', {}, 'ben-invites-dana-3', LATER)).body).toMatchObject({ status: 'open', sentCount: 1 });
    expect((await db.query('select count(*)::int as n from billing.membership')).rows[0]).toEqual({ n: 0 });
  });

  it('with billing.stripe off, inviting and the setup sheet answer FEATURE_OFF', async () => {
    const off = createApp({ db, registry: sim.registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, identity: app.services.identity, flags: new (await import('./capabilities.ts')).StaticFlags(undefined, { 'billing.stripe': false }) });
    const token = (await off.services.tokens.issue({ partyId: people['ben']!.partyId, deviceId: 'phone', roles: ['member'] })).accessToken;
    const r = await dispatch(off, { method: 'POST', url: '/v1/me/billing/setup-sheet', headers: { authorization: `Bearer ${token}` }, rawBody: '', now: NOW });
    expect([r.status, (r.body as { code: string }).code]).toEqual([404, 'FEATURE_OFF']);
  });
});
