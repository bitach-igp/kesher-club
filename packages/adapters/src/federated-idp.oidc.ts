// Shared OIDC authorization-code machinery for the Apple and Google FederatedIdPPort adapters
// (T-0117, REQ-AUTH-004/005). No vendor SDK: an injected `fetch` talks to the token, JWKS and revoke
// endpoints; `jose` verifies the id_token offline against the cached JWKS. The adapter never retries;
// the one JWKS refetch on an unknown `kid` is key rotation handling, not a retry of a failed call.
// Tokens, codes, client secrets and emails never appear in error messages or logs.
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { type Clock, FederatedIdPError, type FederatedAuthorization, type FederatedIdentity, type FederatedIdPPort, type FederatedProvider, IdempotencyStore } from '@kesher/ports';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const systemClock: Clock = { now: () => new Date() };

export interface OidcEndpoints {
  authorize: string;
  token: string;
  jwks: string;
  revoke: string;
}

export interface OidcAdapterOptions {
  clientId: string;
  /** Accepted `iss` values; Google historically used both forms. */
  issuers: readonly string[];
  endpoints: OidcEndpoints;
  /** Extra query parameters for the authorization URL (scope, response_mode, ...). */
  authorizeParams: Record<string, string>;
  /** Signature algorithms the IdP may use for the id_token. */
  algorithms: readonly string[];
  fetch?: FetchLike;
  clock?: Clock;
  /** Re-fetch the JWKS after this long even without a rotation signal. Default 1 hour. */
  jwksMaxAgeMs?: number;
  /** Tolerated clock skew for `exp`/`iat`, in seconds. Default 60. */
  clockToleranceSeconds?: number;
}

/** Raw id_token claims the two providers share; vendor subclasses derive the identity from them. */
export interface VerifiedIdToken {
  payload: JWTPayload & { email?: unknown; email_verified?: unknown; is_private_email?: unknown; nonce?: unknown };
  refreshToken: string | undefined;
}

export abstract class OidcFederatedIdPAdapter implements FederatedIdPPort {
  protected readonly fetch: FetchLike;
  protected readonly clock: Clock;
  private readonly revocations = new IdempotencyStore<{ revoked: true; auditRef: string }>();
  private jwks: { set: ReturnType<typeof createLocalJWKSet>; fetchedAt: number } | undefined;

  readonly provider: FederatedProvider;
  protected readonly opts: OidcAdapterOptions;
  protected constructor(
    provider: FederatedProvider,
    opts: OidcAdapterOptions,
  ) {
    this.provider = provider;
    this.opts = opts;
    if (!opts.clientId) throw new Error(`${provider} federated IdP: clientId is required`);
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.clock = opts.clock ?? systemClock;
  }

