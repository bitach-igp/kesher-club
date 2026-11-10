// FederatedIdPPort (REQ-AUTH-004/005): Sign in with Apple and Google, offered together or not at all.
// Apple's private relay email is a first-class case, and account deletion revokes the Apple token.

export type FederatedProvider = 'apple' | 'google';

export interface FederatedAuthorization {
  provider: FederatedProvider;
  url: string;
  state: string;
  nonce: string;
}

export interface FederatedIdentity {
  provider: FederatedProvider;
  /** Stable subject from the IdP; never an email. */
  subject: string;
  email?: string;
  emailVerified: boolean;
  /** Apple "Hide my email" relay; must be accepted (REQ-AUTH-004). */
  isPrivateRelay: boolean;
  /** Opaque tokens kept only for revocation; stored encrypted, never logged. */
  refreshToken?: string;
}

export interface FederatedIdPPort {
  authorizationUrl(provider: FederatedProvider, input: { state: string; nonce: string; redirectUri: string }): Promise<FederatedAuthorization>;
  /** Exchanges the authorization code; verifies the id_token nonce. */
  exchangeCode(provider: FederatedProvider, input: { code: string; nonce: string; redirectUri: string }): Promise<FederatedIdentity>;
  /**
   * Verifies an identity token the app already holds (native Sign in with Apple / Google): signature against the
   * provider's keys, issuer, audience (our client id), expiry and the nonce the app sent. Throws INVALID_CODE for a
   * token that is bad, expired or for another audience, NONCE_MISMATCH for a wrong nonce (T-0691).
   */
  verifyIdentityToken(provider: FederatedProvider, input: { idToken: string; nonce: string }): Promise<FederatedIdentity>;
  /** Apple requires calling the revoke endpoint on account deletion (REQ-AUTH-005). Idempotent. */
  revoke(provider: FederatedProvider, refreshToken: string, idempotencyKey: string): Promise<{ revoked: true; auditRef: string }>;
}

export type FederatedIdPErrorCode = 'INVALID_CODE' | 'NONCE_MISMATCH' | 'UNSUPPORTED_PROVIDER' | 'PROVIDER_UNAVAILABLE';

export class FederatedIdPError extends Error {
  readonly code: FederatedIdPErrorCode;
  constructor(
    code: FederatedIdPErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'FederatedIdPError';
  }
}
