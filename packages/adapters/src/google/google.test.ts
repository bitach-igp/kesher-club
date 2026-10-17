// TST-AUTH-004 at the adapter layer: Google sign-in over a fake IdP.
import { beforeAll, describe, expect, it } from 'vitest';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { federatedIdPContract } from '@kesher/ports/contracts';
import { fakedProviders, GOOGLE_TEST_CLIENT } from '../federated-idp.fake.ts';
import { GoogleFederatedIdPAdapter } from './google.ts';

const redirectUri = 'https://app.kesher.example/auth/callback';
let clock: AdvanceableClock;
let env: Awaited<ReturnType<typeof fakedProviders>>;

beforeAll(async () => {
  clock = fixedClock() as AdvanceableClock;
  env = await fakedProviders(clock);
});

federatedIdPContract('google', () => env.router, { goodCode: 'ok:noa', relayCode: 'ok:noa:relay', badCode: 'nope', outageCode: 'outage' });

describe('GoogleFederatedIdPAdapter', () => {
  it('serves only Google (UNSUPPORTED_PROVIDER for Apple)', async () => {
    await expect(env.google.authorizationUrl('apple', { state: 's', nonce: 'n', redirectUri })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    await expect(env.google.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    await expect(env.google.revoke('apple', 'rt', 'k')).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
  });

  it('builds the Google authorize URL asking for an offline refresh token', async () => {
    const a = await env.google.authorizationUrl('google', { state: 's1', nonce: 'n1', redirectUri });
    const u = new URL(a.url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('redirect_uri')).toBe(redirectUri);
  });

  it('exchanges with the static client secret and never flags a relay', async () => {
    const id = await env.google.exchangeCode('google', { code: 'ok:dani', nonce: 'n1', redirectUri });
    expect(id).toMatchObject({ provider: 'google', subject: 'google-sub-dani', email: 'dani@example.com', emailVerified: true, isPrivateRelay: false, refreshToken: 'rt_dani' });
    expect(env.googleFake.tokenRequests.at(-1)).toMatchObject({ client_secret: GOOGLE_TEST_CLIENT.clientSecret, redirect_uri: redirectUri });
  });

  it('rejects a nonce mismatch', async () => {
    await expect(env.google.exchangeCode('google', { code: 'ok:noa:nonce=other', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'NONCE_MISMATCH' });
  });

  it('rejects an expired id_token as INVALID_CODE', async () => {
    const { google, googleFake } = await fakedProviders(clock);
    googleFake.idTokenTtlMs = -120_000;
    await expect(google.exchangeCode('google', { code: 'ok:noa', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'INVALID_CODE' });
  });

  it('refetches the JWKS once when Google rotates its signing key', async () => {
    const { google, googleFake } = await fakedProviders(clock);
    await google.exchangeCode('google', { code: 'ok:noa', nonce: 'n1', redirectUri });
    expect(googleFake.jwksFetches).toBe(1);
    await googleFake.rotate();
    await google.exchangeCode('google', { code: 'ok:noa', nonce: 'n1', redirectUri });
    expect(googleFake.jwksFetches).toBe(2);
  });

  it('refreshes a stale JWKS cache after jwksMaxAgeMs', async () => {
    const { google, googleFake } = await fakedProviders(clock);
    await google.exchangeCode('google', { code: 'ok:noa', nonce: 'n1', redirectUri });
    clock.advance(2 * 3_600_000);
    await google.exchangeCode('google', { code: 'ok:noa', nonce: 'n1', redirectUri });
    expect(googleFake.jwksFetches).toBe(2);
  });

  it('revokes via oauth2.googleapis.com/revoke, treating an already-revoked token as revoked', async () => {
    const { google, googleFake } = await fakedProviders(clock);
    const a = await google.revoke('google', 'rt_noa', 'del-1');
    expect(googleFake.revokeRequests[0]).toEqual({ token: 'rt_noa' });
    const gone = new GoogleFederatedIdPAdapter({
      ...GOOGLE_TEST_CLIENT,
      clock,
      fetch: async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 }),
    });
    const b = await gone.revoke('google', 'rt_noa', 'del-2');
    expect(b.revoked).toBe(true);
    expect(b.auditRef).not.toBe(a.auditRef);
  });

  it('does not claim a revocation it cannot confirm', async () => {
    const flaky = new GoogleFederatedIdPAdapter({ ...GOOGLE_TEST_CLIENT, clock, fetch: async () => new Response('nope', { status: 403 }) });
    await expect(flaky.revoke('google', 'rt', 'k')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('declines a token endpoint response without an id_token (fail secure)', async () => {
    const odd = new GoogleFederatedIdPAdapter({ ...GOOGLE_TEST_CLIENT, clock, fetch: async () => new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }) });
    await expect(odd.exchangeCode('google', { code: 'ok:noa', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'INVALID_CODE' });
  });

  it('crashes on boot without credentials', () => {
    expect(() => new GoogleFederatedIdPAdapter({ clientId: 'c', clientSecret: '' })).toThrow(/clientSecret/);
  });
});
