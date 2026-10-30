// T-1016 the token endpoint (TST-AGT-011; ADR-009), end to end through the request (T-1014) and the consent (T-1015):
// - the code trades once, within 60 seconds, for the right client, redirect URI and PKCE verifier; a wrong verifier
//   burns it, and a reused code revokes the grant;
// - the access token passes the MCP resource server's validator and is refused by the member API, as a member
//   token is refused by the validator (audience binding, REQ-AGT-002);
// - refresh rotates; a replayed refresh token revokes the grant, and the validator then refuses its access token;
// - a grant revoked from the grants screen refreshes nothing; the endpoint takes a form body and answers OAuth's
//   own JSON errors; with mcp.enabled off, 404.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { McpTokenValidator } from '../mcp/auth.ts';
import type { Fetcher, Resolver } from '../mcp/cimd.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
let off: App;
let validator: McpTokenValidator;
let member: { partyId: string; access: string; stepUp: string };
const NOW = new Date('2026-11-10T09:00:00Z');
const ISSUER = 'https://api.kesher.example';
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT = 'https://assistant.example/oauth/client.json';
const REDIRECT = 'https://assistant.example/oauth/callback';

const resolve: Resolver = async () => ['93.184.216.34'];
const fetchDoc: Fetcher = async (url) => {
  const body = JSON.stringify({ client_id: url, client_name: 'Trip Planner', redirect_uris: [REDIRECT] });
  return { status: 200, headers: { get: () => null }, text: async () => body };
};
const form = (fields: Record<string, string>, now = NOW, a: App = app) =>
  dispatch(a, { method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: new URLSearchParams(fields).toString(), now });

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

/** The whole front channel: the assistant's request, the member's approval; answers the code and its verifier. */
async function approvedCode(scopes = ['balances:read', 'transactions:read']): Promise<{ code: string; verifier: string; grantId: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, state: 's', scope: scopes.join(' '), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: RESOURCE });
  const asked = await dispatch(app, { method: 'GET', url: `/oauth/authorize?${q}`, headers: {}, rawBody: '', now: NOW });
  const id = new URL(asked.headers!['location']!).pathname.split('/').pop()!;
  const approved = await dispatch(app, { method: 'POST', url: `/oauth/requests/${id}/approve`, headers: { authorization: `Bearer ${member.access}`, 'x-step-up': member.stepUp }, rawBody: JSON.stringify({ scopes }), now: NOW });
  const code = new URL((approved.body as { redirect: string }).redirect).searchParams.get('code')!;
  const grantId = (await db.query<{ grant_id: string }>('select grant_id from agent.authorization_request where id = $1', [id])).rows[0]!.grant_id;
  return { code, verifier, grantId };
}
const trade = (c: { code: string; verifier: string }, over: Record<string, string> = {}) => form({ grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, client_id: CLIENT, redirect_uri: REDIRECT, ...over });

beforeAll(async () => {
  db = await createTestDatabase();
  const signingKey = await generateSigningKey();
  const opts = { db, registry: new SimulatorHost().registry, market: 'IL' as const, signingKey, issuer: ISSUER, clock: () => NOW, oauth: { consentUrl: 'https://app.kesher.example/connect' }, cimd: { resolve, fetch: fetchDoc } };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'mcp.enabled': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags(undefined, { 'mcp.enabled': false }) });
  validator = new McpTokenValidator(db, { jwks: (await app.services.tokens.jwks()) as never, issuer: ISSUER }, RESOURCE);
  member = await person('+972501260001');
}, 60_000);
afterAll(async () => db.close());

