// TST-ADM-006 plan versions from the admin API (T-0932): Kesher finance proposes a version and a second finance member
// approves it; until then no one joins on it. The proposer cannot approve (409) and support cannot propose (403); then
// B approves and a new membership quotes the new price, while a member on the earlier version keeps theirs. A bad
// price, term or currency answers 422; a rejected version is never offered; a version is never edited.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { money, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { PlanVersionView } from './plan-catalogue.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
const A = { sub: 'finance-a', roles: ['finance'] };
const B = { sub: 'finance-b', roles: ['finance'] };
const SUPPORT = { sub: 'support-1', roles: ['support'] };
const CLUB = { 'esim.dataGb': { limit: '5', unit: 'gb', period: 'month' }, 'concierge.calls': { limit: '3', unit: 'calls', period: 'term' } };

const token = (sub: string, roles: string[]) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown) =>
  dispatch(app, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${await token(who.sub, who.roles)}` }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const proposal = (over: Record<string, unknown> = {}) => ({ planCode: 'club-il', name: 'Kesher Club Israel', market: 'IL', price: { minor: '18000', currency: 'ILS' }, termMonths: 10, entitlements: CLUB, reason: 'Launch price, approved by the board', ...over });
const join = (planCode = 'club-il') => {
  const memberPartyId = uuidv7(NOW);
  return app.services.memberships.create({ idempotencyKey: `join-${memberPartyId}`, memberPartyId, funderPartyId: uuidv7(NOW), funderEmail: 'dana@example.com', planCode }, NOW);
};

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
}, 60_000);
afterAll(async () => db.close());

describe('plan versions (TST-ADM-006, T-0932)', () => {
  let first: PlanVersionView;

  it('support cannot propose; finance proposes, the proposer cannot approve (409), and no one joins until B approves; then a new membership quotes the price', async () => {
    expect((await call(SUPPORT, 'POST', '/admin/plans', proposal())).status).toBe(403);
    const r = await call(A, 'POST', '/admin/plans', proposal());
    expect(r.status).toBe(201);
    first = r.body as PlanVersionView;
    expect(first).toMatchObject({ planCode: 'club-il', name: 'Kesher Club Israel', version: 1, market: 'IL', price: { minor: '18000', currency: 'ILS' }, termMonths: 10, fxMarkupBps: 75, state: 'proposed', offered: false, proposedBy: 'finance-a', approval: { status: 'awaiting_second_approval', approvals: 1 } });
    await expect(join()).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const self = await call(A, 'POST', '/admin/plans/club-il/versions/1/approve');
    expect([self.status, (self.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await call(SUPPORT, 'POST', '/admin/plans/club-il/versions/1/approve')).status).toBe(403);

    const approved = await call(B, 'POST', '/admin/plans/club-il/versions/1/approve');
    expect(approved.body).toMatchObject({ state: 'active', offered: true, decidedAt: NOW.toISOString(), approval: { status: 'approved', approvals: 2 } });
    const m = await join();
    expect(m).toMatchObject({ planCode: 'club-il', planVersion: 1, termMonths: 10, price: money(18_000n, 'ILS') });
    const audit = await db.query<{ action: string; subject: string }>(`select action, subject from audit.entry where action = 'plan_version.activate'`);
    expect(audit.rows).toEqual([{ action: 'plan_version.activate', subject: 'club-il:1' }]);
    // Decided once: approving again is a conflict.
    expect((await call(B, 'POST', '/admin/plans/club-il/versions/1/approve')).status).toBe(409);
  });

  it('a newer version supersedes the older for new members; a member on the earlier version keeps theirs; a version is never edited', async () => {
    const before = await join();
    const v2 = (await call(A, 'POST', '/admin/plans', proposal({ name: 'Ignored: the plan keeps its name', price: { minor: '21000', currency: 'ILS' }, reason: 'Second year price' }))).body as PlanVersionView;
    expect(v2).toMatchObject({ version: 2, name: 'Kesher Club Israel', state: 'proposed', offered: false });
    await call(B, 'POST', '/admin/plans/club-il/versions/2/approve');
    expect(await join()).toMatchObject({ planVersion: 2, price: money(21_000n, 'ILS') });
    expect(await app.services.memberships.get(before.id)).toMatchObject({ planVersion: 1, price: money(18_000n, 'ILS') });
    const list = ((await call(SUPPORT, 'GET', '/admin/plans')).body as { items: PlanVersionView[] }).items.filter((v) => v.planCode === 'club-il');
    expect(list.map((v) => [v.version, v.state, v.offered])).toEqual([
      [2, 'active', true],
      [1, 'active', false],
    ]);
    // The app's role may decide a version but never reprice one.
    await db.asRole('club_app', async (role) => expect(role.query(`update billing.plan_version set price_minor = 1 where plan_code = 'club-il'`)).rejects.toMatchObject({ code: '42501' }));
  });

  it('a bad price, term or currency answers 422 and stores nothing', async () => {
    const bad = [
      proposal({ price: { minor: '0', currency: 'ILS' } }),
      proposal({ price: { minor: '-100', currency: 'ILS' } }),
      proposal({ price: { minor: '10000001', currency: 'ILS' } }),
      proposal({ price: { minor: '18000', currency: 'USD' } }),
      proposal({ market: 'US' }),
      proposal({ termMonths: 0 }),
      proposal({ termMonths: 13 }),
      proposal({ termMonths: 2.5 }),
      proposal({ entitlements: { 'esim.dataGb': { limit: 'five', unit: 'gb', period: 'month' } } }),
      proposal({ planCode: 'Club IL' }),
      proposal({ reason: ' ' }),
      proposal({ effectiveFrom: 'soon' }),
    ];
    const count = async () => (await db.query<{ n: number }>('select count(*)::int as n from billing.plan_version')).rows[0]!.n;
    const n = await count();
    for (const body of bad) {
      const r = await call(A, 'POST', '/admin/plans', body);
      expect([r.status, (r.body as { code: string }).code], JSON.stringify(body)).toEqual([422, 'VALIDATION_FAILED']);
    }
    expect(await count()).toBe(n);
  });

  it('a rejected version is never offered, and cannot be approved afterwards', async () => {
    const v = (await call(A, 'POST', '/admin/plans', proposal({ planCode: 'club-us', name: 'Kesher Club US', market: 'US', price: { minor: '4900', currency: 'USD' }, reason: 'US launch' }))).body as PlanVersionView;
    expect((await call(B, 'POST', `/admin/plans/club-us/versions/${v.version}/reject`, { reason: '' })).status).toBe(422);
    expect((await call(B, 'POST', `/admin/plans/club-us/versions/${v.version}/reject`, { reason: 'Price not agreed yet' })).body).toMatchObject({ state: 'rejected', offered: false, approval: { status: 'rejected' } });
    expect((await call(B, 'POST', `/admin/plans/club-us/versions/${v.version}/approve`)).status).toBe(409);
    await expect(join('club-us')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await call(B, 'POST', '/admin/plans/club-us/versions/99/approve')).status).toBe(404);
    expect((await call(B, 'POST', '/admin/plans/NOPE/versions/1/approve')).status).toBe(404);
  });
});