  async authorizationUrl(provider: FederatedProvider, input: { state: string; nonce: string; redirectUri: string }): Promise<FederatedAuthorization> {
    this.assertProvider(provider);
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      nonce: input.nonce,
      ...this.opts.authorizeParams,
    });
    return { provider, url: `${this.opts.endpoints.authorize}?${q}`, state: input.state, nonce: input.nonce };
  }

  async exchangeCode(provider: FederatedProvider, input: { code: string; nonce: string; redirectUri: string }): Promise<FederatedIdentity> {
    this.assertProvider(provider);
    if (!input.code) throw new FederatedIdPError('INVALID_CODE', 'Authorization code required');
    const res = await this.post(this.opts.endpoints.token, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.opts.clientId,
      client_secret: await this.clientSecret(),
    });
    if (res.status === 429 || res.status >= 500) throw new FederatedIdPError('PROVIDER_UNAVAILABLE', `${provider} token endpoint returned ${res.status}`);
    const body = await readJson(res);
    // Any non-2xx (invalid_grant, invalid_client, ...) or unreadable body declines: fail secure.
    if (!res.ok || !body || typeof body['id_token'] !== 'string') throw new FederatedIdPError('INVALID_CODE', `${provider} did not issue an id_token`);
    const payload = await this.verifyIdToken(body['id_token']);
    if (typeof payload.nonce !== 'string' || payload.nonce !== input.nonce) throw new FederatedIdPError('NONCE_MISMATCH', 'id_token nonce does not match');
    const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : undefined;
    return this.identityFrom({ payload, refreshToken });
  }

  async revoke(provider: FederatedProvider, refreshToken: string, idempotencyKey: string): Promise<{ revoked: true; auditRef: string }> {
    this.assertProvider(provider);
    if (!refreshToken) throw new FederatedIdPError('INVALID_CODE', 'Refresh token required');
    // In-process replay guard; the durable idempotency boundary is the Temporal workflow id.
    return this.revocations.run(idempotencyKey, async () => {
      const res = await this.post(this.opts.endpoints.revoke, await this.revokeBody(refreshToken));
      if (res.status === 429 || res.status >= 500) throw new FederatedIdPError('PROVIDER_UNAVAILABLE', `${provider} revoke endpoint returned ${res.status}`);
      if (!res.ok && !(await this.alreadyRevoked(res))) throw new FederatedIdPError('PROVIDER_UNAVAILABLE', `${provider} refused the revocation (${res.status})`);
      return { revoked: true as const, auditRef: `${provider}-revoke:${crypto.randomUUID()}:${this.clock.now().toISOString()}` };
    });
  }

  /** The client secret for this call (Apple: a short-lived ES256 JWT; Google: the static secret). */
  protected abstract clientSecret(): Promise<string>;
  /** Vendor-specific form body for the revoke endpoint. */
  protected abstract revokeBody(refreshToken: string): Promise<Record<string, string>>;
  /** True when a 4xx from the revoke endpoint means the token was already revoked (idempotent). */
  protected abstract alreadyRevoked(res: Response): Promise<boolean>;
  protected abstract identityFrom(token: VerifiedIdToken): FederatedIdentity;

  protected assertProvider(provider: FederatedProvider): void {
    if (provider !== this.provider) throw new FederatedIdPError('UNSUPPORTED_PROVIDER', `This adapter serves ${this.provider}, not ${String(provider)}`);
  }

  protected async post(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw new FederatedIdPError('PROVIDER_UNAVAILABLE', `${this.provider} endpoint unreachable`);
    }
  }

  private async verifyIdToken(idToken: string): Promise<VerifiedIdToken['payload']> {
    const verify = async () => {
      const { payload } = await jwtVerify(idToken, await this.keySet(), {
        issuer: [...this.opts.issuers],
        audience: this.opts.clientId,
        algorithms: [...this.opts.algorithms],
        currentDate: this.clock.now(),
        clockTolerance: this.opts.clockToleranceSeconds ?? 60,
      });
      return payload;
    };
    try {
      try {
        return await verify();
      } catch (e) {
        // Key rotation: the IdP signed with a kid we have not seen. Refresh the JWKS once.
        if (!(e instanceof joseErrors.JWKSNoMatchingKey)) throw e;
        this.jwks = undefined;
        return await verify();
      }
    } catch (e) {
      if (e instanceof FederatedIdPError) throw e;
      if (e instanceof joseErrors.JWTExpired) throw new FederatedIdPError('INVALID_CODE', 'id_token expired');
      if (e instanceof joseErrors.JOSEError) throw new FederatedIdPError('INVALID_CODE', `id_token rejected (${e.code})`);
      throw new FederatedIdPError('INVALID_CODE', 'id_token could not be verified');
    }
  }

  private async keySet(): Promise<ReturnType<typeof createLocalJWKSet>> {
    const maxAge = this.opts.jwksMaxAgeMs ?? 3_600_000;
    const now = this.clock.now().getTime();
    if (this.jwks && now - this.jwks.fetchedAt < maxAge) return this.jwks.set;
    let res: Response;
    try {
      res = await this.fetch(this.opts.endpoints.jwks, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      throw new FederatedIdPError('PROVIDER_UNAVAILABLE', `${this.provider} JWKS unreachable`);
    }
    if (!res.ok) throw new FederatedIdPError('PROVIDER_UNAVAILABLE', `${this.provider} JWKS returned ${res.status}`);
    const body = await readJson(res);
    if (!body || !Array.isArray(body['keys'])) throw new FederatedIdPError('PROVIDER_UNAVAILABLE', `${this.provider} JWKS malformed`);
    this.jwks = { set: createLocalJWKSet(body as unknown as JSONWebKeySet), fetchedAt: now };
    return this.jwks.set;
  }
}

export async function readJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const v: unknown = await res.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const truthyClaim = (v: unknown): boolean => v === true || v === 'true';

/**
 * Routes each FederatedPort call to the adapter for that provider, so one registry binding offers
 * Apple and Google together (REQ-AUTH-004: both or neither).
 */
export class FederatedIdPRouter implements FederatedIdPPort {
  private readonly adapters: Readonly<Record<FederatedProvider, FederatedIdPPort>>;
  constructor(adapters: Readonly<Record<FederatedProvider, FederatedIdPPort>>) {
    this.adapters = adapters;
  }

  async authorizationUrl(provider: FederatedProvider, input: { state: string; nonce: string; redirectUri: string }): Promise<FederatedAuthorization> {
    return this.pick(provider).authorizationUrl(provider, input);
  }
  async exchangeCode(provider: FederatedProvider, input: { code: string; nonce: string; redirectUri: string }): Promise<FederatedIdentity> {
    return this.pick(provider).exchangeCode(provider, input);
  }
  async revoke(provider: FederatedProvider, refreshToken: string, idempotencyKey: string): Promise<{ revoked: true; auditRef: string }> {
    return this.pick(provider).revoke(provider, refreshToken, idempotencyKey);
  }
  private pick(provider: FederatedProvider): FederatedIdPPort {
    const a = Object.prototype.hasOwnProperty.call(this.adapters, provider) ? this.adapters[provider] : undefined;
    if (!a) throw new FederatedIdPError('UNSUPPORTED_PROVIDER', `No adapter bound for ${String(provider)}`);
    return a;
  }
}
