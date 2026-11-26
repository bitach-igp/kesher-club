// TST-INS-020 team and roles (T-0643, REQ-INS-020): Rivka, an Ohr admin, invites Dov as finance by email. The
// invite stores only hashes; the message carries the link. Dov accepts signed in and is staff only, with a grant
// Rivka proposed. Dov cannot approve his own role, nor can Rivka a second time; Avi, the second admin, approves with
// a step-up and Dov is finance. Staff answer 403 on every team change. Rivka removes Dov: his next call is refused.
// The last admin cannot be demoted; a single-admin institution's grant waits in the admin console's queue.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import type { Database } from '../db.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { STAFF_INVITE_BASE_URL } from './team.ts';

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-03T09:00:00Z');
const OHR = uuidv7(NOW);
const SOLO = uuidv7(NOW);
type Who = { partyId: string; access: string; stepUp: string };
const people: Record<string, Who> = {};
type Change = { staff?: { partyId: string; role: string; active: boolean }; grant?: { id: string; status: string; approvals: number } };

const call = (who: string, method: string, url: string, body?: unknown, opts: { key?: string; stepUp?: boolean } = {}) =>
  dispatch(app, {
    method,
    url: `/v1${url}`,
    headers: { authorization: `Bearer ${people[who]!.access}`, ...(opts.key ? { 'idempotency-key': opts.key } : {}), ...(opts.stepUp ? { 'x-step-up': people[who]!.stepUp } : {}) },
    rawBody: body === undefined ? '' : JSON.stringify(body),
    now: NOW,
  });

