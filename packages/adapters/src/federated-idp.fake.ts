// Test double for an OIDC identity provider (Apple or Google shaped), served through a fake `fetch`.
// Holds a signing key pair, serves its JWKS, exchanges codes of the form `ok:<subject>[:relay][:nonce=<n>]`
// for a signed id_token, answers `outage` with 503 and anything else with 400 invalid_grant. Test-only.
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import type { Clock } from '@kesher/ports';
import type { FetchLike } from './federated-idp.oidc.ts';

export interface FakeIdPOptions {
  issuer: string;
  audience: string;
  endpoints: { token: string; jwks: string; revoke: string };
  /** Shape the claims like Apple (string booleans, is_private_email) or Google. */
  flavour: 'apple' | 'google';
  clock: Clock;
  alg?: 'RS256' | 'ES256';
}

export class FakeIdP {
  readonly fetch: FetchLike;
  /** Nonce the "user" sent on the authorization request; the fake binds every code to it. */
  nonce = 'n1';
  /** id_token lifetime; negative mints an already-expired token. */
  idTokenTtlMs = 3_600_000;
  jwksFetches = 0;
  readonly tokenRequests: Record<string, string>[] = [];
  readonly revokeRequests: Record<string, string>[] = [];
  private keys!: { kid: string; privateKey: CryptoKey; jwk: JWK };

  private constructor(private readonly opts: FakeIdPOptions) {
    this.fetch = (input, init) => this.handle(String(input), init);
  }

  static async create(opts: FakeIdPOptions): Promise<FakeIdP> {
    const f = new FakeIdP(opts);
    await f.rotate();
    return f;
  }

  /** Replaces the signing key, as the real IdPs do; old kids disappear from the JWKS. */
  async rotate(): Promise<string> {
    const alg = this.opts.alg ?? 'RS256';
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const kid = `kid-${crypto.randomUUID().slice(0, 8)}`;
    this.keys = { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
    return kid;
  }

  get kid(): string {
    return this.keys.kid;
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const { token, jwks, revoke } = this.opts.endpoints;
    if (url === jwks && (init?.method ?? 'GET') === 'GET') {
      this.jwksFetches += 1;
      return json(200, { keys: [this.keys.jwk] });
    }
    if (url === token && init?.method === 'POST') return this.token(form(init));
    if (url === revoke && init?.method === 'POST') {
      const body = form(init);
      this.revokeRequests.push(body);
      if (!body['token']) return json(400, { error: 'invalid_request' });
      return this.opts.flavour === 'apple' ? new Response(null, { status: 200 }) : json(200, {});
    }
    return json(404, { error: 'not_found' });
  }

  private async token(body: Record<string, string>): Promise<Response> {
    this.tokenRequests.push(body);
    if (body['grant_type'] !== 'authorization_code' || !body['client_id'] || !body['client_secret']) return json(400, { error: 'invalid_request' });
    const code = body['code'] ?? '';
    if (code === 'outage') return json(503, { error: 'temporarily_unavailable' });
    const m = /^ok:([a-z0-9_-]+)(:relay)?(?::nonce=(\S+))?$/i.exec(code);
    if (!m) return json(400, { error: 'invalid_grant' });
    const subject = m[1]!;
    const relay = Boolean(m[2]);
    const nonce = m[3] ?? this.nonce;
    const email = relay ? `${subject}@privaterelay.appleid.com` : `${subject}@example.com`;
    const apple = this.opts.flavour === 'apple';
    const claims: Record<string, unknown> = apple
      ? { email, email_verified: 'true', nonce, ...(relay ? { is_private_email: 'true' } : {}) }
      : { email, email_verified: true, nonce };
    const now = this.opts.clock.now().getTime();
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: this.keys.jwk.alg as string, kid: this.keys.kid })
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setSubject(`${this.opts.flavour}-sub-${subject}`)
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor((now + this.idTokenTtlMs) / 1000))
      .sign(this.keys.privateKey);
    return json(200, { access_token: `at_${subject}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt_${subject}`, id_token: idToken });
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const form = (init: RequestInit): Record<string, string> => Object.fromEntries(new URLSearchParams(String(init.body ?? '')));

// ---- Convenience for contract tests: both real adapters, each over its own fake IdP. ----
import { exportPKCS8 } from 'jose';
import { AppleFederatedIdPAdapter, APPLE_ENDPOINTS } from './apple/apple.ts';
import { GoogleFederatedIdPAdapter, GOOGLE_ENDPOINTS } from './google/google.ts';
import { FederatedIdPRouter } from './federated-idp.oidc.ts';

export const APPLE_TEST_CLIENT = { clientId: 'club.kesher.app', teamId: 'TEAM123456', keyId: 'KEY1234567' };
export const GOOGLE_TEST_CLIENT = { clientId: '1234.apps.googleusercontent.com', clientSecret: 'test-google-secret' };

export async function appleTestKeyPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { pem: await exportPKCS8(privateKey), publicKey };
}

export async function fakedProviders(clock: Clock) {
  const appleFake = await FakeIdP.create({ issuer: 'https://appleid.apple.com', audience: APPLE_TEST_CLIENT.clientId, endpoints: APPLE_ENDPOINTS, flavour: 'apple', clock });
  const googleFake = await FakeIdP.create({ issuer: 'https://accounts.google.com', audience: GOOGLE_TEST_CLIENT.clientId, endpoints: GOOGLE_ENDPOINTS, flavour: 'google', clock });
  const { pem, publicKey } = await appleTestKeyPem();
  const apple = new AppleFederatedIdPAdapter({ ...APPLE_TEST_CLIENT, privateKeyPem: pem, fetch: appleFake.fetch, clock });
  const google = new GoogleFederatedIdPAdapter({ ...GOOGLE_TEST_CLIENT, fetch: googleFake.fetch, clock });
  return { appleFake, googleFake, apple, google, applePublicKey: publicKey, router: new FederatedIdPRouter({ apple, google }) };
}
