// Admin SSO session (T-0116, REQ-AUTH-009): the session cookie carries the ES256 ID token issued by
// IAM Identity Center. It is verified with an injected JWKS so this module stays pure and testable.
import { errors, jwtVerify, type CryptoKey, type JWTVerifyGetKey } from 'jose';

export const SESSION_COOKIE = 'kesher_admin_session';

/** AMR values that count as phishing-resistant (RFC 8176): hardware key, FIDO, WebAuthn. */
export const PHISHING_RESISTANT_AMR: ReadonlySet<string> = new Set(['hwk', 'fido', 'webauthn']);

export interface AdminSession {
  readonly subject: string;
  readonly email: string | undefined;
  readonly name: string | undefined;
  readonly roles: readonly string[];
  readonly amr: readonly string[];
  readonly expiresAt: Date;
}

export type SessionFailure = 'invalid' | 'expired' | 'hardware_key_required';

export type SessionVerdict = { readonly ok: true; readonly session: AdminSession } | { readonly ok: false; readonly reason: SessionFailure };

export interface SessionVerifier {
  /** A JWKS resolver (createRemoteJWKSet / createLocalJWKSet) or a public key. */
  readonly jwks: JWTVerifyGetKey | CryptoKey;
  readonly issuer: string;
  readonly audience: string;
  /** Expected nonce from the authorization request, when verifying a fresh ID token. */
  readonly nonce?: string;
  readonly now?: Date;
}

/**
 * True when `amr` proves a phishing-resistant authenticator: `hwk`, `fido` or `webauthn`,
 * or a software key (`swk`) that was exercised through FIDO.
 */
export function isPhishingResistant(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false;
  const methods = new Set(amr.filter((m): m is string => typeof m === 'string'));
  for (const m of methods) if (PHISHING_RESISTANT_AMR.has(m)) return true;
  return methods.has('swk') && methods.has('fido');
}

const stringList = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function verifySession(token: string | undefined, verifier: SessionVerifier): Promise<SessionVerdict> {
  if (!token) return { ok: false, reason: 'invalid' };
  try {
    const { payload } = await jwtVerify(token, verifier.jwks as JWTVerifyGetKey, {
      issuer: verifier.issuer,
      audience: verifier.audience,
      algorithms: ['ES256'],
      ...(verifier.now ? { currentDate: verifier.now } : {}),
    });
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return { ok: false, reason: 'invalid' };
    if (verifier.nonce !== undefined && payload['nonce'] !== verifier.nonce) return { ok: false, reason: 'invalid' };
    if (!isPhishingResistant(payload['amr'])) return { ok: false, reason: 'hardware_key_required' };
    return {
      ok: true,
      session: {
        subject: payload.sub,
        email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
        name: typeof payload['name'] === 'string' ? payload['name'] : undefined,
        roles: stringList(payload['roles'] ?? payload['groups']),
        amr: stringList(payload['amr']),
        expiresAt: new Date(payload.exp * 1000),
      },
    };
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}
