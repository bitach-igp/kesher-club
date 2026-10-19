// Google Identity adapter for FederatedIdPPort (T-0117, REQ-AUTH-004). OAuth 2.0 authorization code
// with a static client secret; the id_token is verified against Google's JWKS; revocation hits
// oauth2.googleapis.com/revoke. No Google SDK; everything goes through the injected fetch.
import { type Clock, type FederatedIdentity } from '@kesher/ports';
import { type FetchLike, OidcFederatedIdPAdapter, readJson, truthyClaim, type VerifiedIdToken } from '../federated-idp.oidc.ts';

export const GOOGLE_ENDPOINTS = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  revoke: 'https://oauth2.googleapis.com/revoke',
} as const;

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleFederatedIdPOptions {
  clientId: string;
  /** OAuth client secret. Never logged. */
  clientSecret: string;
  fetch?: FetchLike;
  clock?: Clock;
  jwksMaxAgeMs?: number;
}

export class GoogleFederatedIdPAdapter extends OidcFederatedIdPAdapter {
  private readonly google: GoogleFederatedIdPOptions;
  constructor(google: GoogleFederatedIdPOptions) {
    if (!google.clientId || !google.clientSecret) throw new Error('Google federated IdP: clientId and clientSecret are required');
    super('google', {
      clientId: google.clientId,
      issuers: GOOGLE_ISSUERS,
      endpoints: GOOGLE_ENDPOINTS,
      // access_type=offline + prompt=consent yields the refresh token we keep (encrypted) for revocation.
      authorizeParams: { scope: 'openid email profile', access_type: 'offline', prompt: 'consent' },
      algorithms: ['RS256'],
      ...(google.fetch ? { fetch: google.fetch } : {}),
      ...(google.clock ? { clock: google.clock } : {}),
      ...(google.jwksMaxAgeMs !== undefined ? { jwksMaxAgeMs: google.jwksMaxAgeMs } : {}),
    });
    this.google = google;
  }

  protected async clientSecret(): Promise<string> {
    return this.google.clientSecret;
  }

  protected async revokeBody(refreshToken: string): Promise<Record<string, string>> {
    return { token: refreshToken };
  }

  protected async alreadyRevoked(res: Response): Promise<boolean> {
    // Google answers 400 invalid_token once a token has been revoked or has expired.
    if (res.status !== 400) return false;
    const body = await readJson(res);
    return body?.['error'] === 'invalid_token';
  }

  protected identityFrom({ payload, refreshToken }: VerifiedIdToken): FederatedIdentity {
    const email = typeof payload.email === 'string' && payload.email ? payload.email.toLowerCase() : undefined;
    return {
      provider: 'google',
      subject: payload.sub as string,
      ...(email !== undefined ? { email } : {}),
      emailVerified: email !== undefined && truthyClaim(payload.email_verified),
      isPrivateRelay: false,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    };
  }
}