/** Signs a person up with OTP and a passkey; their token carries `roles`, and they hold a fresh step-up. */
async function person(name: string, phone: string, roles: string[]): Promise<void> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  const access = (await s.tokens.issue({ partyId, deviceId: `web-${phone}`, roles })).accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  people[name] = { partyId, access, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Solo School', 'IL')`, [OHR, SOLO]);
  for (const [name, phone, inst, role] of [['rivka', '+972501230001', OHR, 'admin'], ['avi', '+972501230002', OHR, 'admin'], ['coordinator', '+972501230003', OHR, 'staff'], ['dov', '+972501230004', undefined, undefined], ['sole', '+972501230005', SOLO, 'admin'], ['tal', '+972501230006', undefined, undefined]] as const) {
    await person(name, phone, role ? ['member', `org_${role}`] : ['member']);
    if (inst) await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)`, [people[name]!.partyId, inst, role]);
  }
}, 120_000);
afterAll(async () => db.close());

const tokenOf = (to: string) => {
  const sent = host.simulators.notify.sent.filter((n) => n.to === to).at(-1)!;
  return String(sent.data['inviteUrl']).slice(STAFF_INVITE_BASE_URL.length);
};

describe('team and roles (TST-INS-020, T-0643)', () => {
  let grantId = '';

  it("Rivka invites Dov as finance; only hashes are stored; Dov accepts and is staff, with Rivka's grant pending", async () => {
    const r = await call('rivka', 'POST', `/institutions/${OHR}/staff-invites`, { email: 'Dov@Example.com', role: 'finance' }, { key: 'invite-dov-1' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ role: 'finance', channel: 'email' });
    const stored = JSON.stringify((await db.query('select * from org.staff_invite')).rows);
    expect(stored).not.toMatch(/dov@example\.com/i);
    expect(stored).not.toContain(tokenOf('dov@example.com'));
    const accepted = (await call('dov', 'POST', `/staff-invites/${tokenOf('dov@example.com')}/accept`)).body as Change;
    expect(accepted.staff).toMatchObject({ partyId: people['dov']!.partyId, role: 'staff', active: true });
    expect(accepted.grant).toMatchObject({ status: 'awaiting_second_approval', approvals: 1 });
    grantId = accepted.grant!.id;
    const team = (await call('coordinator', 'GET', `/institutions/${OHR}/team`)).body as { pendingGrants: { id: string }[]; invites: unknown[] };
    expect(team.pendingGrants.map((g) => g.id)).toEqual([grantId]);
    expect(team.invites).toEqual([]);
  });

  it('Dov cannot approve his own role, nor Rivka twice; Avi approves with a step-up and Dov is finance', async () => {
    expect((await call('dov', 'POST', `/institutions/${OHR}/staff-grants/${grantId}/approve`, undefined, { stepUp: true })).status).toBe(403);
    expect((await call('rivka', 'POST', `/institutions/${OHR}/staff-grants/${grantId}/approve`, undefined, { stepUp: true })).status).toBe(409);
    expect((await call('avi', 'POST', `/institutions/${OHR}/staff-grants/${grantId}/approve`)).status).toBe(401);
    const r = (await call('avi', 'POST', `/institutions/${OHR}/staff-grants/${grantId}/approve`, undefined, { stepUp: true })).body as Change;
    expect(r).toMatchObject({ grant: { status: 'approved' }, staff: { role: 'finance' } });
    expect((await app.services.identity.findUser(people['dov']!.partyId))?.roles).toContain('org_finance');
  });

  it('staff answer 403 on every team change; nobody raises their own role', async () => {
    expect((await call('coordinator', 'POST', `/institutions/${OHR}/staff-invites`, { phone: '+972501239999', role: 'staff' }, { key: 'coord-invite-1' })).status).toBe(403);
    expect((await call('coordinator', 'PATCH', `/institutions/${OHR}/team/${people['dov']!.partyId}`, { active: false }, { key: 'coord-remove-1' })).status).toBe(403);
    expect((await call('rivka', 'PATCH', `/institutions/${OHR}/team/${people['rivka']!.partyId}`, { role: 'finance' }, { key: 'self-raise-1' })).status).toBe(403);
  });

  it("Rivka removes Dov: the very token that worked a moment ago is refused, and the audit has it", async () => {
    // Dov signs in again after the approval, so his token carries the finance role.
    people['dov']!.access = (await app.services.tokens.issue({ partyId: people['dov']!.partyId, deviceId: 'web-dov', roles: ['member', 'org_finance'] })).accessToken;
    expect((await call('dov', 'GET', '/me/institution')).status).toBe(200);
    expect((await call('dov', 'GET', `/institutions/${OHR}/team`)).status).toBe(200);
    const r = (await call('rivka', 'PATCH', `/institutions/${OHR}/team/${people['dov']!.partyId}`, { active: false }, { key: 'remove-dov-1' })).body as Change;
    expect(r.staff).toMatchObject({ active: false });
    expect((await app.services.identity.findUser(people['dov']!.partyId))?.roles).not.toContain('org_finance');
    expect((await call('dov', 'GET', '/me/institution')).status).toBe(403);
    expect((await call('dov', 'GET', `/institutions/${OHR}/team`)).status).toBe(404);
    const audit = await db.query<{ action: string }>(`select action from audit.entry where subject = $1 order by at`, [people['dov']!.partyId]);
    expect(audit.rows.map((a) => a.action)).toEqual(['institution.staff.grant', 'institution.staff.propose', 'institution.staff.grant', 'institution.staff.remove']);
  });

  it('the last admin cannot be demoted; a single-admin grant waits in the admin console queue', async () => {
    expect((await call('sole', 'PATCH', `/institutions/${SOLO}/team/${people['sole']!.partyId}`, { role: 'staff' }, { key: 'sole-demote-1' })).status).toBe(409);
    await call('sole', 'POST', `/institutions/${SOLO}/staff-invites`, { phone: '+972501230006', role: 'admin' }, { key: 'invite-tal-1' });
    const accepted = (await call('tal', 'POST', `/staff-invites/${tokenOf('+972501230006')}/accept`)).body as Change;
    expect(accepted.grant).toMatchObject({ status: 'awaiting_second_approval' });
    const queue = await db.query<{ id: string }>(`select id from ops.approval_request where kind = 'staff_grant' and status = 'awaiting_second_approval' and payload->>'institutionId' = $1`, [SOLO]);
    expect(queue.rows.map((x) => x.id)).toEqual([accepted.grant!.id]);
  });
});

describe('acceptById inside a transaction (T-1122)', () => {
  const invite = async (phone: string, role: 'staff' | 'finance') => {
    await call('rivka', 'POST', `/institutions/${OHR}/staff-invites`, { phone, role }, { key: `t1122-${phone}-${role}` });
    const hash = createHash('sha256').update(tokenOf(phone)).digest('hex');
    return (await db.query<{ id: string }>('select id from org.staff_invite where token_hash = $1', [hash])).rows[0]!.id;
  };
  const rows = async (party: string) => ({
    staff: (await db.query('select 1 from org.staff where party_id = $1', [party])).rows.length,
    accepted: (await db.query('select 1 from org.staff_invite_acceptance where party_id = $1', [party])).rows.length,
    audit: (await db.query("select 1 from audit.entry where subject = $1", [party])).rows.length,
  });
  const inTx = (tx: { query: Database['query'] }): Database => ({ query: tx.query, transaction: async (fn) => fn(tx as never) });

  it('a throw after the accept rolls back the staff row, the acceptance and the audit rows; the invite can be accepted again', async () => {
    await person('uri', '+972501230011', ['member']);
    const id = await invite('+972501230011', 'staff');
    const party = people['uri']!.partyId;
    await expect(db.transaction(async (raw) => { await app.services.team.acceptById(id, party, NOW, inTx(raw)); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await rows(party)).toEqual({ staff: 0, accepted: 0, audit: 0 });
    const done = await db.transaction(async (raw) => app.services.team.acceptById(id, party, NOW, inTx(raw)));
    expect(done.staff).toMatchObject({ role: 'staff', active: true });
    expect(await rows(party)).toMatchObject({ staff: 1, accepted: 1 });
    // the token role is not written inside the transaction: settle writes it, once the transaction has committed
    expect((await app.services.identity.findUser(party))?.roles).not.toContain('org_staff');
    await done.settle!();
    expect((await app.services.identity.findUser(party))?.roles).toContain('org_staff');
  });

  it('a finance invite opens its grant only in settle; without a transaction acceptById still returns the grant at once', async () => {
    await person('vera', '+972501230012', ['member']);
    const id = await invite('+972501230012', 'finance');
    const party = people['vera']!.partyId;
    const done = await db.transaction(async (raw) => app.services.team.acceptById(id, party, NOW, inTx(raw)));
    expect(done.grant).toBeUndefined();
    expect((await done.settle!())?.status).toBe('awaiting_second_approval');
    await person('wolf', '+972501230013', ['member']);
    const id2 = await invite('+972501230013', 'finance');
    const direct = await app.services.team.acceptById(id2, people['wolf']!.partyId, NOW);
    expect(direct.grant?.status).toBe('awaiting_second_approval');
    expect(direct.settle).toBeUndefined();
    expect((await app.services.identity.findUser(people['wolf']!.partyId))?.roles).toContain('org_staff');
  });

  it('a second party cannot take an invite that another party accepted between the read and the insert', async () => {
    await person('xena', '+972501230014', ['member']);
    await person('yoav', '+972501230015', ['member']);
    const id = await invite('+972501230014', 'staff');
    await app.services.team.acceptById(id, people['xena']!.partyId, NOW);
    await expect(app.services.team.acceptById(id, people['yoav']!.partyId, NOW)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // the race itself: the read saw no acceptance, the insert finds one
    await person('zoe', '+972501230016', ['member']);
    await person('amit', '+972501230017', ['member']);
    const id2 = await invite('+972501230016', 'staff');
    const [r1, r2] = await Promise.allSettled([app.services.team.acceptById(id2, people['zoe']!.partyId, NOW), app.services.team.acceptById(id2, people['amit']!.partyId, NOW)]);
    expect([r1.status, r2.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect((await db.query('select 1 from org.staff where party_id = any($1)', [[people['zoe']!.partyId, people['amit']!.partyId]])).rows).toHaveLength(1);
  });
});
