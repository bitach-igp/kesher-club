// TST-AUTH-008 staff SSO behaviour (T-0792, REQ-AUTH-008): start, callback and exchange with the simulator org IdP (no network), real
// createApp + dispatch on PGlite. The card's six items, then the review points: single-use bound state, PKCE-style exchange, link proof,
// sign-in only for a live link to ACTIVE staff, uniform refusals (same answer, same reads, one latency floor), flag fail-closed, opaque errors.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMetrics, DomainError, uuidv7 } from '@kesher/domain';
import { OrgIdPError, OrgIdPSimulator, SIM_OTP_CODE, SimPasskeyDevice, type OrgIdPPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import type { HttpResponse } from '../http.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { StaffIdpLinks } from './staff-idp-link.ts';
import type { AuthEvent } from '../auth/passkeys.ts';
import { StaffSso, type StaffSsoDeps } from './staff-sso.ts';

// The lifetimes are written out, not imported: a changed constant must fail here.
const SIGN_IN_TTL_MS = 10 * 60_000;
const LINK_TTL_MS = 5 * 60_000;
const CODE_TTL_MS = 60_000;

let db: TestDatabase;
let app: App;
let host: SimulatorHost;
let links: StaffIdpLinks;
const NOW = new Date('2026-11-26T10:00:00Z');
const OHR = uuidv7(NOW);
const NER = uuidv7(NOW);
const NOSSO = uuidv7(NOW);
const SYSTEM = { actorId: '00000000-0000-7000-8000-000000000000', actorRole: 'system' };
const CONSOLE = 'https://console.kesher.example/sso';
const CALLBACK = 'https://api.kesher.example/v1/sso/callback';
const ORGS = { [OHR]: { scimBearer: `scim_${OHR}` }, [NER]: { scimBearer: `scim_${NER}` } };
const flagState: { on: boolean; throws: boolean } = { on: true, throws: false };
const flags: FeatureFlags = {
  isOn: async (k) => {
    if (flagState.throws) throw new Error('flag store down');
    return k === 'auth.orgSso' && flagState.on;
  },
  keys: () => ['auth.orgSso'],
};
const lines: string[] = [];
const metrics = createMetrics({ write: (l) => lines.push(l) });
type Who = { partyId: string; access: string; stepUp: string; sessionId: string };
const people: Record<string, Who> = {};
const at = (ms: number) => new Date(NOW.getTime() + ms);

let phone = 972_501_250_000;
async function person(name: string, roles: string[]): Promise<void> {
  const s = app.services;
  const p = `+${phone++}`;
  const started = await s.otp.start({ phone: p, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${p}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${p}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  const access = (await s.tokens.issue({ partyId, deviceId: `web-${p}`, roles })).accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  people[name] = { partyId, access, sessionId: principal.sessionId, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}
async function staffer(name: string, inst: string, role: 'admin' | 'staff' = 'staff', linkedAs?: string): Promise<string> {
  await person(name, ['member', `org_${role}`]);
  await db.query('insert into org.staff (party_id, institution_id, role, active) values ($1, $2, $3, true)', [people[name]!.partyId, inst, role]);
  await app.services.identity.setUserRoles(people[name]!.partyId, ['member', `org_${role}`]);
  if (linkedAs) await links.link(inst, linkedAs, people[name]!.partyId, SYSTEM, NOW);
  return people[name]!.partyId;
}

const pair = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const post = (url: string, body: unknown, headers: Record<string, string> = {}, now = NOW) => dispatch(app, { method: 'POST', url: `/v1${url}`, headers, rawBody: JSON.stringify(body), now });
const cookieOf = (r: HttpResponse) => (r.headers?.['set-cookie'] ?? '').split(';')[0]!;
const startIn = (inst: string, p = pair(), now = NOW) => post(`/institutions/${inst}/sso/start`, { deviceId: 'web-sso', challenge: p.challenge }, {}, now);
const as = (who: string, step = true) => ({ authorization: `Bearer ${people[who]!.access}`, ...(step ? { 'x-step-up': people[who]!.stepUp } : {}) });
const linkIn = (who: string, inst: string, p = pair(), extra: Record<string, unknown> = {}, step = true) => post(`/institutions/${inst}/sso/link/start`, { challenge: p.challenge, ...extra }, as(who, step));
const cb = (q: Record<string, string>, cookie?: string, now = NOW, theApp = app) => dispatch(theApp, { method: 'GET', url: `/v1/sso/callback?${new URLSearchParams(q)}`, headers: cookie ? { cookie } : {}, rawBody: '', now });
const frag = (r: HttpResponse) => (r.headers?.['location'] ?? '').split('#')[1] ?? '';
const idp = (subject: string, groups?: string) => `ok:${subject}:${subject}@example.com${groups ? `:${groups}` : ''}`;
const ex = (code: string, verifier: string, now = NOW) => post('/sso/exchange', { code, verifier }, {}, now);
const markerCount = async (kind: string) => (await db.query<{ n: number }>('select count(*)::int as n from ops.workflow_marker where kind = $1', [kind])).rows[0]!.n;
const allMarkers = async () => (await db.query<{ kind: string }>("select kind from ops.workflow_marker where kind like 'sso%'")).rows.length;
const linkRows = async (party: string) => (await db.query('select 1 from org.staff_idp_link where party_id = $1 and unlinked_at is null', [party])).rows.length;
/** A refusal as the caller sees it: status, body and headers with the trace id dropped and the cookie reduced to its attributes. */
const shape = (r: HttpResponse) => JSON.stringify({ s: r.status, b: r.body ? { ...(r.body as object), traceId: '' } : null, h: { ...r.headers, 'x-trace-id': '', 'set-cookie': (r.headers?.['set-cookie'] ?? '').replace(/^[^;]*/, '') } });

/** A sign-in that reaches the callback for `subject`; returns what a test needs to inspect or replay it. */
async function signIn(inst: string, code: string, p = pair(), now = NOW) {
  const start = await startIn(inst, p);
  const state = (start.body as { state: string }).state;
  const cookie = cookieOf(start);
  const res = await cb({ code, state }, cookie, now);
  return { p, state, cookie, res, f: frag(res) };
}

const mk = (over: Partial<StaffSsoDeps> = {}) =>
  new StaffSso({ db, flags, identity: app.services.identity, events: app.services.passkeys.events, tokens: app.services.tokens, links, team: app.services.team, port: () => host.simulators['org-idp'], configured: () => true, orgs: ORGS, consoleUrl: CONSOLE, callbackUrl: CALLBACK, metrics, floorMs: 0, ...over });
const counting = (base: Database) => {
  const n = { q: 0 };
  return { n, db: { query: (t: string, p?: readonly unknown[]) => { n.q += 1; return base.query(t, p); }, transaction: base.transaction } as Database };
};

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  host.simulators['org-idp'] = new OrgIdPSimulator(host.clock, [OHR, NER, NOSSO]);
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags, orgIdp: { orgs: ORGS, consoleUrl: CONSOLE, callbackUrl: CALLBACK, callbackFloorMs: 0 } });
  links = new StaffIdpLinks({ db, audit: app.services.audit });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Beit Ner', 'IL'), ($3, 'No SSO School', 'IL')`, [OHR, NER, NOSSO]);
  await staffer('rivka', OHR, 'admin');
  await staffer('nina', NOSSO, 'admin');
}, 120_000);
afterAll(async () => db.close());

