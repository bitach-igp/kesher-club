// Staff token the console presents to the API (T-0906, ADR-013): 5 minutes, ES256, signed with the
// console's own key, aud kesher-api:admin, sub = the Identity Center subject, roles from the SSO
// session. The API holds only the public JWKS; nothing here ever sees a member token.
import { importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';

export const STAFF_AUDIENCE = 'kesher-api:admin';
export const STAFF_ISSUER = 'kesher-admin';
export const STAFF_TOKEN_TTL_MS = 5 * 60_000;

export interface StaffSigner {
  sign(actor: { subject: string; roles: readonly string[] }, now?: Date): Promise<string>;
}

export async function staffSigner(privateJwk: JWK, kid: string): Promise<StaffSigner> {
  const key = (await importJWK(privateJwk, 'ES256')) as CryptoKey;
  return {
    async sign(actor, now = new Date()) {
      const iat = Math.floor(now.getTime() / 1000);
      return new SignJWT({ roles: [...actor.roles] })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setIssuer(STAFF_ISSUER)
        .setAudience(STAFF_AUDIENCE)
        .setSubject(actor.subject)
        .setIssuedAt(iat)
        .setExpirationTime(iat + STAFF_TOKEN_TTL_MS / 1000)
        .sign(key);
    },
  };
}
