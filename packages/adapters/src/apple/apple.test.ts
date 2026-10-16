// TST-AUTH-004 / TST-AUTH-005 at the adapter layer: Sign in with Apple over a fake IdP.
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { federatedIdPContract } from '@kesher/ports/contracts';
import { fakedProviders } from '../federated-idp.fake.ts';

const redirectUri = 'https://app.kesher.example/auth/callback';
let clock: AdvanceableClock;
let env: Awaited<ReturnType<typeof fakedProviders>>;

beforeAll(async () => {
  clock = fixedClock() as AdvanceableClock;
  env = await fakedProviders(clock);
});

federatedIdPContract('apple', () => env.router, { goodCode: 'ok:noa', relayCode: 'ok:noa:relay', badCode: 'nope', outageCode: 'outage' });

describe('AppleFederatedIdPAdapter', () => {
  it('serves only Apple (UNSUPPORTED_PROVIDER for Google)', async () => {
    await expect(env.apple.authorizationUrl('google', { state: 's', nonce: 'n', redirectUri })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    await expect(env.apple.exchangeCode('google', { code: 'ok:noa', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    await expect(env.apple.revoke('google', 'rt', 'k')).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
  });

  it('builds the Apple authorize URL with form_post and the name+email scope', async () => {
    const a = await env.apple.authorizationUrl('apple', { state: 's1', nonce: 'n1', redirectUri });
    const u = new URL(a.url);
    expect(u.origin + u.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(u.searchParams.get('response_mode')).toBe('form_post');
    expect(u.searchParams.get('scope')).toBe('name email');
    expect(u.searchParams.get('client_id')).toBe('club.kesher.app');
  });

  it('mints an ES256 client secret signed with the team key and the key id (REQ-AUTH-004)', async () => {
    const { apple, appleFake, applePublicKey } = await fakedProviders(clock);
    await apple.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri });
    const secret = appleFake.tokenRequests.at(-1)!['client_secret']!;
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    const { payload } = await jwtVerify(secret, applePublicKey, { issuer: 'TEAM123456', audience: 'https://appleid.apple.com', currentDate: clock.now() });
    expect(payload.sub).toBe('club.kesher.app');
    expect(payload.exp! - payload.iat!).toBe(600);
  });

  it('maps a plain Apple identity: lower-cased email, verified, not relay, refresh token kept', async () => {
    const id = await env.apple.exchangeCode('apple', { code: 'ok:Noa', nonce: 'n1', redirectUri });
    expect(id).toMatchObject({ provider: 'apple', subject: 'apple-sub-Noa', email: 'noa@example.com', emailVerified: true, isPrivateRelay: false, refreshToken: 'rt_Noa' });
  });

  it('rejects a nonce mismatch', async () => {
    await expect(env.apple.exchangeCode('apple', { code: 'ok:noa:nonce=other', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'NONCE_MISMATCH' });
  });

  it('rejects an expired id_token as INVALID_CODE', async () => {
    const { apple, appleFake } = await fakedProviders(clock);
    appleFake.idTokenTtlMs = -120_000;
    await expect(apple.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'INVALID_CODE' });
  });

  it('refetches the JWKS once when Apple rotates its signing key', async () => {
    const { apple, appleFake } = await fakedProviders(clock);
    await apple.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri });
    await apple.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri });
    expect(appleFake.jwksFetches).toBe(1);
    await appleFake.rotate();
    const id = await apple.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri });
    expect(id.subject).toBe('apple-sub-noa');
    expect(appleFake.jwksFetches).toBe(2);
  });

  it('declines an id_token signed by an unknown key even after the refetch', async () => {
    const { apple, appleFake } = await fakedProviders(clock);
    const { appleFake: stranger } = await fakedProviders(clock);
    // Serve the stranger's token responses but our own JWKS: signature must fail secure.
    const spliced = new (class {
      fetch = (input: string | URL, init?: RequestInit) => (String(input).endsWith('/auth/token') ? stranger.fetch(input, init) : appleFake.fetch(input, init));
    })();
    const { pem } = await import('../federated-idp.fake.ts').then((m) => m.appleTestKeyPem());
    const { AppleFederatedIdPAdapter } = await import('./apple.ts');
    const a = new AppleFederatedIdPAdapter({ clientId: 'club.kesher.app', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKeyPem: pem, fetch: spliced.fetch, clock });
    await expect(a.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'INVALID_CODE' });
    expect(appleFake.jwksFetches).toBe(2);
    void apple;
  });

  it('calls Apple /auth/revoke with the refresh token and is idempotent per key (REQ-AUTH-005)', async () => {
    const { apple, appleFake } = await fakedProviders(clock);
    const id = await apple.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri });
    const a = await apple.revoke('apple', id.refreshToken!, 'del-1');
    const b = await apple.revoke('apple', id.refreshToken!, 'del-1');
    expect(appleFake.revokeRequests).toHaveLength(1);
    expect(appleFake.revokeRequests[0]).toMatchObject({ token: 'rt_noa', token_type_hint: 'refresh_token', client_id: 'club.kesher.app' });
    expect(b.auditRef).toBe(a.auditRef);
    expect(a.auditRef).not.toContain('rt_noa');
  });

  it('never echoes the code or token in error messages', async () => {
    try {
      await env.apple.exchangeCode('apple', { code: 'secret-code-xyz', nonce: 'n1', redirectUri });
      throw new Error('expected rejection');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-code-xyz');
    }
  });

  it('surfaces network failures as PROVIDER_UNAVAILABLE', async () => {
    const { AppleFederatedIdPAdapter } = await import('./apple.ts');
    const { pem } = await import('../federated-idp.fake.ts').then((m) => m.appleTestKeyPem());
    const down = new AppleFederatedIdPAdapter({ clientId: 'c', teamId: 't', keyId: 'k', privateKeyPem: pem, fetch: async () => { throw new TypeError('fetch failed'); }, clock });
    await expect(down.exchangeCode('apple', { code: 'ok:noa', nonce: 'n1', redirectUri })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('crashes on boot without credentials', async () => {
    const { AppleFederatedIdPAdapter } = await import('./apple.ts');
    expect(() => new AppleFederatedIdPAdapter({ clientId: 'c', teamId: '', keyId: 'k', privateKeyPem: 'x' })).toThrow(/teamId/);
  });
});
