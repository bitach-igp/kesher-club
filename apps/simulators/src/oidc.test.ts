// T-0919: the console's own OIDC helpers (discovery, authorization request, code exchange, session
// verification) run against the simulator issuer on a real socket. Every staff persona signs in with its
// roles and a hardware-key amr; a reused code, a wrong client secret or PKCE verifier, an off-machine
// redirect and an off-machine Host are all refused.
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizationUrl, discover, exchangeCode } from '../../admin/src/auth/oidc.ts';
import { verifySession } from '../../admin/src/auth/session.ts';
import { SimulatorHost } from './host.ts';
import { LOCAL_CLIENT, OidcIssuer, STAFF_PERSONAS } from './oidc.ts';
import { createServer } from './server.ts';

let server: http.Server;
let issuer = '';
const redirectUri = 'http://localhost:3100/auth/callback';

beforeAll(async () => {
  server = createServer(new SimulatorHost());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oidc`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The picker's link for a persona, followed without the browser: returns the redirect's code and state. */
async function pickPersona(authorizeUrl: string, sub: string): Promise<URL> {
  const picker = await fetch(authorizeUrl);
  expect(picker.status).toBe(200);
  const html = await picker.text();
  const href = new RegExp(`href="([^"]+)" data-persona="${sub}"`).exec(html)?.[1];
  expect(href).toBeDefined();
  const chosen = await fetch(new URL(href!.replace(/&amp;/g, '&'), issuer), { redirect: 'manual' });
  expect(chosen.status).toBe(302);
  return new URL(chosen.headers.get('location')!);
}

async function jwksKey(jwksUri: string): Promise<CryptoKey> {
  const { keys } = (await (await fetch(jwksUri)).json()) as { keys: JsonWebKey[] };
  return crypto.subtle.importKey('jwk', keys[0]!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

const token = (body: Record<string, string>) => fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

describe('simulator OIDC issuer (T-0919)', () => {
  it('signs in every staff persona through the console\'s own helpers: nonce, roles and a hardware-key amr', async () => {
    const disc = await discover(issuer);
    expect(disc.authorization_endpoint).toBe(`${issuer}/authorize`);
    const key = await jwksKey(disc.jwks_uri);
    for (const persona of STAFF_PERSONAS) {
      const nonce = `nonce-${persona.sub}`;
      const back = await pickPersona(authorizationUrl({ authorizationEndpoint: disc.authorization_endpoint, clientId: LOCAL_CLIENT.id, redirectUri, state: `state-${persona.sub}`, nonce }), persona.sub);
      expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
      expect(back.searchParams.get('state')).toBe(`state-${persona.sub}`);
      const { idToken } = await exchangeCode({ tokenEndpoint: disc.token_endpoint, code: back.searchParams.get('code')!, redirectUri, clientId: LOCAL_CLIENT.id, clientSecret: LOCAL_CLIENT.secret });
      const verdict = await verifySession(idToken, { jwks: key, issuer, audience: LOCAL_CLIENT.id, nonce });
      expect(verdict).toMatchObject({ ok: true, session: { subject: persona.sub, email: persona.email, roles: persona.roles, amr: ['hwk'] } });
    }
    expect(STAFF_PERSONAS.filter((p) => p.roles.includes('admin'))).toHaveLength(2);
    expect(new Set(STAFF_PERSONAS.flatMap((p) => p.roles))).toEqual(new Set(['support', 'compliance', 'finance', 'admin']));
  });

  it('a code is good once: a second exchange answers invalid_grant', async () => {
    const back = await pickPersona(authorizationUrl({ authorizationEndpoint: `${issuer}/authorize`, clientId: LOCAL_CLIENT.id, redirectUri, state: 's', nonce: 'n' }), 'staff-admin-1');
    const form = { grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirectUri, client_id: LOCAL_CLIENT.id, client_secret: LOCAL_CLIENT.secret };
    expect((await token(form)).status).toBe(200);
    const again = await token(form);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('with PKCE, a wrong code_verifier answers invalid_grant and the right one gets the token', async () => {
    const verifier = 'a-verifier-of-enough-length-for-pkce-0123456789';
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    const start = (state: string) => {
      const u = new URL(authorizationUrl({ authorizationEndpoint: `${issuer}/authorize`, clientId: LOCAL_CLIENT.id, redirectUri, state, nonce: 'n' }));
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      return u.toString();
    };
    const wrong = await pickPersona(start('w'), 'staff-finance-1');
    const refused = await token({ grant_type: 'authorization_code', code: wrong.searchParams.get('code')!, redirect_uri: redirectUri, client_id: LOCAL_CLIENT.id, code_verifier: `${verifier}-not` });
    expect(await refused.json()).toMatchObject({ error: 'invalid_grant' });
    const right = await pickPersona(start('r'), 'staff-finance-1');
    const ok = await token({ grant_type: 'authorization_code', code: right.searchParams.get('code')!, redirect_uri: redirectUri, client_id: LOCAL_CLIENT.id, code_verifier: verifier });
    expect(ok.status).toBe(200);
  });

  it('refuses a wrong client secret, a redirect off this machine and a Host off this machine', async () => {
    const back = await pickPersona(authorizationUrl({ authorizationEndpoint: `${issuer}/authorize`, clientId: LOCAL_CLIENT.id, redirectUri, state: 's', nonce: 'n' }), 'staff-support-1');
    const bad = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirectUri, client_id: LOCAL_CLIENT.id, client_secret: 'guess' });
    expect(await bad.json()).toMatchObject({ error: 'invalid_client' });

    const offMachine = await fetch(authorizationUrl({ authorizationEndpoint: `${issuer}/authorize`, clientId: LOCAL_CLIENT.id, redirectUri: 'https://admin.kesher.example/auth/callback', state: 's', nonce: 'n' }));
    expect(offMachine.status).toBe(400);

    const oidc = await OidcIssuer.create();
    const r = await oidc.handle('GET', '/.well-known/openid-configuration', new URLSearchParams(), '', 'idp.example');
    expect(r.status).toBe(400);
  });
});
