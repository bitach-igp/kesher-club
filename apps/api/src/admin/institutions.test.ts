// T-0924 institution onboarding over the HTTP dispatcher and PGlite (TST-ADM-004, REQ-ADM-004): admin A
// proposes a member as finance and nothing changes; admin B approves and the role reaches the member's
// token at the next sign-in, with an audit entry naming both; A cannot approve its own proposal; after
// removal the member's institution calls answer 403 at once, on the token they already hold.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { STAFF_AUDIENCE, STAFF_ISSUER, staffPartyId } from './staff-token.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-01T09:00:00Z');
const MIRIAM = uuidv7(NOW);
const YOSEF = uuidv7(NOW);
const staffToken = (sub: string) =>
  new SignJWT({ roles: ['admin'] }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (method: string, url: string, opts: { body?: unknown; token?: string; key?: string } = {}) =>
  dispatch(app, { method, url, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.key ? { 'idempotency-key': opts.key } : {}) }, rawBody: opts.body === undefined ? '' : JSON.stringify(opts.body), now: NOW });
/** What authenticate issues: the roles stored on the account at sign-in time. */
const signIn = async (partyId: string) => {
  const u = (await app.services.identity.findUser(partyId))!;
  return (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: u.roles })).accessToken;
};
const roles = async (partyId: string) => (await app.services.identity.findUser(partyId))!.roles;

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
  await app.services.identity.createUser({ partyId: MIRIAM, phone: '+972501110001', status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
  await app.services.identity.createUser({ partyId: YOSEF, phone: '+972501110002', status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
}, 60_000);
afterAll(async () => db.close());

describe('admins onboard institutions and staff (T-0924, TST-ADM-004)', () => {
  let yeshiva: string;

  it('creates an institution once per key, audited; a member token is refused', async () => {
    const a = await staffToken('admin-a');
    const body = { name: 'Yeshivat Har Kesher', market: 'IL', reason: 'Signed the pilot agreement' };
    const r = await call('POST', '/v1/admin/institutions', { body, token: a, key: 'onboard-yeshiva-1' });
    expect(r.status).toBe(201);
    yeshiva = (r.body as { id: string }).id;
    expect(r.body).toMatchObject({ name: 'Yeshivat Har Kesher', market: 'IL', activeStaff: 0 });
    const again = await call('POST', '/v1/admin/institutions', { body, token: a, key: 'onboard-yeshiva-1' });
    expect((again.body as { id: string }).id).toBe(yeshiva);
    expect((await call('POST', '/v1/admin/institutions', { body: { ...body, name: 'Other' }, token: a, key: 'onboard-yeshiva-1' })).status).toBe(409);
    expect((await call('POST', '/v1/admin/institutions', { body: { ...body, reason: ' ' }, token: a, key: 'onboard-yeshiva-2' })).status).toBe(422);
    const list = await call('GET', '/v1/admin/institutions', { token: a });
    expect((list.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([yeshiva]);
    const trail = await app.services.audit.list(yeshiva, 10);
    expect(trail.map((e) => [e.action, e.actorId])).toEqual([['institution.create', staffPartyId('admin-a')]]);
    expect((await call('GET', '/v1/admin/institutions', { token: await signIn(MIRIAM) })).status).toBe(403);
  });

  it('the staff role applies at once and a retry writes nothing more', async () => {
    const a = await staffToken('admin-a');
    const r = await call('POST', `/v1/admin/institutions/${yeshiva}/staff`, { body: { partyId: YOSEF, role: 'staff', reason: 'Office manager' }, token: a, key: 'staff-yosef-1' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ staff: { partyId: YOSEF, institutionId: yeshiva, role: 'staff', active: true, createdAt: NOW.toISOString(), phoneMasked: '•••• 0002' } });
    await call('POST', `/v1/admin/institutions/${yeshiva}/staff`, { body: { partyId: YOSEF, role: 'staff', reason: 'Office manager' }, token: a, key: 'staff-yosef-1' });
    expect(await roles(YOSEF)).toEqual(['member', 'org_staff']);
    expect((await app.services.audit.list(YOSEF, 10)).filter((e) => e.action === 'institution.staff.grant')).toHaveLength(1);
  });

  it('finance needs a second admin: A proposes, nothing changes; A cannot approve; B approves and the role lands at next sign-in', async () => {
    const a = await staffToken('admin-a');
    const b = await staffToken('admin-b');
    const before = await signIn(MIRIAM);
    const proposed = await call('POST', `/v1/admin/institutions/${yeshiva}/staff`, { body: { partyId: MIRIAM, role: 'finance', reason: 'Bursar' }, token: a, key: 'finance-miriam-1' });
    expect(proposed.status).toBe(201);
    const grant = (proposed.body as { grant: { id: string; kind: string; status: string; approvals: number } }).grant;
    expect(grant).toMatchObject({ kind: 'staff_grant', status: 'awaiting_second_approval', approvals: 1 });
    expect(proposed.body).not.toHaveProperty('staff');
    expect(await roles(MIRIAM)).toEqual(['member']);
    expect((await call('GET', `/v1/institutions/${yeshiva}/collections?month=2026-11`, { token: before })).status).toBe(403);
    const pending = await call('GET', `/v1/admin/institutions/${yeshiva}/staff`, { token: b });
    expect((pending.body as { pendingGrants: { id: string }[] }).pendingGrants.map((g) => g.id)).toEqual([grant.id]);

    const self = await call('POST', `/v1/admin/staff-grants/${grant.id}/approve`, { token: a });
    expect([self.status, (self.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);

    const approved = await call('POST', `/v1/admin/staff-grants/${grant.id}/approve`, { token: b });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ grant: { status: 'approved', approvals: 2 }, staff: { partyId: MIRIAM, role: 'finance', active: true } });
    expect(await roles(MIRIAM)).toEqual(['member', 'org_finance']);
    // The token from before the grant still carries only `member`; the next sign-in carries the role.
    expect((await call('GET', `/v1/institutions/${yeshiva}/collections?month=2026-11`, { token: before })).status).toBe(403);
    expect((await call('GET', `/v1/institutions/${yeshiva}/collections?month=2026-11`, { token: await signIn(MIRIAM) })).status).toBe(200);
    const grantEntry = (await app.services.audit.list(MIRIAM, 10)).find((e) => e.action === 'institution.staff.grant')!;
    expect(grantEntry).toMatchObject({ actorId: staffPartyId('admin-b'), payload: { institutionId: yeshiva, role: 'finance', proposedBy: staffPartyId('admin-a'), approvedBy: staffPartyId('admin-b') } });
    expect((await call('POST', `/v1/admin/staff-grants/${grant.id}/approve`, { token: await staffToken('admin-c') })).status).toBe(409);
  });

  it('a member is staff of one institution at a time', async () => {
    const a = await staffToken('admin-a');
    const other = (await call('POST', '/v1/admin/institutions', { body: { name: 'Seminary', market: 'IL', reason: 'Pilot two' }, token: a, key: 'onboard-seminary-1' })).body as { id: string };
    const r = await call('POST', `/v1/admin/institutions/${other.id}/staff`, { body: { partyId: MIRIAM, role: 'staff', reason: 'Moving' }, token: a, key: 'staff-miriam-2' });
    expect([r.status, (r.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await call('POST', `/v1/admin/institutions/${other.id}/staff`, { body: { partyId: uuidv7(NOW), role: 'staff', reason: 'Nobody' }, token: a, key: 'staff-nobody-1' })).status).toBe(404);
  });

  it('removing a member stops their institution calls at once, on the token they hold, and is audited', async () => {
    const a = await staffToken('admin-a');
    const held = await signIn(MIRIAM);
    expect((await call('GET', `/v1/institutions/${yeshiva}/collections?month=2026-11`, { token: held })).status).toBe(200);
    const r = await call('POST', `/v1/admin/institutions/${yeshiva}/staff/${MIRIAM}/remove`, { body: { reason: 'Left the yeshiva' }, token: a });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ partyId: MIRIAM, active: false, role: 'finance' });
    expect((await call('GET', `/v1/institutions/${yeshiva}/collections?month=2026-11`, { token: held })).status).toBe(403);
    expect(await roles(MIRIAM)).toEqual(['member']);
    expect((await app.services.audit.list(MIRIAM, 10)).map((e) => e.action)).toContain('institution.staff.remove');
    const list = await call('GET', '/v1/admin/institutions', { token: a });
    expect((list.body as { items: { id: string; activeStaff: number }[] }).items.find((i) => i.id === yeshiva)!.activeStaff).toBe(1);
  });
});