describe('staff SSO sign-in (TST-AUTH-008, T-0792)', () => {
  it('(1) start returns a URL, a 256-bit state and a __Host- cookie; only the state hash is stored; the linked identity gets the normal token', async () => {
    const avi = await staffer('avi', OHR, 'staff', 'idp-avi');
    const p = pair();
    const start = await startIn(OHR, p);
    expect(start.status).toBe(200);
    const body = start.body as { url: string; state: string; expiresAt: string };
    expect(body.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.url).toContain(body.state);
    expect(body.expiresAt).toBe(at(SIGN_IN_TTL_MS).toISOString());
    const sc = start.headers!['set-cookie']!;
    expect(sc).toMatch(/^__Host-sso-[0-9a-f]{24}=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    expect(sc).not.toContain('Domain');
    const row = (await db.query<{ value: string; claim: string }>("select value, claim from ops.workflow_marker where kind = 'sso_state' and claim = $1", [createHash('sha256').update(body.state).digest('hex')])).rows[0]!;
    expect(row.value).not.toContain(body.state);
    expect(row.value).not.toContain(sc.split('=')[1]!.split(';')[0]!);
    expect(JSON.parse(row.value)).toMatchObject({ inst: OHR, mode: 'sign_in', device: 'web-sso', challenge: p.challenge, exp: at(SIGN_IN_TTL_MS).getTime() });

    const res = await cb({ code: idp('idp-avi'), state: body.state }, cookieOf(start));
    expect(res.status).toBe(302);
    expect(res.headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    expect(res.headers!['location']).toMatch(new RegExp(`^${CONSOLE}#code=[A-Za-z0-9_-]{43}$`));
    expect(res.headers!['set-cookie']).toMatch(/^__Host-sso-[0-9a-f]{24}=; Max-Age=0; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    expect(res.headers!['set-cookie']!.split('=')[0]).toBe(sc.split('=')[0]);
    const code = frag(res).slice('code='.length);
    const stored = (await db.query<{ value: string }>("select value from ops.workflow_marker where kind = 'sso_code' and claim = $1", [createHash('sha256').update(code).digest('hex')])).rows[0]!;
    expect(stored.value).not.toContain(code);
    expect(JSON.parse(stored.value)).toMatchObject({ party: avi, inst: OHR, challenge: p.challenge });

    const done = await ex(code, p.verifier);
    expect(done.status).toBe(200);
    const out = done.body as { tokens: { accessToken: string }; institutionId: string };
    expect(out.institutionId).toBe(OHR);
    const principal = await app.services.tokens.verifyAccess(out.tokens.accessToken);
    expect(principal).toMatchObject({ partyId: avi, deviceId: 'web-sso', roles: ['member', 'org_staff'] });
  });

  it('(2) a wrong, unknown, malformed or replayed state is the same refusal, and a replay or double submit has exactly one winner', async () => {
    await staffer('bea', OHR, 'staff', 'idp-bea');
    const first = await signIn(OHR, idp('idp-bea'));
    expect(first.f).toMatch(/^code=/);
    const replay = await cb({ code: idp('idp-bea'), state: first.state }, first.cookie);
    expect(frag(replay)).toBe('error=refused');
    expect(shape(replay)).toBe(shape(await cb({ code: idp('idp-bea'), state: 'x'.repeat(43) }, first.cookie)));
    // a concurrent double submit
    const s = await startIn(OHR);
    const q = { code: idp('idp-bea'), state: (s.body as { state: string }).state };
    const both = await Promise.all([cb(q, cookieOf(s)), cb(q, cookieOf(s))]);
    expect(both.map(frag).filter((f) => f.startsWith('code=')).length).toBe(1);
    expect(await markerCount('sso_state_used')).toBeGreaterThan(0);
  });

  it('(3) an unlinked identity without an invite is refused and nothing is linked, created or issued', async () => {
    const codes = await markerCount('sso_code');
    const links0 = (await db.query('select 1 from org.staff_idp_link')).rows.length;
    const staff0 = (await db.query('select 1 from org.staff')).rows.length;
    // an IdP identity whose email is a staff member's is still nobody: email never finds a staff row
    for (const subject of ['idp-nobody', 'idp-rivka-by-email']) {
      const r = await signIn(OHR, `ok:${subject}:rivka@example.com`);
      expect(r.f).toBe('error=refused');
    }
    expect(await markerCount('sso_code')).toBe(codes);
    expect((await db.query('select 1 from org.staff_idp_link')).rows.length).toBe(links0);
    expect((await db.query('select 1 from org.staff')).rows.length).toBe(staff0);
  });

  it('(4) after the deprovision the same identity is refused at the callback; an inactive staff row and a link at another institution are refused too', async () => {
    const cai = await staffer('cai', OHR, 'staff', 'idp-cai');
    expect((await signIn(OHR, idp('idp-cai'))).f).toMatch(/^code=/);
    expect(await app.services.deprovision!.remove(OHR, 'idp-cai', 'evt-cai', NOW, { reason: 'test' })).toBe(true);
    expect((await signIn(OHR, idp('idp-cai'))).f).toBe('error=refused');
    expect(cai).toBeTruthy();
    const dan = await staffer('dan', OHR, 'staff', 'idp-dan');
    await app.services.team.deactivate(OHR, dan);
    expect((await signIn(OHR, idp('idp-dan'))).f).toBe('error=refused');
    await staffer('eli', NER, 'staff', 'idp-eli');
    expect((await signIn(OHR, idp('idp-eli'))).f).toBe('error=refused');
  });

  it('(5) with auth.orgSso off all four answer 404 FEATURE_OFF and store nothing; a throwing flag service fails closed; an unconfigured app is inert', async () => {
    const p = pair();
    const good = await startIn(OHR, p);
    const state = (good.body as { state: string }).state;
    const code = (await ex('c'.repeat(43), p.verifier)).status;
    expect(code).toBe(401);
    const before = await allMarkers();
    for (const mode of ['off', 'throws'] as const) {
      flagState.on = mode !== 'off';
      flagState.throws = mode === 'throws';
      const rs = [await startIn(OHR), await linkIn('rivka', OHR), await cb({ code: idp('idp-x'), state }, cookieOf(good)), await ex('c'.repeat(43), p.verifier)];
      for (const r of rs) {
        expect(r.status).toBe(404);
        expect(r.body).toMatchObject({ code: 'FEATURE_OFF' });
        expect(r.headers?.['set-cookie']).toBeUndefined();
        expect(r.headers?.['location']).toBeUndefined();
      }
    }
    flagState.on = true;
    flagState.throws = false;
    expect(await allMarkers()).toBe(before);
    // the flag is read again at the callback and the exchange: off after a good start, the state is left unused
    flagState.on = false;
    expect((await cb({ code: idp('idp-x'), state }, cookieOf(good))).status).toBe(404);
    flagState.on = true;
    expect(await db.query("select 1 from ops.workflow_marker where kind = 'sso_state_used'").then((r) => r.rows.length)).toBe(await markerCount('sso_state_used'));
    // no console URL or binding configured: FEATURE_OFF even with the flag on
    const bare = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags, orgIdp: { orgs: ORGS } });
    const r = await dispatch(bare, { method: 'POST', url: `/v1/institutions/${OHR}/sso/start`, headers: {}, rawBody: JSON.stringify({ deviceId: 'd', challenge: p.challenge }), now: NOW });
    expect(r.status).toBe(404);
    expect(() => createApp({ db, registry: host.registry, market: 'IL', signingKey: undefined as never, issuer: 'x', flags, orgIdp: { consoleUrl: `${CONSOLE}#frag`, callbackUrl: CALLBACK } })).toThrow(/consoleUrl/);
  });

  it('(6) a group claim naming an admin role does not raise the role; the token carries the stored roles', async () => {
    const gus = await staffer('gus', OHR, 'staff', 'idp-gus');
    const r = await signIn(OHR, idp('idp-gus', 'org_admin,admin'));
    const done = await ex(r.f.slice(5), r.p.verifier);
    const principal = await app.services.tokens.verifyAccess((done.body as { tokens: { accessToken: string } }).tokens.accessToken);
    expect(principal.roles).toEqual(['member', 'org_staff']);
    expect((await db.query<{ role: string }>('select role from org.staff where party_id = $1', [gus])).rows[0]!.role).toBe('staff');
  });
});

describe('state rules', () => {
  it('the cookie binds the state: no cookie, a wrong cookie or another flow\'s cookie is refused WITHOUT burning the state; the right one still works', async () => {
    await staffer('hal', OHR, 'staff', 'idp-hal');
    const a = await startIn(OHR);
    const b = await startIn(OHR);
    const state = (a.body as { state: string }).state;
    const q = { code: idp('idp-hal'), state };
    const name = cookieOf(a).split('=')[0]!;
    for (const c of [undefined, `${name}=${'A'.repeat(43)}`, `${name}=`, cookieOf(b), `${cookieOf(b).split('=')[0]}=${cookieOf(a).split('=')[1]}`]) expect(frag(await cb(q, c))).toBe('error=refused');
    const used = await markerCount('sso_state_used');
    expect(frag(await cb(q, `other=1; ${cookieOf(a)}; more=2`))).toMatch(/^code=/);
    expect(await markerCount('sso_state_used')).toBe(used + 1);
  });

  it('a sign-in state expires after 10 minutes and a link state after 5; the exchange code after 60 seconds', async () => {
    await staffer('ida', OHR, 'staff', 'idp-ida');
    const ok = await signIn(OHR, idp('idp-ida'), pair(), at(SIGN_IN_TTL_MS - 1));
    expect(ok.f).toMatch(/^code=/);
    const late = await signIn(OHR, idp('idp-ida'), pair(), at(SIGN_IN_TTL_MS));
    expect(late.f).toBe('error=refused');
    const s = await startIn(OHR);
    expect(frag(await cb({ code: idp('idp-ida'), state: (s.body as { state: string }).state }, cookieOf(s), at(SIGN_IN_TTL_MS + 1)))).toBe('error=refused');
    const link = await linkIn('rivka', OHR);
    expect(JSON.parse((await db.query<{ value: string }>("select value from ops.workflow_marker where kind = 'sso_state' and claim = $1", [createHash('sha256').update((link.body as { state: string }).state).digest('hex')])).rows[0]!.value).exp).toBe(at(LINK_TTL_MS).getTime());
    expect(frag(await cb({ code: idp('idp-rivka-x'), state: (link.body as { state: string }).state }, cookieOf(link), at(LINK_TTL_MS)))).toBe('error=refused');
    const c = await signIn(OHR, idp('idp-ida'));
    expect((await ex(c.f.slice(5), c.p.verifier, at(CODE_TTL_MS))).status).toBe(401);
    const d = await signIn(OHR, idp('idp-ida'));
    expect((await ex(d.f.slice(5), d.p.verifier, at(CODE_TTL_MS - 1))).status).toBe(200);
  });

  it('missing or malformed parameters and an IdP error redirect are the same 302, never a 422, and an error redirect does not burn the state', async () => {
    const s = await startIn(OHR);
    const state = (s.body as { state: string }).state;
    const c = cookieOf(s);
    const base = shape(await cb({}, c));
    for (const q of [{ state }, { code: 'x' }, { state: 'short', code: 'x' }, { state: 'é'.repeat(50), code: 'x' }, { state: 's'.repeat(129), code: 'x' }, { code: 'x'.repeat(3000), state }, { error: 'access_denied', error_description: 'nope <b>', state, code: idp('idp-ida') }]) {
      const r = await cb(q, c);
      expect(r.status).toBe(302);
      expect(frag(r)).toBe('error=refused');
      expect(JSON.stringify(r)).not.toContain('nope');
    }
    expect(JSON.parse(shape(await cb({}, c))).h.location).toBe(JSON.parse(base).h.location);
    expect(await db.query('select 1 from ops.workflow_marker where kind = $1 and subject_id = (select subject_id from ops.workflow_marker where kind = $2 and claim = $3)', ['sso_state_used', 'sso_state', createHash('sha256').update(state).digest('hex')]).then((r) => r.rows.length)).toBe(0);
  });

  it('the institution comes only from the stored state: another organisation in the identity, or no per-organisation record, is refused', async () => {
    await staffer('jon', OHR, 'staff', 'idp-jon');
    const sim = host.simulators['org-idp'];
    const other: OrgIdPPort = { startSso: (...a) => sim.startSso(...a), handleCallback: async (i) => ({ ...(await sim.handleCallback(i)), orgId: NER }), parseScimEvent: (...a) => sim.parseScimEvent(...a), listDirectory: (...a) => sim.listDirectory(...a) };
    const svc = mk({ port: () => other });
    const s = await svc.startSignIn(OHR, { deviceId: 'd', challenge: pair().challenge }, NOW);
    const codes = await markerCount('sso_code');
    expect((await svc.callback({ code: idp('idp-jon'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location).toBe(`${CONSOLE}#error=refused`);
    expect(await markerCount('sso_code')).toBe(codes);
    // the state was made where a record existed; this instance has none for the institution
    const s2 = await mk().startSignIn(OHR, { deviceId: 'd', challenge: pair().challenge }, NOW);
    expect((await mk({ orgs: {} }).callback({ code: idp('idp-jon'), state: s2.body.state }, s2.setCookie.split(';')[0], NOW)).location).toBe(`${CONSOLE}#error=refused`);
    expect((await mk().callback({ code: idp('idp-jon'), state: s2.body.state }, s2.setCookie.split(';')[0], NOW)).location).toBe(`${CONSOLE}#error=refused`); // consumed above
  });

  it('start: a bad body is 422 for every institution alike; an unknown, malformed or SSO-less institution is the one FEATURE_OFF; an IdP outage is 503 and stores nothing', async () => {
    const p = pair();
    const bad = [{}, { deviceId: 'd' }, { challenge: p.challenge }, { deviceId: 'd', challenge: p.challenge.slice(1) }, { deviceId: 'd', challenge: `${p.challenge.slice(1)}=` }, { deviceId: '', challenge: p.challenge }];
    for (const b of bad) for (const inst of [OHR, NOSSO, 'nope']) {
      const r = await post(`/institutions/${inst}/sso/start`, b);
      expect(r.status).toBe(422);
    }
    const off = [NOSSO, 'nope', uuidv7(NOW), OHR.toUpperCase().slice(0, 35)];
    const shapes = new Set<string>();
    for (const inst of off) shapes.add(shape(await startIn(inst, p)));
    expect(shapes.size).toBe(1);
    expect(JSON.parse([...shapes][0]!)).toMatchObject({ s: 404, b: { code: 'FEATURE_OFF' } });
    expect((await startIn(OHR.toUpperCase())).status).toBe(200);
    const sim = host.simulators['org-idp'];
    const orig = sim.startSso.bind(sim);
    sim.startSso = async () => { throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'down'); };
    const states = await markerCount('sso_state');
    const r = await startIn(OHR);
    sim.startSso = orig;
    expect(r.status).toBe(503);
    expect(r.headers?.['set-cookie']).toBeUndefined();
    expect(await markerCount('sso_state')).toBe(states);
  });
});

describe('exchange', () => {
  it('a wrong verifier is the uniform 401, does not consume the code, and five of them kill it (429); unknown codes leave no row', async () => {
    await staffer('kim', OHR, 'staff', 'idp-kim');
    const r = await signIn(OHR, idp('idp-kim'));
    const code = r.f.slice(5);
    const unknown = await markerCount('sso_code_attempt');
    const before = await allMarkers();
    const u = await ex('u'.repeat(43), r.p.verifier);
    expect(u.status).toBe(401);
    expect(await allMarkers()).toBe(before);
    expect(await markerCount('sso_code_attempt')).toBe(unknown);
    const wrongBody = await ex(code, pair().verifier);
    expect(wrongBody.status).toBe(401);
    expect(shape(wrongBody)).toBe(shape(u));
    for (let i = 0; i < 3; i += 1) expect((await ex(code, pair().verifier)).status).toBe(401);
    expect(await markerCount('sso_code_attempt')).toBe(unknown + 4);
    expect((await ex(code, pair().verifier)).status).toBe(401); // the 5th wrong one
    expect((await ex(code, pair().verifier)).status).toBe(429);
    expect((await ex(code, r.p.verifier)).status).toBe(429); // dead, even for the right verifier
    expect(await markerCount('sso_code_attempt')).toBe(unknown + 5);
    // a code that took fewer than five wrong tries still redeems, and the first wrong one did not consume it
    const r2 = await signIn(OHR, idp('idp-kim'));
    expect((await ex(r2.f.slice(5), pair().verifier)).status).toBe(401);
    expect((await ex(r2.f.slice(5), r2.p.verifier)).status).toBe(200);
  });

  it('a redeemed code cannot be replayed and a concurrent double redemption has one winner', async () => {
    await staffer('lee', OHR, 'staff', 'idp-lee');
    const r = await signIn(OHR, idp('idp-lee'));
    const both = await Promise.all([ex(r.f.slice(5), r.p.verifier), ex(r.f.slice(5), r.p.verifier)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 401]);
    expect((await ex(r.f.slice(5), r.p.verifier)).status).toBe(401);
  });

  it('the verifier is checked against the challenge stored with the state; the callback takes no challenge from the request', async () => {
    await staffer('mia', OHR, 'staff', 'idp-mia');
    const p = pair();
    const evil = pair();
    const start = await startIn(OHR, p);
    const res = await cb({ code: idp('idp-mia'), state: (start.body as { state: string }).state, challenge: evil.challenge }, cookieOf(start));
    const code = frag(res).slice(5);
    expect((await ex(code, evil.verifier)).status).toBe(401);
    expect((await ex(code, p.verifier)).status).toBe(200);
  });

  it('a schema-invalid body is 422 (the verifier and code floors are 43), a well-formed wrong one is the uniform 401', async () => {
    const v = pair().verifier;
    for (const b of [{}, { code: 'c'.repeat(43) }, { verifier: v }, { code: 'c'.repeat(42), verifier: v }, { code: 'c'.repeat(129), verifier: v }, { code: 'c'.repeat(43), verifier: v.slice(1) }, { code: 'c'.repeat(43), verifier: `${v.slice(1)}!` }, { code: 'c'.repeat(43), verifier: `${v}${v}${v}` }, { code: 7, verifier: v }]) expect((await post('/sso/exchange', b)).status).toBe(422);
    expect((await post('/sso/exchange', { code: 'c'.repeat(43), verifier: v })).status).toBe(401);
    expect((await post('/sso/exchange', { code: 'c'.repeat(128), verifier: v.repeat(2).slice(0, 128) })).status).toBe(401);
  });

  it('the flag is read again at redemption: a code made while it was on is not redeemable while it is off', async () => {
    await staffer('flo', OHR, 'staff', 'idp-flo');
    const r = await signIn(OHR, idp('idp-flo'));
    flagState.on = false;
    await expect(mk().exchange({ code: r.f.slice(5), verifier: r.p.verifier }, NOW)).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    flagState.on = true;
    expect((await ex(r.f.slice(5), r.p.verifier)).status).toBe(200);
  });

  it('a removal in the 60 seconds after the callback is honoured at redemption', async () => {
    await staffer('noa', OHR, 'staff', 'idp-noa');
    const r = await signIn(OHR, idp('idp-noa'));
    await app.services.deprovision!.remove(OHR, 'idp-noa', 'evt-noa', NOW, { reason: 'test' });
    const res = await ex(r.f.slice(5), r.p.verifier);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('tokens');
  });

  it('a failed token issue leaves no replayable code: it releases the claim, the retry redeems once, then the code is dead', async () => {
    await staffer('opal', OHR, 'staff', 'idp-opal');
    let fail = true;
    const svc = mk({ tokens: { issue: async (i) => { if (fail) { fail = false; throw new Error('token store down'); } return app.services.tokens.issue(i); } } });
    const p = pair();
    const s = await svc.startSignIn(OHR, { deviceId: 'd', challenge: p.challenge }, NOW);
    const out = await svc.callback({ code: idp('idp-opal'), state: s.body.state }, s.setCookie.split(';')[0], NOW);
    const code = out.location.split('#code=')[1]!;
    await expect(svc.exchange({ code, verifier: p.verifier }, NOW)).rejects.toThrow('token store down');
    expect(await markerCount('sso_code_released')).toBeGreaterThan(0);
    expect((await svc.exchange({ code, verifier: p.verifier }, NOW)).institutionId).toBe(OHR);
    await expect(svc.exchange({ code, verifier: p.verifier }, NOW)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('link flow', () => {
  it('an active staff member with a fresh step-up links once; the audit row carries no subject; the next sign-in works', async () => {
    const before = await linkRows(people['rivka']!.partyId);
    const p = pair();
    const start = await linkIn('rivka', OHR, p);
    expect(start.status).toBe(200);
    expect(start.headers!['set-cookie']).toContain('Max-Age=300');
    const res = await cb({ code: idp('idp-rivka'), state: (start.body as { state: string }).state }, cookieOf(start));
    const done = await ex(frag(res).slice(5), p.verifier);
    expect(done.status).toBe(200);
    expect(before).toBe(0);
    expect(await links.find(OHR, 'idp-rivka')).toBe(people['rivka']!.partyId);
    const audit = (await db.query<{ subject: string; payload: Record<string, unknown> }>("select subject, payload from audit.entry where action = 'institution.staff.idp_link' and subject = $1", [people['rivka']!.partyId])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('idp-rivka');
    expect((await signIn(OHR, idp('idp-rivka'))).f).toMatch(/^code=/);
    // a second link start for a linked party is a 409, for a member only
    expect((await linkIn('rivka', OHR)).status).toBe(409);
  });

  it('answers in the contract order: bearer, step-up, 422, then membership (one NOT_FOUND for every non-member), then FEATURE_OFF, 409, 429', async () => {
    await person('dov', ['member']);
    await person('pat', ['member']);
    const p = pair();
    expect((await post(`/institutions/${OHR}/sso/link/start`, { challenge: p.challenge })).status).toBe(401);
    const noStep = await linkIn('dov', OHR, p, {}, false);
    expect(noStep.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await post(`/institutions/${OHR}/sso/link/start`, { challenge: 'short' }, as('dov'))).status).toBe(422);
    expect((await post(`/institutions/${NOSSO}/sso/link/start`, {}, as('dov'))).status).toBe(422);
    // invites: one for Ner, one expired, one already taken, one for Ohr
    const invite = async (inst: string, who: string, email: string) => {
      await app.services.team.invite(inst, people[who]!.partyId, { role: 'staff', email }, `key-${email}-12345`, NOW);
      const sent = host.simulators.notify.sent.filter((n) => n.to === email).at(-1)!;
      return String(sent.data['inviteUrl']).split('token=')[1]!;
    };
    await staffer('ned', NER, 'admin');
    const other = await invite(NER, 'ned', 'dov-ner@example.com');
    const stale = await invite(OHR, 'rivka', 'dov-stale@example.com');
    await db.query("update org.staff_invite set expires_at = $1 where token_hash = $2", [at(-1000), createHash('sha256').update(stale).digest('hex')]);
    const taken = await invite(OHR, 'rivka', 'dov-taken@example.com');
    await app.services.team.accept(taken, people['pat']!.partyId, NOW);
    const shapes = new Set<string>();
    for (const [inst, extra] of [[OHR, {}], [NOSSO, {}], ['nope', {}], [uuidv7(NOW), {}], [OHR, { inviteToken: 'bogus' }], [OHR, { inviteToken: other }], [OHR, { inviteToken: stale }], [OHR, { inviteToken: taken }], [NOSSO, { inviteToken: other }]] as const) {
      const r = await linkIn('dov', inst, p, extra);
      shapes.add(JSON.stringify({ s: r.status, c: (r.body as { code: string }).code }));
    }
    expect([...shapes]).toEqual([JSON.stringify({ s: 404, c: 'NOT_FOUND' })]);
    expect(await markerCount('sso_state')).toBeGreaterThan(0);
    // a member of an institution with no SSO record sees FEATURE_OFF
    expect((await linkIn('nina', NOSSO)).body).toMatchObject({ code: 'FEATURE_OFF' });
    // read-only at start: no invite was consumed or accepted
    const ok = await invite(OHR, 'rivka', 'dov-ok@example.com');
    const accepted = (await db.query('select 1 from org.staff_invite_acceptance')).rows.length;
    expect((await linkIn('dov', OHR, p, { inviteToken: ok })).status).toBe(200);
    expect((await db.query('select 1 from org.staff_invite_acceptance')).rows.length).toBe(accepted);
    expect((await db.query('select 1 from org.staff where party_id = $1', [people['dov']!.partyId])).rows.length).toBe(0);
  });

  it('per party: the sixth link start in ten minutes is 429 (for a member only), and another party is unaffected', async () => {
    await staffer('quin', NER, 'staff');
    await staffer('ron', NER, 'staff');
    for (let i = 0; i < 5; i += 1) expect((await linkIn('quin', NER)).status).toBe(200);
    expect((await linkIn('quin', NER)).status).toBe(429);
    expect((await linkIn('ron', NER)).status).toBe(200);
    expect((await linkIn('dov', NER)).status).toBe(404);
    const quin = { partyId: people['quin']!.partyId, sessionId: people['quin']!.sessionId, deviceId: 'web' };
    await expect(mk().startLink(quin, NER, { challenge: pair().challenge }, at(10 * 60_000 - 1))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await mk().startLink(quin, NER, { challenge: pair().challenge }, at(10 * 60_000))).body.state).toHaveLength(43);
  });

  it('an invite holder is made staff and linked only at the callback, after the IdP identity is verified', async () => {
    await person('sue', ['member']);
    await app.services.team.invite(OHR, people['rivka']!.partyId, { role: 'staff', email: 'sue@example.com' }, 'key-sue-invite-1', NOW);
    const token = String(host.simulators.notify.sent.filter((n) => n.to === 'sue@example.com').at(-1)!.data['inviteUrl']).split('token=')[1]!;
    const p = pair();
    const start = await linkIn('sue', OHR, p, { inviteToken: token });
    const state = (start.body as { state: string }).state;
    // the IdP names another organisation: refused and the invite is NOT consumed
    const sim = host.simulators['org-idp'];
    const orig = sim.handleCallback.bind(sim);
    sim.handleCallback = async (i) => ({ ...(await orig(i)), orgId: NER });
    const mismatch = await cb({ code: idp('idp-sue'), state }, cookieOf(start));
    sim.handleCallback = orig;
    expect(frag(mismatch)).toBe('error=refused');
    expect((await db.query('select 1 from org.staff where party_id = $1', [people['sue']!.partyId])).rows).toHaveLength(0);
    // a fresh start and a good callback
    const start2 = await linkIn('sue', OHR, p, { inviteToken: token });
    const res = await cb({ code: idp('idp-sue'), state: (start2.body as { state: string }).state }, cookieOf(start2));
    expect(frag(res)).toMatch(/^code=/);
    expect((await db.query<{ institution_id: string; active: boolean }>('select institution_id, active from org.staff where party_id = $1', [people['sue']!.partyId])).rows[0]).toMatchObject({ institution_id: OHR, active: true });
    expect(await links.find(OHR, 'idp-sue')).toBe(people['sue']!.partyId);
    const done = await ex(frag(res).slice(5), p.verifier);
    const principal = await app.services.tokens.verifyAccess((done.body as { tokens: { accessToken: string } }).tokens.accessToken);
    expect(principal.roles).toContain('org_staff');
  });

  it('a lost or changed proof is refused at the callback and links nothing: revoked session, removed party, a consumed invite, a taken subject, a live link', async () => {
    // revoked session
    await staffer('tess', OHR, 'staff');
    const a = await linkIn('tess', OHR);
    await app.services.tokens.revokeAll(people['tess']!.partyId, 'test');
    expect(frag(await cb({ code: idp('idp-tess'), state: (a.body as { state: string }).state }, cookieOf(a)))).toBe('error=refused');
    expect(await linkRows(people['tess']!.partyId)).toBe(0);
    // removed between start and callback
    const uma = await staffer('uma', OHR, 'staff');
    const b = await linkIn('uma', OHR);
    await app.services.team.deactivate(OHR, uma);
    expect(frag(await cb({ code: idp('idp-uma'), state: (b.body as { state: string }).state }, cookieOf(b)))).toBe('error=refused');
    expect(await linkRows(uma)).toBe(0);
    // the subject is already linked to someone else (a 409 from the table is a refusal, not a 500), and the invite is not consumed
    await staffer('vic', OHR, 'staff', 'idp-taken');
    await person('wes', ['member']);
    await app.services.team.invite(OHR, people['rivka']!.partyId, { role: 'staff', email: 'wes@example.com' }, 'key-wes-invite-1', NOW);
    const token = String(host.simulators.notify.sent.filter((n) => n.to === 'wes@example.com').at(-1)!.data['inviteUrl']).split('token=')[1]!;
    const c = await linkIn('wes', OHR, pair(), { inviteToken: token });
    expect(frag(await cb({ code: idp('idp-taken'), state: (c.body as { state: string }).state }, cookieOf(c)))).toBe('error=refused');
    expect((await db.query('select 1 from org.staff where party_id = $1', [people['wes']!.partyId])).rows).toHaveLength(0);
    // the invite is accepted by someone else between start and callback
    const d = await linkIn('wes', OHR, pair(), { inviteToken: token });
    await app.services.team.accept(token, people['dov']!.partyId, NOW);
    expect(frag(await cb({ code: idp('idp-wes'), state: (d.body as { state: string }).state }, cookieOf(d)))).toBe('error=refused');
    expect(await linkRows(people['wes']!.partyId)).toBe(0);
    // the party got a live link between start and callback
    await staffer('xan', OHR, 'staff');
    const e = await linkIn('xan', OHR);
    await links.link(OHR, 'idp-xan-other', people['xan']!.partyId, SYSTEM, NOW);
    expect(frag(await cb({ code: idp('idp-xan'), state: (e.body as { state: string }).state }, cookieOf(e)))).toBe('error=refused');
    expect(await links.find(OHR, 'idp-xan')).toBeUndefined();
  });

  it('the link completion keeps its own guards: a conflict race is a refusal, an invite is not consumed for a party who got a link or whose invite moved, the device defaults to the session\'s', async () => {
    // links.link answering 409 (a race with another link) is the uniform refusal, not a 500
    await staffer('yu', OHR, 'staff');
    const racy = mk({ links: { find: (...a) => links.find(...a), link: async () => { throw new DomainError('IDEMPOTENCY_CONFLICT', 'raced'); } } });
    const s = await racy.startLink({ partyId: people['yu']!.partyId, sessionId: people['yu']!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge }, NOW);
    expect((await racy.callback({ code: idp('idp-yu'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location).toBe(`${CONSOLE}#error=refused`);
    // an invite holder who got a live link after the start: refused BEFORE the invite is consumed
    const invite = async (email: string) => {
      await person(email, ['member']);
      await app.services.team.invite(OHR, people['rivka']!.partyId, { role: 'staff', email: `${email}@example.com` }, `key-${email}-invite`, NOW);
      return String(host.simulators.notify.sent.filter((n) => n.to === `${email}@example.com`).at(-1)!.data['inviteUrl']).split('token=')[1]!;
    };
    const t1 = await invite('zed');
    const a = await linkIn('zed', OHR, pair(), { inviteToken: t1 });
    await db.query("insert into org.staff (party_id, institution_id, role, active) values ($1, $2, 'staff', true)", [people['zed']!.partyId, NER]);
    await links.link(NER, 'idp-zed-ner', people['zed']!.partyId, SYSTEM, NOW);
    await db.query('update org.staff set active = false where party_id = $1', [people['zed']!.partyId]); // inactive elsewhere, so only the link guard stops the invite
    expect(frag(await cb({ code: idp('idp-zed'), state: (a.body as { state: string }).state }, cookieOf(a)))).toBe('error=refused');
    expect((await db.query('select 1 from org.staff_invite_acceptance a join org.staff_invite i on i.id = a.invite_id where i.token_hash = $1', [createHash('sha256').update(t1).digest('hex')])).rows).toHaveLength(0);
    // an invite that no longer belongs to this institution is neither accepted nor linked
    const t2 = await invite('abe');
    const b = await linkIn('abe', OHR, pair(), { inviteToken: t2 });
    await db.query('update org.staff_invite set institution_id = $1 where token_hash = $2', [NER, createHash('sha256').update(t2).digest('hex')]);
    expect(frag(await cb({ code: idp('idp-abe'), state: (b.body as { state: string }).state }, cookieOf(b)))).toBe('error=refused');
    expect((await db.query('select 1 from org.staff_invite_acceptance a join org.staff_invite i on i.id = a.invite_id where i.token_hash = $1', [createHash('sha256').update(t2).digest('hex')])).rows).toHaveLength(0);
    expect((await db.query('select 1 from org.staff where party_id = $1', [people['abe']!.partyId])).rows).toHaveLength(0);
    // the token's device is the one asked for, else the session's own
    const p1 = pair();
    const c = await linkIn('ron', NER, p1, { deviceId: 'web-explicit' });
    const out1 = await ex(frag(await cb({ code: idp('idp-ron'), state: (c.body as { state: string }).state }, cookieOf(c))).slice(5), p1.verifier);
    expect((await app.services.tokens.verifyAccess((out1.body as { tokens: { accessToken: string } }).tokens.accessToken)).deviceId).toBe('web-explicit');
    await staffer('ivy', NER, 'staff');
    const p2 = pair();
    const d = await linkIn('ivy', NER, p2);
    const out2 = await ex(frag(await cb({ code: idp('idp-ivy'), state: (d.body as { state: string }).state }, cookieOf(d))).slice(5), p2.verifier);
    expect((await app.services.tokens.verifyAccess((out2.body as { tokens: { accessToken: string } }).tokens.accessToken)).deviceId).toMatch(/^web-\+/);
  });
});

describe('uniformity, timing and opacity', () => {
  it('every refusal reason is byte-identical to the caller, reads the same rows and takes the same latency floor; the IdP is always called and never with a state it did not earn', async () => {
    await staffer('yan', OHR, 'staff', 'idp-yan');
    const sleeps: number[] = [];
    const idpCalls: { code: string; state: string }[] = [];
    const sim = host.simulators['org-idp'];
    const spy: OrgIdPPort = { startSso: (...a) => sim.startSso(...a), handleCallback: async (i) => { idpCalls.push(i); return sim.handleCallback(i); }, parseScimEvent: (...a) => sim.parseScimEvent(...a), listDirectory: (...a) => sim.listDirectory(...a) };
    const c = counting(db);
    const svc = mk({ db: c.db, port: () => spy, floorMs: 300, hr: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
    const begin = async () => { const s = await svc.startSignIn(OHR, { deviceId: 'd', challenge: pair().challenge }, NOW); return { state: s.body.state, cookie: s.setCookie.split(';')[0]! }; };
    const good = idp('idp-yan');
    const cases: Record<string, () => Promise<{ code?: string; state?: string; cookie?: string; now?: Date }>> = {
      malformed: async () => ({ code: good, state: 'short' }),
      unknown: async () => ({ code: good, state: rand43() }),
      unbound: async () => ({ ...(await begin()), code: good, cookie: undefined as never }),
      wrongCookie: async () => { const b = await begin(); return { ...b, code: good, cookie: `${b.cookie.split('=')[0]}=${'B'.repeat(43)}` }; },
      expired: async () => ({ ...(await begin()), code: good, now: at(SIGN_IN_TTL_MS) }),
      replayed: async () => { const b = await begin(); await svc.callback({ code: good, state: b.state }, b.cookie, NOW); return { ...b, code: good }; },
      badIdpCode: async () => ({ ...(await begin()), code: 'garbage' }),
      unlinked: async () => ({ ...(await begin()), code: idp('idp-stranger') }),
    };
    const seen = new Map<string, { out: string; reads: number }>();
    for (const [name, make] of Object.entries(cases)) {
      const q = await make();
      const reads0 = c.n.q;
      const calls0 = idpCalls.length;
      const sleeps0 = sleeps.length;
      const out = await svc.callback({ code: q.code, state: q.state }, q.cookie, q.now ?? NOW);
      seen.set(name, { out: JSON.stringify({ l: out.location, c: out.clear.replace(/^[^=]*/, '') }), reads: c.n.q - reads0 });
      expect(idpCalls.length - calls0, `${name} calls the IdP once`).toBe(1);
      expect(sleeps.length - sleeps0, `${name} waits for the floor`).toBe(1);
      expect(sleeps.at(-1)).toBe(300);
      if (q.state && !['replayed', 'badIdpCode', 'unlinked'].includes(name)) expect(idpCalls.at(-1)!.state, `${name} never hands the real state to the IdP`).not.toBe(q.state);
      expect(idpCalls.at(-1)!.code).not.toBe(q.code === 'garbage' ? '' : good);
    }
    expect(new Set([...seen.values()].map((v) => v.out)).size).toBe(1);
    expect(JSON.parse([...seen.values()][0]!.out).l).toBe(`${CONSOLE}#error=refused`);
    expect(new Set([...seen.values()].map((v) => v.reads)).size, JSON.stringify([...seen])).toBe(1);
    // a success takes the same floor
    const b = await begin();
    sleeps.length = 0;
    expect((await svc.callback({ code: good, state: b.state }, b.cookie, NOW)).location).toMatch(/#code=/);
    expect(sleeps).toEqual([300]);
  });

  it('an IdP outage after a good state is #error=unavailable; on a state that earned nothing it is the plain refusal', async () => {
    const sim = host.simulators['org-idp'];
    const down: OrgIdPPort = { startSso: (...a) => sim.startSso(...a), handleCallback: async () => { throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'down'); }, parseScimEvent: (...a) => sim.parseScimEvent(...a), listDirectory: (...a) => sim.listDirectory(...a) };
    const svc = mk({ port: () => down });
    const s = await svc.startSignIn(OHR, { deviceId: 'd', challenge: pair().challenge }, NOW);
    expect((await svc.callback({ code: 'x', state: rand43() }, undefined, NOW)).location).toBe(`${CONSOLE}#error=refused`);
    expect((await svc.callback({ code: 'x', state: s.body.state }, s.setCookie.split(';')[0], NOW)).location).toBe(`${CONSOLE}#error=unavailable`);
  });

  it('refusals are metered under a closed reason and nothing sensitive reaches the metric lines, the markers or the audit rows', async () => {
    lines.length = 0;
    const svc = mk();
    const run = async (code: string) => { const s = await svc.startSignIn(OHR, { deviceId: 'd', challenge: pair().challenge }, NOW); await svc.callback({ code, state: s.body.state }, s.setCookie.split(';')[0], NOW); return s.body.state; };
    await run('ok:idp-leak-subject:leak-email@example.com');
    const r = { body: { state: await run('garbage') } };
    await svc.callback({ code: 'x', state: r.body.state }, undefined, NOW);
    const wrong = await ex('z'.repeat(43), pair().verifier);
    await svc.exchange({ code: 'z'.repeat(43), verifier: pair().verifier }, NOW).catch(() => undefined);
    expect(wrong.status).toBe(401);
    const reasons = lines.map((l) => (JSON.parse(l) as { reason?: string; 'staff.sso_refused'?: number }).reason).filter(Boolean);
    expect(reasons).toEqual(expect.arrayContaining(['not_linked', 'idp_refused', 'state_unbound', 'exchange_unknown']));
    const text = lines.join('\n');
    for (const secret of ['leak-email', 'idp-leak-subject']) expect(text).not.toContain(secret);
    const stored = JSON.stringify((await db.query("select value, claim from ops.workflow_marker where kind like 'sso%'")).rows) + JSON.stringify((await db.query('select payload, reason from audit.entry')).rows);
    for (const secret of ['leak-email', 'idp-leak-subject', 'example.com', (r.body as { state: string }).state]) expect(stored).not.toContain(secret);
    expect(JSON.stringify(wrong.body)).not.toMatch(/verifier|code not|unknown|expired/i);
    expect(new DomainError('UNAUTHENTICATED', 'Sign-in refused').message).toBe((wrong.body as { detail?: string; title: string }).detail ?? (wrong.body as { title: string }).title);
  });
});

describe('device registration and the new-device alert (TST-AUTH-008, T-1121)', () => {
  const sink = () => app.services.passkeys.events;
  const alerts = (party: string) => sink().filter((e) => e.type === 'new_device_sign_in' && e.partyId === party);
  const devices = async (party: string) => (await app.services.identity.listDevices(party)).map((d) => d.deviceId).sort();
  const reach = async (inst: string, subject: string, deviceId: string, p = pair()) => {
    const start = await post(`/institutions/${inst}/sso/start`, { deviceId, challenge: p.challenge });
    const res = await cb({ code: idp(subject), state: (start.body as { state: string }).state }, cookieOf(start));
    return { p, code: frag(res).slice(5), res };
  };

  it('a first SSO sign-in on a new device writes the device row and emits exactly one new_device_sign_in; a repeat on it emits none; another device emits one more', async () => {
    const party = await staffer('dev1', OHR, 'staff', 'idp-dev1');
    const before = await devices(party);
    const a = await reach(OHR, 'idp-dev1', 'sso-laptop');
    expect(await devices(party)).toEqual(before); // the callback registers nothing
    expect(alerts(party)).toHaveLength(0);
    const out = await ex(a.code, a.p.verifier);
    expect(out.status).toBe(200);
    expect(await devices(party)).toEqual([...before, 'sso-laptop'].sort());
    expect(alerts(party)).toEqual([{ type: 'new_device_sign_in', partyId: party, deviceId: 'sso-laptop', at: NOW.toISOString() }]);
    const b = await reach(OHR, 'idp-dev1', 'sso-laptop');
    expect((await ex(b.code, b.p.verifier)).status).toBe(200);
    expect(alerts(party)).toHaveLength(1);
    const c = await reach(OHR, 'idp-dev1', 'sso-phone');
    expect((await ex(c.code, c.p.verifier)).status).toBe(200);
    expect(alerts(party).map((e) => (e as { deviceId: string }).deviceId)).toEqual(['sso-laptop', 'sso-phone']);
    // the token carries the registered device
    expect((await app.services.tokens.verifyAccess((out.body as { tokens: { accessToken: string } }).tokens.accessToken)).deviceId).toBe('sso-laptop');
  });

  it('a device the member already uses (passkey) raises no alert', async () => {
    const party = await staffer('dev2', OHR, 'staff', 'idp-dev2');
    const known = (await devices(party))[0]!;
    const r = await reach(OHR, 'idp-dev2', known);
    expect((await ex(r.code, r.p.verifier)).status).toBe(200);
    expect(alerts(party)).toHaveLength(0);
  });

  it('the event and the device row carry no state, code, verifier, token or IdP claim', async () => {
    const party = await staffer('dev3', OHR, 'staff', 'idp-dev3-secret');
    const r = await reach(OHR, 'idp-dev3-secret', 'sso-d3');
    const out = await ex(r.code, r.p.verifier);
    const tokens = (out.body as { tokens: { accessToken: string; refreshToken: string } }).tokens;
    const seen = JSON.stringify([alerts(party), await app.services.identity.listDevices(party)]);
    for (const secret of [r.code, r.p.verifier, r.p.challenge, tokens.accessToken, tokens.refreshToken, 'idp-dev3-secret', 'example.com', 'state', 'verifier']) expect(seen).not.toContain(secret);
    expect(Object.keys(alerts(party)[0]!).sort()).toEqual(['at', 'deviceId', 'partyId', 'type']);
  });

  it('the device is the one stored at start: a deviceId in the exchange request is ignored', async () => {
    const party = await staffer('dev4', OHR, 'staff', 'idp-dev4');
    const r = await reach(OHR, 'idp-dev4', 'sso-stored');
    const out = await post('/sso/exchange', { code: r.code, verifier: r.p.verifier, deviceId: 'sso-evil' });
    expect(out.status).toBe(200);
    expect(await devices(party)).toContain('sso-stored');
    expect(await devices(party)).not.toContain('sso-evil');
    expect(alerts(party).map((e) => (e as { deviceId: string }).deviceId)).toEqual(['sso-stored']);
    // the handler forwards only code and verifier; the service itself also ignores a stray field
    const r2 = await reach(OHR, 'idp-dev4', 'sso-stored-2');
    await mk().exchange({ code: r2.code, verifier: r2.p.verifier, deviceId: 'sso-evil' } as never, NOW);
    expect(await devices(party)).toContain('sso-stored-2');
    expect(await devices(party)).not.toContain('sso-evil');
    expect(alerts(party).map((e) => (e as { deviceId: string }).deviceId)).toEqual(['sso-stored', 'sso-stored-2']);
  });

  it('a link-mode sign-in registers the device too', async () => {
    const party = await staffer('dev5', NER, 'staff');
    const p = pair();
    const start = await linkIn('dev5', NER, p, { deviceId: 'sso-link-dev' });
    const res = await cb({ code: idp('idp-dev5'), state: (start.body as { state: string }).state }, cookieOf(start));
    expect((await ex(frag(res).slice(5), p.verifier)).status).toBe(200);
    expect(alerts(party).map((e) => (e as { deviceId: string }).deviceId)).toEqual(['sso-link-dev']);
  });

  it('every refusal writes no device row and emits nothing: the callback causes and the exchange 401s', async () => {
    const party = await staffer('dev6', OHR, 'staff', 'idp-dev6');
    const stranger = await staffer('dev6b', OHR, 'staff');
    const snap = async () => JSON.stringify([sink().length, await devices(party), await devices(stranger)]);
    const base = await snap();
    const svc = mk();
    const begin = async (deviceId = 'sso-refused') => { const p = pair(); const s = await svc.startSignIn(OHR, { deviceId, challenge: p.challenge }, NOW); return { p, state: s.body.state, cookie: s.setCookie.split(';')[0]! }; };
    const good = idp('idp-dev6');
    const callbacks: Array<() => Promise<unknown>> = [
      async () => svc.callback({ code: good, state: 'short' }, undefined, NOW),
      async () => svc.callback({ code: good, state: rand43() }, undefined, NOW),
      async () => { const b = await begin(); return svc.callback({ code: good, state: b.state }, undefined, NOW); },
      async () => { const b = await begin(); return svc.callback({ code: good, state: b.state }, `${b.cookie.split('=')[0]}=${'B'.repeat(43)}`, NOW); },
      async () => { const b = await begin(); return svc.callback({ code: good, state: b.state }, b.cookie, at(SIGN_IN_TTL_MS)); },
      async () => { const b = await begin(); await svc.callback({ code: 'garbage', state: b.state }, b.cookie, NOW); return svc.callback({ code: good, state: b.state }, b.cookie, NOW); },
      async () => { const b = await begin(); return svc.callback({ code: 'garbage', state: b.state }, b.cookie, NOW); },
      async () => { const b = await begin(); return svc.callback({ code: idp('idp-stranger'), state: b.state }, b.cookie, NOW); },
      async () => { const b = await begin(); return svc.callback({ code: good, state: b.state, error: 'access_denied' }, b.cookie, NOW); },
      async () => { const b = await begin(); return svc.callback({ state: b.state }, b.cookie, NOW); },
    ];
    for (const run of callbacks) await run();
    expect(await snap()).toBe(base);
    // exchange refusals: unknown, expired, wrong verifier (and exhaustion), stale, replayed
    const mint = async (deviceId = 'sso-refused') => { const b = await begin(deviceId); const out = await svc.callback({ code: good, state: b.state }, b.cookie, NOW); return { p: b.p, code: out.location.split('#code=')[1]! }; };
    await expect(svc.exchange({ code: 'z'.repeat(43), verifier: pair().verifier }, NOW)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const e = await mint();
    await expect(svc.exchange({ code: e.code, verifier: e.p.verifier }, at(CODE_TTL_MS))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const w = await mint();
    for (let i = 0; i < 5; i += 1) await expect(svc.exchange({ code: w.code, verifier: pair().verifier }, NOW)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(svc.exchange({ code: w.code, verifier: w.p.verifier }, NOW)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const s = await mint();
    await app.services.deprovision!.remove(OHR, 'idp-dev6', 'evt-dev6', NOW, { reason: 'test' });
    await expect(svc.exchange({ code: s.code, verifier: s.p.verifier }, NOW)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await snap()).toBe(base);
  });

  it('a replayed or double-redeemed code emits exactly once', async () => {
    const party = await staffer('dev7', OHR, 'staff', 'idp-dev7');
    const r = await reach(OHR, 'idp-dev7', 'sso-race');
    const both = await Promise.all([ex(r.code, r.p.verifier), ex(r.code, r.p.verifier)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 401]);
    expect((await ex(r.code, r.p.verifier)).status).toBe(401);
    expect(alerts(party)).toHaveLength(1);
  });

  it('a failing device write fails the exchange closed: no token, no alert, the claim is released, the retry redeems once, then the code is dead', async () => {
    const party = await staffer('dev8', OHR, 'staff', 'idp-dev8');
    let fail = true;
    const issued: string[] = [];
    const svc = mk({
      identity: { findSession: (i) => app.services.identity.findSession(i), findUser: (i) => app.services.identity.findUser(i), upsertDevice: async (d) => { if (fail) { fail = false; throw new Error('device store down'); } return app.services.identity.upsertDevice(d); } },
      tokens: { issue: async (i) => { issued.push(i.deviceId); return app.services.tokens.issue(i); } },
    });
    const p = pair();
    const s = await svc.startSignIn(OHR, { deviceId: 'sso-flaky', challenge: p.challenge }, NOW);
    const code = (await svc.callback({ code: idp('idp-dev8'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location.split('#code=')[1]!;
    const released = await markerCount('sso_code_released');
    await expect(svc.exchange({ code, verifier: p.verifier }, NOW)).rejects.toThrow('device store down');
    expect(issued).toEqual([]);
    expect(alerts(party)).toHaveLength(0);
    expect(await devices(party)).not.toContain('sso-flaky');
    expect(await markerCount('sso_code_released')).toBe(released + 1);
    expect((await svc.exchange({ code, verifier: p.verifier }, NOW)).institutionId).toBe(OHR);
    expect(issued).toEqual(['sso-flaky']);
    expect(alerts(party)).toHaveLength(1);
    await expect(svc.exchange({ code, verifier: p.verifier }, NOW)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(alerts(party)).toHaveLength(1);
  });

  it('a token failure after the device write does not double the alert on the retry', async () => {
    const party = await staffer('dev9', OHR, 'staff', 'idp-dev9');
    let fail = true;
    const svc = mk({ tokens: { issue: async (i) => { if (fail) { fail = false; throw new Error('token store down'); } return app.services.tokens.issue(i); } } });
    const p = pair();
    const s = await svc.startSignIn(OHR, { deviceId: 'sso-t', challenge: p.challenge }, NOW);
    const code = (await svc.callback({ code: idp('idp-dev9'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location.split('#code=')[1]!;
    await expect(svc.exchange({ code, verifier: p.verifier }, NOW)).rejects.toThrow('token store down');
    await svc.exchange({ code, verifier: p.verifier }, NOW);
    expect(alerts(party)).toHaveLength(1);
    expect(await devices(party)).toContain('sso-t');
  });

  it('the dark flag stops it all: with the flag off the exchange registers nothing', async () => {
    const party = await staffer('dev10', OHR, 'staff', 'idp-dev10');
    const r = await reach(OHR, 'idp-dev10', 'sso-dark');
    flagState.on = false;
    expect((await ex(r.code, r.p.verifier)).status).toBe(404);
    flagState.on = true;
    expect(alerts(party)).toHaveLength(0);
    expect(await devices(party)).not.toContain('sso-dark');
  });
});

const rand43 = () => randomBytes(32).toString('base64url');

describe('invite path: accept and link are one transaction, the subject is checked first (TST-AUTH-008, T-1122)', () => {
  let n = 0;
  /** A signed-in non-staff person holding a pending staff invite, and a link start that carries it. */
  async function holder(role: 'staff' | 'finance' = 'staff') {
    const name = `inv${n++}`;
    await person(name, ['member']);
    await app.services.team.invite(OHR, people['rivka']!.partyId, { role, email: `${name}@example.com` }, `key-${name}-invite-t1122`, NOW);
    const token = String(host.simulators.notify.sent.filter((m) => m.to === `${name}@example.com`).at(-1)!.data['inviteUrl']).split('token=')[1]!;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const party = people[name]!.partyId;
    const start = async (p = pair()) => {
      const s = await linkIn(name, OHR, p, { inviteToken: token });
      return { p, state: (s.body as { state: string }).state, cookie: cookieOf(s) };
    };
    const accepted = async () => (await db.query('select 1 from org.staff_invite_acceptance a join org.staff_invite i on i.id = a.invite_id where i.token_hash = $1', [tokenHash])).rows.length;
    const staffRows = async () => (await db.query('select 1 from org.staff where party_id = $1', [party])).rows.length;
    const audits = async () => (await db.query("select 1 from audit.entry where subject = $1 and action like 'institution.staff.%'", [party])).rows.length;
    return { name, token, party, start, accepted, staffRows, audits };
  }
  /** The IdP identity the callback sees, with the subject replaced (a control character cannot travel in a simulator code). */
  async function withSubject<T>(subject: string, fn: () => Promise<T>): Promise<T> {
    const sim = host.simulators['org-idp'];
    const orig = sim.handleCallback.bind(sim);
    sim.handleCallback = async (i) => ({ ...(await orig(i)), subject });
    try {
      return await fn();
    } finally {
      sim.handleCallback = orig;
    }
  }
  const nothingWritten = async (h: Awaited<ReturnType<typeof holder>>) => {
    expect(await h.accepted()).toBe(0);
    expect(await h.staffRows()).toBe(0);
    expect(await h.audits()).toBe(0);
    expect(await linkRows(h.party)).toBe(0);
  };
  const refusalShape = async () => {
    const r = await signIn(OHR, idp('idp-nobody-t1122'));
    return shape(r.res);
  };

  it('a link that conflicts after a valid invite rolls back: invite pending, no staff row, no acceptance, no audit, the uniform refusal; the invite still works afterwards', async () => {
    await staffer('t1122-owner', OHR, 'staff', 'idp-t1122-taken');
    const h = await holder();
    const s = await h.start();
    const res = await cb({ code: idp('idp-t1122-taken'), state: s.state }, s.cookie);
    expect(frag(res)).toBe('error=refused');
    expect(shape(res)).toBe(await refusalShape());
    await nothingWritten(h);
    // the invite is still pending in the team read, and a fresh start with a free subject finishes through it
    expect((await app.services.team.read(OHR, NOW)).invites.some((i) => i.role === 'staff' && !i.acceptedAt)).toBe(true);
    const s2 = await h.start(s.p);
    const ok = await cb({ code: idp('idp-t1122-free'), state: s2.state }, s2.cookie);
    expect(frag(ok)).toMatch(/^code=/);
    expect(await h.accepted()).toBe(1);
    expect(await h.staffRows()).toBe(1);
    expect(await linkRows(h.party)).toBe(1);
    expect((await ex(frag(ok).slice(5), s.p.verifier)).status).toBe(200);
  });

  it.each([
    ['a control character', 'idp\u0001x'],
    ['a newline', 'a\nb'],
    ['DEL', 'a\u007Fb'],
    ['a blank subject', '   '],
    ['an empty subject', ''],
    ['256 characters', 'x'.repeat(256)],
  ])('%s in the IdP subject is the uniform refusal and the invite is untouched', async (_n, subject) => {
    const h = await holder();
    const s = await h.start();
    const res = await withSubject(subject, () => cb({ code: idp('idp-t1122-shape'), state: s.state }, s.cookie));
    expect(frag(res)).toBe('error=refused');
    expect(shape(res)).toBe(await refusalShape());
    await nothingWritten(h);
    // and the invite is still usable
    const s2 = await h.start(s.p);
    expect(frag(await cb({ code: idp(`idp-t1122-ok-${n}`), state: s2.state }, s2.cookie))).toMatch(/^code=/);
    expect(await h.accepted()).toBe(1);
  });

  it('a 255-character subject is accepted (the boundary)', async () => {
    const h = await holder();
    const s = await h.start();
    const res = await withSubject('y'.repeat(255), () => cb({ code: idp('idp-t1122-edge'), state: s.state }, s.cookie));
    expect(frag(res)).toMatch(/^code=/);
    expect(await linkRows(h.party)).toBe(1);
  });

  it('a bad subject for an active staff member (no invite) is the uniform refusal too, not unavailable', async () => {
    await staffer('t1122-staff', OHR, 'staff');
    const s = await linkIn('t1122-staff', OHR);
    const res = await withSubject('a\u0000b', () => cb({ code: idp('idp-t1122-s'), state: (s.body as { state: string }).state }, cookieOf(s)));
    expect(shape(res)).toBe(await refusalShape());
    expect(await linkRows(people['t1122-staff']!.partyId)).toBe(0);
  });

  it('a sign-in whose IdP subject has a control character (NUL included) is the uniform refusal, not unavailable', async () => {
    for (const subject of ['a\u0000b', 'a\u0001b']) {
      const start = await startIn(OHR);
      const res = await withSubject(subject, () => cb({ code: idp('idp-t1122-signin'), state: (start.body as { state: string }).state }, cookieOf(start)));
      expect(shape(res)).toBe(await refusalShape());
    }
  });

  it('a failure inside the transaction after the accept rolls everything back, and answers unavailable for every caller alike', async () => {
    for (const fail of [() => new Error('connection lost'), () => Object.assign(new Error('serialization'), { code: '40001' })]) {
      const h = await holder('finance');
      const boom = mk({ links: { find: (...a) => links.find(...a), link: async (...a) => { await links.link(...a); throw fail(); } } });
      const s = await boom.startLink({ partyId: h.party, sessionId: people[h.name]!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge, inviteToken: h.token }, NOW);
      expect((await boom.callback({ code: idp('idp-t1122-boom'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location).toBe(`${CONSOLE}#error=unavailable`);
      await nothingWritten(h);
      expect((await db.query("select 1 from ops.approval_request where kind = 'staff_grant' and subject like $1", [`%${h.party}%`])).rows).toHaveLength(0);
    }
  });

  it('a NOT_FOUND from the accept or the link is the uniform refusal; a data exception or a lost connection is unavailable (only the integrity class 23 is refused)', async () => {
    const run = async (err: () => Error) => {
      const h = await holder();
      const svc = mk({ links: { find: (...a) => links.find(...a), link: async (...a) => { await links.link(...a); throw err(); } } });
      const s = await svc.startLink({ partyId: h.party, sessionId: people[h.name]!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge, inviteToken: h.token }, NOW);
      const out = (await svc.callback({ code: idp('idp-t1122-nf'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location;
      await nothingWritten(h);
      return out;
    };
    expect(await run(() => new DomainError('NOT_FOUND', 'gone'))).toBe(`${CONSOLE}#error=refused`);
    expect(await run(() => new DomainError('VALIDATION_FAILED', 'bad'))).toBe(`${CONSOLE}#error=refused`);
    expect(await run(() => Object.assign(new Error('invalid text'), { code: '22P02' }))).toBe(`${CONSOLE}#error=unavailable`);
    expect(await run(() => Object.assign(new Error('shutdown'), { code: '57P01' }))).toBe(`${CONSOLE}#error=unavailable`);
  });

  it('an integrity violation (FK, check, unique) inside the transaction is the uniform refusal, rolled back', async () => {
    const h = await holder();
    const bad = mk({ links: { find: (...a) => links.find(...a), link: async (...a) => { await links.link(...a); throw Object.assign(new Error('fk'), { code: '23503' }); } } });
    const s = await bad.startLink({ partyId: h.party, sessionId: people[h.name]!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge, inviteToken: h.token }, NOW);
    expect((await bad.callback({ code: idp('idp-t1122-fk'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location).toBe(`${CONSOLE}#error=refused`);
    await nothingWritten(h);
  });

  it('the success path is unchanged: one staff row, one link, the invite consumed, the audit rows, the role, and a token on exchange', async () => {
    const h = await holder();
    const s = await h.start();
    const res = await cb({ code: idp('idp-t1122-good'), state: s.state }, s.cookie);
    expect(frag(res)).toMatch(/^code=/);
    expect(await h.accepted()).toBe(1);
    expect(await h.staffRows()).toBe(1);
    expect(await linkRows(h.party)).toBe(1);
    const actions = (await db.query<{ action: string }>("select action from audit.entry where subject = $1 order by seq", [h.party])).rows.map((r) => r.action);
    expect(actions).toEqual(['institution.staff.grant', 'institution.staff.idp_link']);
    expect((await app.services.identity.findUser(h.party))?.roles).toContain('org_staff');
    const done = await ex(frag(res).slice(5), s.p.verifier);
    expect(done.status).toBe(200);
    expect((await app.services.tokens.verifyAccess((done.body as { tokens: { accessToken: string } }).tokens.accessToken)).roles).toContain('org_staff');
  });

  it('a finance invite through SSO still opens its grant, after the commit', async () => {
    const h = await holder('finance');
    const s = await h.start();
    expect(frag(await cb({ code: idp('idp-t1122-fin'), state: s.state }, s.cookie))).toMatch(/^code=/);
    const actions = (await db.query<{ action: string }>('select action from audit.entry where subject = $1', [h.party])).rows.map((r) => r.action);
    expect(actions).toContain('institution.staff.propose');
    expect((await app.services.team.read(OHR, NOW)).pendingGrants.some((g) => (g.payload as { partyId?: string }).partyId === h.party)).toBe(true);
  });

  it('two callbacks for one invite (two states, two parties): exactly one wins, the other is refused, no half state', async () => {
    const a = await holder();
    const b = await holder();
    const sa = await a.start();
    // b holds a's token: both parties start with the one invite
    const sb = await (async () => {
      const s = await linkIn(b.name, OHR, pair(), { inviteToken: a.token });
      return { state: (s.body as { state: string }).state, cookie: cookieOf(s) };
    })();
    const [ra, rb] = await Promise.all([cb({ code: idp('idp-t1122-ca'), state: sa.state }, sa.cookie), cb({ code: idp('idp-t1122-cb'), state: sb.state }, sb.cookie)]);
    const outcomes = [frag(ra), frag(rb)];
    expect(outcomes.filter((f) => f.startsWith('code=')).length).toBe(1);
    expect(outcomes.filter((f) => f === 'error=refused').length).toBe(1);
    expect(await a.accepted()).toBe(1);
    const winner = frag(ra).startsWith('code=') ? a : b;
    const loser = winner === a ? b : a;
    expect(await winner.staffRows()).toBe(1);
    expect(await linkRows(winner.party)).toBe(1);
    expect(await loser.staffRows()).toBe(0);
    expect(await linkRows(loser.party)).toBe(0);
    expect(await loser.audits()).toBe(0);
  });

  it('two states of the same party for one invite: one staff row, one link, never two of anything', async () => {
    const h = await holder();
    const s1 = await h.start();
    const s2 = await h.start();
    const rs = await Promise.all([cb({ code: idp('idp-t1122-same1'), state: s1.state }, s1.cookie), cb({ code: idp('idp-t1122-same2'), state: s2.state }, s2.cookie)]);
    expect(rs.map(frag).filter((f) => f.startsWith('code=')).length).toBeGreaterThanOrEqual(1);
    expect(await h.accepted()).toBe(1);
    expect(await h.staffRows()).toBe(1);
    expect(await linkRows(h.party)).toBe(1);
  });

  it('the #422 properties hold: a leaked state without its cookie cannot burn the state or the invite, and the state claim is taken only after the cookie check', async () => {
    const h = await holder();
    const s = await h.start();
    expect(frag(await cb({ code: idp('idp-t1122-leak'), state: s.state }))).toBe('error=refused');
    await nothingWritten(h);
    expect(frag(await cb({ code: idp('idp-t1122-leak'), state: s.state }, s.cookie))).toMatch(/^code=/);
    // a replay of the claimed state is refused and writes nothing more
    expect(frag(await cb({ code: idp('idp-t1122-leak'), state: s.state }, s.cookie))).toBe('error=refused');
    expect(await h.staffRows()).toBe(1);
  });
});

describe('mutation gaps the reviewers proved survive (TST-AUTH-008, T-1124)', () => {
  let k = 0;
  const events = () => app.services.passkeys.events;
  const deviceRows = async (party: string) => app.services.identity.listDevices(party);
  /** A sign-in that reached the exchange: the code and the verifier, for a linked staff member of OHR. */
  async function minted(deviceId = 'web-t1124') {
    const name = `t1124-${k++}`;
    const party = await staffer(name, OHR, 'staff', `idp-${name}`);
    const p = pair();
    const start = await post(`/institutions/${OHR}/sso/start`, { deviceId, challenge: p.challenge });
    const res = await cb({ code: idp(`idp-${name}`), state: (start.body as { state: string }).state }, cookieOf(start));
    return { name, party, p, code: frag(res).slice(5), deviceId };
  }
  const spyTx = () => {
    const n = { tx: 0 };
    return { n, db: { query: (t: string, p?: readonly unknown[]) => db.query(t, p), transaction: ((fn: Parameters<Database['transaction']>[0]) => { n.tx += 1; return db.transaction(fn); }) as Database['transaction'] } as Database };
  };
  const uniform = `${CONSOLE}#error=refused`;

  it('O24: a user closed after the callback is refused at the exchange: the uniform 401, no token, no device row, no alert; the code is not burnt by it', async () => {
    const m = await minted('sso-o24');
    const before = events().length;
    await app.services.identity.setUserStatus(m.party, 'closed');
    const res = await ex(m.code, m.p.verifier);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('tokens');
    expect((await deviceRows(m.party)).map((d) => d.deviceId)).not.toContain('sso-o24');
    expect(events().length).toBe(before);
    // the refusal is metered as the stale case, and a user who is not closed is let through (the guard is the status, not the call)
    lines.length = 0;
    await expect(mk().exchange({ code: m.code, verifier: m.p.verifier }, NOW)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(lines.map((l) => (JSON.parse(l) as { reason?: string }).reason)).toContain('exchange_stale');
    await app.services.identity.setUserStatus(m.party, 'active');
    expect((await ex(m.code, m.p.verifier)).status).toBe(200);
  });

  it('O26: at link completion the session must belong to the party who started: a live session of ANOTHER party links nothing', async () => {
    const a = await staffer('t1124-o26a', OHR, 'staff');
    await staffer('t1124-o26b', OHR, 'staff');
    const svc = mk();
    // the start is handed a live session that is not a's (the handler never does; the state is the proof the callback re-checks)
    const s = await svc.startLink({ partyId: a, sessionId: people['t1124-o26b']!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge }, NOW);
    expect((await svc.callback({ code: idp('idp-t1124-o26'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location).toBe(uniform);
    expect(await linkRows(a)).toBe(0);
    expect(await links.find(OHR, 'idp-t1124-o26')).toBeUndefined();
    // the same start with the party's own session links (so the refusal above is the session, not the setup)
    const ok = await svc.startLink({ partyId: a, sessionId: people['t1124-o26a']!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge }, NOW);
    expect((await svc.callback({ code: idp('idp-t1124-o26'), state: ok.body.state }, ok.setCookie.split(';')[0], NOW)).location).toMatch(/#code=/);
    expect(await linkRows(a)).toBe(1);
  });

  it('O27: a user closed between the link start and the callback links nothing, and no code is made', async () => {
    const party = await staffer('t1124-o27', OHR, 'staff');
    const s = await linkIn('t1124-o27', OHR);
    await app.services.identity.setUserStatus(party, 'closed');
    const codes = await markerCount('sso_code');
    expect(frag(await cb({ code: idp('idp-t1124-o27'), state: (s.body as { state: string }).state }, cookieOf(s)))).toBe('error=refused');
    expect(await linkRows(party)).toBe(0);
    expect(await links.find(OHR, 'idp-t1124-o27')).toBeUndefined();
    expect(await markerCount('sso_code')).toBe(codes);
  });

  it('O30: link completion does not swallow what it cannot explain: a failing session or user read is `unavailable` (metered `internal`), never the refusal, and links nothing', async () => {
    for (const which of ['findSession', 'findUser'] as const) {
      const party = await staffer(`t1124-o30-${which}`, OHR, 'staff');
      const id = app.services.identity;
      const svc = mk({ identity: { findSession: which === 'findSession' ? async () => { throw new Error('identity store down'); } : (i) => id.findSession(i), findUser: which === 'findUser' ? async () => { throw new Error('identity store down'); } : (i) => id.findUser(i), upsertDevice: (d) => id.upsertDevice(d) } });
      const s = await svc.startLink({ partyId: party, sessionId: people[`t1124-o30-${which}`]!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge }, NOW);
      lines.length = 0;
      expect((await svc.callback({ code: idp(`idp-t1124-o30-${which}`), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location, which).toBe(`${CONSOLE}#error=unavailable`);
      expect(lines.map((l) => (JSON.parse(l) as { reason?: string }).reason)).toContain('internal');
      expect(await linkRows(party)).toBe(0);
    }
  });

  it('A01: with no org-idp binding the four operations answer FEATURE_OFF even with the flag on and both URLs set, and store nothing', async () => {
    const noIdp = new SimulatorHost();
    (noIdp.registry as unknown as { bindings: Map<string, unknown> }).bindings.delete('org-idp@IL');
    expect(noIdp.registry.bindingFor('org-idp', 'IL')).toBeUndefined();
    expect(host.registry.bindingFor('org-idp', 'IL')).toBeDefined();
    const bare = createApp({ db, registry: noIdp.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags, orgIdp: { orgs: ORGS, consoleUrl: CONSOLE, callbackUrl: CALLBACK, callbackFloorMs: 0 } });
    const token = (await bare.services.tokens.issue({ partyId: people['rivka']!.partyId, deviceId: 'web-a01', roles: ['member', 'org_admin'] })).accessToken;
    const p = pair();
    const before = await allMarkers();
    const call = (method: string, url: string, body: unknown, headers: Record<string, string> = {}) => dispatch(bare, { method, url: `/v1${url}`, headers, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
    const rs = [
      await call('POST', `/institutions/${OHR}/sso/start`, { deviceId: 'web-a01', challenge: p.challenge }),
      await call('POST', `/institutions/${OHR}/sso/link/start`, { challenge: p.challenge }, { authorization: `Bearer ${token}`, 'x-step-up': 'su_x' }),
      await call('GET', `/sso/callback?${new URLSearchParams({ code: idp('idp-a01'), state: rand43() })}`, undefined),
      await call('POST', '/sso/exchange', { code: 'c'.repeat(43), verifier: p.verifier }),
    ];
    for (const r of rs) {
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ code: 'FEATURE_OFF' });
      expect(r.headers?.['set-cookie']).toBeUndefined();
      expect(r.headers?.['location']).toBeUndefined();
    }
    expect(await allMarkers()).toBe(before);
    // the same four on the bound app are alive, so the answers above are the missing binding and nothing else
    expect((await startIn(OHR, p)).status).toBe(200);
  });

  it('S17: a subject already linked to someone else is refused BEFORE any transaction opens (the unique index would refuse it later with the same answer)', async () => {
    await staffer('t1124-s17owner', OHR, 'staff', 'idp-t1124-s17');
    const party = await staffer('t1124-s17', OHR, 'staff');
    const spy = spyTx();
    const svc = mk({ db: spy.db });
    const s = await svc.startLink({ partyId: party, sessionId: people['t1124-s17']!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge }, NOW);
    expect((await svc.callback({ code: idp('idp-t1124-s17'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location).toBe(uniform);
    expect(spy.n.tx).toBe(0);
    expect(await linkRows(party)).toBe(0);
    expect(await links.find(OHR, 'idp-t1124-s17')).toBe(people['t1124-s17owner']!.partyId);
  });

  it('S18: a party who got a live link after the start is refused BEFORE any transaction opens; a clean link opens exactly one', async () => {
    const party = await staffer('t1124-s18', OHR, 'staff');
    const spy = spyTx();
    const svc = mk({ db: spy.db });
    const s = await svc.startLink({ partyId: party, sessionId: people['t1124-s18']!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge }, NOW);
    await links.link(OHR, 'idp-t1124-s18-other', party, SYSTEM, NOW);
    expect((await svc.callback({ code: idp('idp-t1124-s18'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location).toBe(uniform);
    expect(spy.n.tx).toBe(0);
    expect(await links.find(OHR, 'idp-t1124-s18')).toBeUndefined();
    const clean = await staffer('t1124-s18b', OHR, 'staff');
    const s2 = await svc.startLink({ partyId: clean, sessionId: people['t1124-s18b']!.sessionId, deviceId: 'web' }, OHR, { challenge: pair().challenge }, NOW);
    expect((await svc.callback({ code: idp('idp-t1124-s18b'), state: s2.body.state }, s2.setCookie.split(';')[0], NOW)).location).toMatch(/#code=/);
    expect(spy.n.tx).toBe(1);
  });

  it('T14: an invite is pending until its expiry INSTANT: a link start at expires_at is the one NOT_FOUND, one millisecond earlier it starts', async () => {
    await person('t1124-t14', ['member']);
    await app.services.team.invite(OHR, people['rivka']!.partyId, { role: 'staff', email: 't1124-t14@example.com' }, 'key-t1124-t14-invite', NOW);
    const token = String(host.simulators.notify.sent.filter((n) => n.to === 't1124-t14@example.com').at(-1)!.data['inviteUrl']).split('token=')[1]!;
    const expires = (await db.query<{ expires_at: Date }>('select expires_at from org.staff_invite where token_hash = $1', [createHash('sha256').update(token).digest('hex')])).rows[0]!.expires_at;
    const principal = { partyId: people['t1124-t14']!.partyId, sessionId: people['t1124-t14']!.sessionId, deviceId: 'web' };
    const svc = mk();
    await expect(svc.startLink(principal, OHR, { challenge: pair().challenge, inviteToken: token }, new Date(expires.getTime()))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.startLink(principal, OHR, { challenge: pair().challenge, inviteToken: token }, new Date(expires.getTime() + 1))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await svc.startLink(principal, OHR, { challenge: pair().challenge, inviteToken: token }, new Date(expires.getTime() - 1))).body.state).toHaveLength(43);
  });

  it('M16: the device row of a first SSO sign-in carries firstSeenAt = lastSeenAt = the exchange time; a later sign-in moves lastSeenAt only', async () => {
    const m = await minted('sso-m16');
    expect((await ex(m.code, m.p.verifier)).status).toBe(200);
    const row = () => deviceRows(m.party).then((rows) => rows.find((d) => d.deviceId === 'sso-m16'));
    expect(await row()).toMatchObject({ partyId: m.party, firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString() });
    const later = at(60_000);
    const p = pair();
    const start = await post(`/institutions/${OHR}/sso/start`, { deviceId: 'sso-m16', challenge: p.challenge });
    const res = await cb({ code: idp(`idp-${m.name}`), state: (start.body as { state: string }).state }, cookieOf(start), later);
    expect((await ex(frag(res).slice(5), p.verifier, later)).status).toBe(200);
    expect(await row()).toMatchObject({ firstSeenAt: NOW.toISOString(), lastSeenAt: later.toISOString() });
  });

  it('M29 (KNOWN GAP, no durable outbox yet): when the event sink throws AFTER the device write, the exchange fails and releases the claim, the retry succeeds, and the alert is LOST', async () => {
    // Pinned as it is today. When an outbox lands, flip DELIVERED_AFTER_RETRY to 1 and rename this test: the alert must then survive the retry.
    const DELIVERED_AFTER_RETRY = 0;
    const party = await staffer('t1124-m29', OHR, 'staff', 'idp-t1124-m29');
    const delivered: AuthEvent[] = [];
    let fail = true;
    const svc = mk({ events: { push: (...items: AuthEvent[]) => { if (fail) { fail = false; throw new Error('event sink down'); } delivered.push(...items); return delivered.length; } } });
    const p = pair();
    const s = await svc.startSignIn(OHR, { deviceId: 'sso-m29', challenge: p.challenge }, NOW);
    const code = (await svc.callback({ code: idp('idp-t1124-m29'), state: s.body.state }, s.setCookie.split(';')[0], NOW)).location.split('#code=')[1]!;
    const released = await markerCount('sso_code_released');
    await expect(svc.exchange({ code, verifier: p.verifier }, NOW)).rejects.toThrow('event sink down');
    expect(await markerCount('sso_code_released')).toBe(released + 1);
    expect((await deviceRows(party)).map((d) => d.deviceId)).toContain('sso-m29'); // the device write was not rolled back
    expect((await svc.exchange({ code, verifier: p.verifier }, NOW)).institutionId).toBe(OHR); // the retry redeems
    expect(delivered).toHaveLength(DELIVERED_AFTER_RETRY);
    await expect(svc.exchange({ code, verifier: p.verifier }, NOW)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
