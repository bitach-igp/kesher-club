// T-1014 the MCP authorization server's front door (TST-AGT-010, request rows; ADR-009): the RFC 8414 metadata
// names S256 only; a good request is stored for 10 minutes and redirects to the app's consent screen; a redirect
// URI the client's document does not list answers 422 and never redirects; plain PKCE, a missing or foreign
// resource, an unknown scope and a missing state each go back to the client with the error; a client document
// on a private address is refused; with mcp.enabled off, everything here is 404.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import type { Fetcher, Resolver } from '../mcp/cimd.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
let off: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const ISSUER = 'https://api.kesher.example';
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT = 'https://assistant.example/oauth/client.json';
const PRIVATE = 'https://intranet.example/client.json';
const REDIRECT = 'https://assistant.example/oauth/callback';
const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

const resolve: Resolver = async (host) => (host === 'intranet.example' ? ['10.0.0.7'] : ['93.184.216.34']);
const fetchDoc: Fetcher = async (url) => {
  const body = JSON.stringify({ client_id: url, client_name: 'Trip Planner', client_uri: 'https://assistant.example', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  return { status: 200, headers: { get: (h: string) => (h === 'content-length' ? String(body.length) : null) }, text: async () => body };
};

const ask = (over: Record<string, string | undefined> = {}, a: App = app) => {
  const q = { response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, state: 'xyz-123', scope: 'balances:read transactions:read', code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE, ...over };
  const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return dispatch(a, { method: 'GET', url: `/oauth/authorize?${qs}`, headers: {}, rawBody: '', now: NOW });
};
const location = (r: { headers?: Record<string, string> }) => new URL(r.headers?.['location'] ?? 'about:blank');
const stored = async () => (await db.query<{ n: number }>('select count(*)::int as n from agent.authorization_request')).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase();
  const opts = { db, registry: new SimulatorHost().registry, market: 'IL' as const, signingKey: await generateSigningKey(), issuer: ISSUER, clock: () => NOW, oauth: { consentUrl: 'https://app.kesher.example/connect' }, cimd: { resolve, fetch: fetchDoc } };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'mcp.enabled': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags(undefined, { 'mcp.enabled': false }) });
}, 60_000);
afterAll(async () => db.close());

describe('TST-AGT-010: the authorization request (T-1014)', () => {
  it('publishes RFC 8414 metadata with S256 only, and the JWKS', async () => {
    const meta = await dispatch(app, { method: 'GET', url: '/.well-known/oauth-authorization-server', headers: {}, rawBody: '', now: NOW });
    expect(meta.body).toMatchObject({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/token`, jwks_uri: `${ISSUER}/oauth/jwks`, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true });
    expect((meta.body as { scopes_supported: string[] }).scopes_supported).toEqual(expect.arrayContaining(['balances:read', 'p2p:propose']));
    const jwks = (await dispatch(app, { method: 'GET', url: '/oauth/jwks', headers: {}, rawBody: '', now: NOW })).body as { keys: { kty: string; alg: string; d?: string }[] };
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256' });
    expect(jwks.keys[0]!.d).toBeUndefined();
  });

  it('a good request is stored for 10 minutes and redirects to the consent screen', async () => {
    const r = await ask();
    expect(r.status).toBe(302);
    const to = location(r);
    expect(`${to.origin}${to.pathname}`).toMatch(/^https:\/\/app\.kesher\.example\/connect\/[0-9a-f-]{36}$/);
    const row = (await db.query<{ client_id: string; redirect_uri: string; scopes: string[]; state: string; code_challenge: string; resource: string; status: string; expires_at: Date }>('select * from agent.authorization_request where id = $1', [to.pathname.split('/').pop()])).rows[0]!;
    expect(row).toMatchObject({ client_id: CLIENT, redirect_uri: REDIRECT, scopes: ['balances:read', 'transactions:read'], state: 'xyz-123', code_challenge: challenge, resource: RESOURCE, status: 'pending' });
    expect(new Date(row.expires_at).getTime() - NOW.getTime()).toBe(10 * 60_000);
  });

  it('a redirect URI the document does not list answers 422 and never redirects', async () => {
    const before = await stored();
    const r = await ask({ redirect_uri: 'https://evil.example/steal' });
    expect(r).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } });
    expect(r.headers?.['location']).toBeUndefined();
    expect(await stored()).toBe(before);
  });

  it('plain PKCE, a foreign or missing resource, an unknown scope, a missing state or response type go back to the client with the error', async () => {
    const before = await stored();
    for (const [over, error] of [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ resource: undefined }, 'invalid_target'],
      [{ scope: 'balances:read money:move' }, 'invalid_scope'],
      [{ scope: '' }, 'invalid_scope'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ] as const) {
      const r = await ask(over);
      expect(r.status).toBe(302);
      const to = location(r);
      expect([`${to.origin}${to.pathname}`, to.searchParams.get('error'), to.searchParams.get('state')]).toEqual([REDIRECT, error, 'xyz-123']);
    }
    const noState = location(await ask({ state: undefined }));
    expect([noState.searchParams.get('error'), noState.searchParams.has('state')]).toEqual(['invalid_request', false]);
    expect(await stored()).toBe(before);
  });

  it('a client document on a private address is refused, as is an http one', async () => {
    expect((await ask({ client_id: PRIVATE })).status).toBe(422);
    expect((await ask({ client_id: 'http://assistant.example/client.json' })).status).toBe(422);
  });

  it('with mcp.enabled off, the metadata, the keys and the request are all 404', async () => {
    for (const url of ['/.well-known/oauth-authorization-server', '/oauth/jwks']) expect((await dispatch(off, { method: 'GET', url, headers: {}, rawBody: '', now: NOW })).status).toBe(404);
    expect((await ask({}, off)).status).toBe(404);
  });
});
