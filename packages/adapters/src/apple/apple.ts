// Sign in with Apple adapter for FederatedIdPPort (T-0117, REQ-AUTH-004/005). The client secret is
// an ES256 JWT minted per call from the team id, key id and the .p8 private key; the id_token is
// verified against Apple's JWKS; "Hide my email" relay addresses are accepted as first-class; account
// deletion calls /auth/revoke. No Apple SDK; everything goes through the injected fetch.
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import { type Clock, type FederatedIdentity } from '@kesher/ports';
import { type FetchLike, OidcFederatedIdPAdapter, readJson, truthyClaim, type VerifiedIdToken } from '../federated-idp.oidc.ts';

export const APPLE_ENDPOINTS = {
  authorize: 'https://appleid.apple.com/auth/authorize',
  token: 'https://appleid.apple.com/auth/token',
  jwks: 'https://appleid.apple.com/auth/keys',
  revoke: 'https://appleid.apple.com/auth/revoke',
} as const;

const APPLE_ISSUER = 'https://appleid.apple.com';
const PRIVATE_RELAY_SUFFIX = '@privaterelay.appleid.com';

export interface AppleFederatedIdPOptions {
  /** Services ID (web) or bundle id (native) registered for Sign in with Apple. */
  clientId: string;
  teamId: string;
  /** Key id of the Sign in with Apple private key. */
  keyId: string;
  /** The .p8 contents (PKCS#8 PEM). Never logged. */
  privateKeyPem: string;
  fetch?: FetchLike;
  clock?: Clock;
  /** Lifetime of each minted client secret; Apple allows up to 6 months. Default 10 minutes. */
  clientSecretTtlSeconds?: number;
  jwksMaxAgeMs?: number;
}

export class AppleFederatedIdPAdapter extends OidcFederatedIdPAdapter {
  private signingKey: Promise<CryptoKey> | undefined;

  constructor(private readonly apple: AppleFederatedIdPOptions) {
    for (const k of ['clientId', 'teamId', 'keyId', 'privateKeyPem'] as const) {
      if (!apple[k]) throw new Error(`Apple federated IdP: ${k} is required`);
    }
    super('apple', {
      clientId: apple.clientId,
      issuers: [APPLE_ISSUER],
      endpoints: APPLE_ENDPOINTS,
      authorizeParams: { scope: 'name email', response_mode: 'form_post' },
      algorithms: ['RS256'],
      ...(apple.fetch ? { fetch: apple.fetch } : {}),
      ...(apple.clock ? { clock: apple.clock } : {}),
      ...(apple.jwksMaxAgeMs !== undefined ? { jwksMaxAgeMs: apple.jwksMaxAgeMs } : {}),
    });
  }

  /** Apple's client_secret: ES256 JWT, iss = team id, sub = client id, aud = Apple, kid in the header. */
  protected async clientSecret(): Promise<string> {
    this.signingKey ??= importPKCS8(this.apple.privateKeyPem, 'ES256');
    const now = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.apple.keyId })
      .setIssuer(this.apple.teamId)
      .setSubject(this.apple.clientId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + (this.apple.clientSecretTtlSeconds ?? 600))
      .sign(await this.signingKey);
  }

  protected async revokeBody(refreshToken: string): Promise<Record<string, string>> {
    return { client_id: this.apple.clientId, client_secret: await this.clientSecret(), token: refreshToken, token_type_hint: 'refresh_token' };
  }

  protected async alreadyRevoked(res: Response): Promise<boolean> {
    // Apple answers 400 invalid_grant for a token that is already revoked or expired.
    if (res.status !== 400) return false;
    const body = await readJson(res);
    return body?.['error'] === 'invalid_grant';
  }

  protected identityFrom({ payload, refreshToken }: VerifiedIdToken): FederatedIdentity {
    const email = typeof payload.email === 'string' && payload.email ? payload.email.toLowerCase() : undefined;
    const isPrivateRelay = truthyClaim(payload.is_private_email) || (email !== undefined && email.endsWith(PRIVATE_RELAY_SUFFIX));
    return {
      provider: 'apple',
      subject: payload.sub as string,
      ...(email !== undefined ? { email } : {}),
      // Apple sends email_verified as the string "true" on some paths; relay addresses are always verified.
      emailVerified: email !== undefined && (truthyClaim(payload.email_verified) || isPrivateRelay),
      isPrivateRelay,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    };
  }
}
