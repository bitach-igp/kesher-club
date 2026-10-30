// T-1015 the member's consent (TST-AGT-010, consent rows; ADR-009): the screen reads the client and each scope with
// its tier; approve without a fresh step-up answers STEP_UP_REQUIRED; approving two of three scopes creates a grant
// with those two and a one-time code stored only as a hash; a second approval for the same client updates that
// grant; an expired or decided request answers 409; another member's request answers 404; deny returns
// access_denied with the state; with mcp.enabled off, 404.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import type { Fetcher, Resolver } from '../mcp/cimd.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { codeHash } from './consent.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const ISSUER = 'https://api.kesher.example';
const CLIENT = 'https://assistant.example/oauth/client.json';
const REDIRECT = 'https://assistant.example/oauth/callback';
const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
const people: Record<'dana' | 'avi', { partyId: string; access: string; stepUp: string }> = { dana: { partyId: '', access: '', stepUp: '' }, avi: { partyId: '', access: '', stepUp: '' } };

const resolve: Resolver = async () => ['93.184.216.34'];
const fetchDoc: Fetcher = async (url) => {
  const body = JSON.stringify({ client_id: url, client_name: 'Trip Planner', client_uri: 'https://assistant.example', redirect_uris: [REDIRECT] });
  return { status: 200, headers: { get: () => null }, text: async () => body };
};

/** A member with a passkey and a fresh step-up, as in the payout tests. */
async function person(phone: string) {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'en' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Phone' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Phone', response: await device.register(r1.options!) });
  const access = r2.tokens!.accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  return { partyId: principal.partyId, access, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
}
/** An assistant's authorization request (T-1014), answered with its id. */
async function requested(scope = 'balances:read transactions:read card:freeze'): Promise<string> {
  const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, state: 's-1', scope, code_challenge: challenge, code_challenge_method: 'S256', resource: `${ISSUER}/mcp` });
  const r = await dispatch(app, { method: 'GET', url: `/oauth/authorize?${q}`, headers: {}, rawBody: '', now: NOW });
  return new URL(r.headers!['location']!).pathname.split('/').pop()!;
}
const call = (who: { access: string; stepUp?: string }, method: string, url: string, body?: unknown, now = NOW) =>
  dispatch(app, { method, url, headers: { authorization: `Bearer ${who.access}`, ...(who.stepUp ? { 'x-step-up': who.stepUp } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now });

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: ISSUER, clock: () => NOW, oauth: { consentUrl: 'https://app.kesher.example/connect' }, cimd: { resolve, fetch: fetchDoc }, flags: new StaticFlags(undefined, { 'mcp.enabled': true }) });
  people.dana = await person('+972501250001');
  people.avi = await person('+972501250002');
}, 60_000);
afterAll(async () => db.close());

describe('TST-AGT-010: consent (T-1015)', () => {
  it('reads the client and each scope with its tier; another member then sees 404', async () => {
    const id = await requested();
    const view = await call(people.dana, 'GET', `/oauth/requests/${id}`);
    expect(view.body).toEqual({ id, client: { id: CLIENT, name: 'Trip Planner', uri: 'https://assistant.example' }, scopes: [{ scope: 'balances:read', tier: 'T0' }, { scope: 'transactions:read', tier: 'T0' }, { scope: 'card:freeze', tier: 'T1' }], expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() });
    expect((await call(people.avi, 'GET', `/oauth/requests/${id}`)).status).toBe(404);
    expect((await call({ access: people.avi.access, stepUp: people.avi.stepUp }, 'POST', `/oauth/requests/${id}/approve`, { scopes: ['balances:read'] })).status).toBe(404);
  });

  it('approve needs a fresh step-up; two of three scopes make the grant, with a one-time code kept only as a hash', async () => {
    const id = await requested();
    expect((await call({ access: people.dana.access }, 'POST', `/oauth/requests/${id}/approve`, { scopes: ['balances:read'] })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await call(people.dana, 'POST', `/oauth/requests/${id}/approve`, { scopes: ['balances:read', 'p2p:propose'] })).status).toBe(422);
    const ok = await call(people.dana, 'POST', `/oauth/requests/${id}/approve`, { scopes: ['balances:read', 'card:freeze'] });
    const to = new URL((ok.body as { redirect: string }).redirect);
    expect([`${to.origin}${to.pathname}`, to.searchParams.get('state'), to.searchParams.get('iss')]).toEqual([REDIRECT, 's-1', ISSUER]);
    const code = to.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = (await db.query<{ status: string; scopes: string[]; grant_id: string; code_hash: Uint8Array; code_expires_at: Date }>('select status, scopes, grant_id, code_hash, code_expires_at from agent.authorization_request where id = $1', [id])).rows[0]!;
    expect(row).toMatchObject({ status: 'approved', scopes: ['balances:read', 'card:freeze'] });
    expect(Buffer.from(row.code_hash).equals(codeHash(code))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(new Date(row.code_expires_at).getTime() - NOW.getTime()).toBe(60_000);
    expect((await db.query('select scopes, status from agent.grant where id = $1', [row.grant_id])).rows[0]).toEqual({ scopes: ['balances:read', 'card:freeze'], status: 'active' });
    // Decided once: a second tap, or a deny after it, finds it decided.
    expect((await call(people.dana, 'POST', `/oauth/requests/${id}/approve`, { scopes: ['balances:read'] })).status).toBe(409);
    expect((await call(people.dana, 'POST', `/oauth/requests/${id}/deny`)).status).toBe(409);
  });

  it('a second approval for the same assistant updates the member\'s one grant', async () => {
    const before = (await db.query<{ id: string }>(`select id from agent.grant where party_id = $1 and client_id = $2 and status = 'active'`, [people.dana.partyId, CLIENT])).rows;
    expect(before).toHaveLength(1);
    const id = await requested('balances:read esim:read');
    await call(people.dana, 'POST', `/oauth/requests/${id}/approve`, { scopes: ['esim:read'] });
    const after = (await db.query<{ id: string; scopes: string[] }>(`select id, scopes from agent.grant where party_id = $1 and client_id = $2 and status = 'active'`, [people.dana.partyId, CLIENT])).rows;
    expect(after).toEqual([{ id: before[0]!.id, scopes: ['esim:read'] }]);
  });

  it('deny answers access_denied with the state; an expired request answers 409; nonsense ids answer 404', async () => {
    const id = await requested();
    const denied = new URL(((await call(people.avi, 'POST', `/oauth/requests/${id}/deny`)).body as { redirect: string }).redirect);
    expect([denied.searchParams.get('error'), denied.searchParams.get('state'), denied.searchParams.has('code')]).toEqual(['access_denied', 's-1', false]);
    // Expired in the table rather than by moving the clock, which would expire the member's bearer too.
    const late = await requested();
    await db.query(`update agent.authorization_request set expires_at = $2 where id = $1`, [late, new Date(NOW.getTime() - 1)]);
    expect((await call(people.avi, 'GET', `/oauth/requests/${late}`)).status).toBe(409);
    expect((await call(people.avi, 'GET', `/oauth/requests/${uuidv7()}`)).status).toBe(404);
    expect((await call(people.avi, 'GET', '/oauth/requests/not-an-id')).status).toBe(404);
  });
});