describe('TST-AGT-011: the token endpoint (T-1016)', () => {
  it('trades a code once for a 10-minute MCP token and a refresh token; the token works on /mcp only', async () => {
    const c = await approvedCode();
    const r = await trade(c);
    expect(r.status).toBe(200);
    const t = r.body as { access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string };
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'balances:read transactions:read' });
    expect(t.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await validator.validate(`Bearer ${t.access_token}`, NOW)).toMatchObject({ ok: true, principal: { partyId: member.partyId, grantId: c.grantId, clientId: CLIENT, scopes: ['balances:read', 'transactions:read'] } });
    // Audience binding both ways (REQ-AGT-002): the member API refuses it, and /mcp refuses a member token.
    expect((await dispatch(app, { method: 'GET', url: '/me/display-name', headers: { authorization: `Bearer ${t.access_token}` }, rawBody: '', now: NOW })).status).toBe(401);
    expect(await validator.validate(`Bearer ${member.access}`, NOW)).toMatchObject({ ok: false });
    // Ten minutes, plus the validator's 5 seconds of clock tolerance.
    expect(await validator.validate(`Bearer ${t.access_token}`, new Date(NOW.getTime() + 604_000))).toMatchObject({ ok: true });
    expect(await validator.validate(`Bearer ${t.access_token}`, new Date(NOW.getTime() + 606_000))).toMatchObject({ ok: false });
    // The refresh token is stored only as a hash.
    expect(JSON.stringify((await db.query('select * from agent.refresh_token')).rows)).not.toContain(t.refresh_token);
  });

  it('a reused code is refused and revokes the grant it made', async () => {
    const c = await approvedCode();
    const first = (await trade(c)).body as { access_token: string };
    expect(await trade(c)).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect(await validator.validate(`Bearer ${first.access_token}`, NOW)).toMatchObject({ ok: false, reason: 'grant revoked or unknown' });
  });

  it('a wrong verifier, client or redirect URI, or a late code, answers invalid_grant; a wrong verifier burns the code', async () => {
    const burned = await approvedCode();
    expect((await trade(burned, { code_verifier: randomBytes(32).toString('base64url') })).body).toMatchObject({ error: 'invalid_grant' });
    expect((await trade(burned)).body).toMatchObject({ error: 'invalid_grant' });
    for (const over of [{ client_id: 'https://other.example/client.json' }, { redirect_uri: 'https://assistant.example/elsewhere' }]) expect((await trade(await approvedCode(), over)).body).toMatchObject({ error: 'invalid_grant' });
    const late = await approvedCode();
    // The other codes here were all used or burned, so the late one is the only approved request left.
    await db.query(`update agent.authorization_request set code_expires_at = $1 where status = 'approved'`, [new Date(NOW.getTime() - 1)]);
    expect((await trade(late)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('refresh rotates; a replayed refresh token revokes the grant and its access tokens stop working', async () => {
    const c = await approvedCode();
    const first = (await trade(c)).body as { refresh_token: string; access_token: string };
    const second = (await form({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT })).body as { refresh_token: string; access_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await validator.validate(`Bearer ${second.access_token}`, NOW)).toMatchObject({ ok: true });
    // The old one again: theft, by assumption. The grant goes, and every token under it with it.
    expect((await form({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT })).body).toMatchObject({ error: 'invalid_grant' });
    expect(await validator.validate(`Bearer ${second.access_token}`, NOW)).toMatchObject({ ok: false });
    expect((await form({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: CLIENT })).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('a grant revoked from the grants screen refreshes nothing; another client cannot use the refresh token', async () => {
    const c = await approvedCode(['esim:read']);
    const t = (await trade(c)).body as { refresh_token: string };
    expect((await form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: 'https://other.example/client.json' })).body).toMatchObject({ error: 'invalid_grant' });
    expect((await dispatch(app, { method: 'DELETE', url: `/agent-grants/${c.grantId}`, headers: { authorization: `Bearer ${member.access}` }, rawBody: '', now: NOW })).status).toBe(204);
    expect((await form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT })).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('answers OAuth errors for a bad request, and 404 with the flag off', async () => {
    expect(await form({ grant_type: 'password', username: 'x' })).toMatchObject({ status: 400, body: { error: 'unsupported_grant_type' } });
    expect((await form({ grant_type: 'authorization_code', code: 'x' })).body).toMatchObject({ error: 'invalid_request' });
    expect((await form({ grant_type: 'refresh_token', refresh_token: 'x', client_id: CLIENT }, NOW, off)).status).toBe(404);
  });
});
