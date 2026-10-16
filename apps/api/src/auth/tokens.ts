// Token service (T-0112, REQ-AUTH-007): ES256 access JWTs that live 10 minutes, opaque refresh
// tokens that rotate on every use and live 30 days, each bound to a device-session family. A
// refresh token that was already rotated, or presented from another device, revokes the family.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '@kesher/domain';
import { fixedClock, type Clock } from '@kesher/ports';
import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify, type CryptoKey, type JWK } from 'jose';
import type { Principal } from '../http.ts';
import type { IdentityRepository, SessionFamily } from './repository.ts';

export const ACCESS_TTL_MS = 10 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 3_600_000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  restrictedUntil?: string;
}

export interface SigningKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
}

/** For tests and local dev. Production loads the private key from Secrets Manager (T-0004 config). */
export async function generateSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { privateKey, publicKey, kid: randomUUID() };
}

export async function importSigningKey(privateJwk: JWK, kid: string): Promise<SigningKey> {
  const privateKey = (await importJWK(privateJwk, 'ES256')) as CryptoKey;
  const { d: _d, ...pub } = privateJwk;
  const publicKey = (await importJWK(pub, 'ES256')) as CryptoKey;
  return { privateKey, publicKey, kid };
}

export interface TokenServiceOptions {
  issuer: string;
  audience: string;
  clock?: Clock;
}

export class TokenService {
  private readonly clock: Clock;
  constructor(
    private readonly repo: IdentityRepository,
    private readonly key: SigningKey,
    private readonly opts: TokenServiceOptions,
  ) {
    this.clock = opts.clock ?? fixedClock(new Date().toISOString());
  }

  /** Public JWKS for the API's verifiers (and for the MCP resource server, which has its own audience). */
  async jwks(): Promise<{ keys: JWK[] }> {
    const jwk = await exportJWK(this.key.publicKey);
    return { keys: [{ ...jwk, kid: this.key.kid, use: 'sig', alg: 'ES256' }] };
  }

  async issue(input: { partyId: string; deviceId: string; roles: readonly string[] }): Promise<TokenPair> {
    const now = this.clock.now();
    const refresh = newRefreshToken();
    const session: SessionFamily = {
      sessionId: randomUUID(),
      partyId: input.partyId,
      deviceId: input.deviceId,
      roles: input.roles,
      currentRefreshHash: hash(refresh),
      rotatedHashes: [],
      createdAt: now.toISOString(),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS).toISOString(),
    };
    await this.repo.createSession(session);
    return this.pair(session, refresh);
  }

  async refresh(refreshToken: string, deviceId: string): Promise<TokenPair> {
    const now = this.clock.now();
    const found = await this.repo.findSessionByRefreshHash(hash(refreshToken));
    if (!found) throw new DomainError('UNAUTHENTICATED', 'Unknown refresh token');
    const { session, isCurrent } = found;
    if (session.revokedAt) throw new DomainError('UNAUTHENTICATED', 'Session revoked');
    if (!isCurrent) {
      await this.repo.revokeSession(session.sessionId, 'refresh_token_reuse', now.toISOString());
      throw new DomainError('UNAUTHENTICATED', 'Refresh token reuse detected; device signed out');
    }
    if (session.deviceId !== deviceId) {
      await this.repo.revokeSession(session.sessionId, 'device_mismatch', now.toISOString());
      throw new DomainError('UNAUTHENTICATED', 'Refresh token presented from another device; device signed out');
    }
    if (Date.parse(session.refreshExpiresAt) <= now.getTime()) {
      await this.repo.revokeSession(session.sessionId, 'expired', now.toISOString());
      throw new DomainError('UNAUTHENTICATED', 'Refresh token expired');
    }
    const next = newRefreshToken();
    await this.repo.rotateSession(session.sessionId, hash(next), session.currentRefreshHash);
    return this.pair({ ...session, currentRefreshHash: hash(next) }, next);
  }

  async verifyAccess(token: string): Promise<Principal> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key.publicKey, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        algorithms: ['ES256'],
        currentDate: this.clock.now(),
        clockTolerance: 0,
      }));
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Invalid or expired access token');
    }
    const sessionId = String(payload['sid'] ?? '');
    const session = await this.repo.findSession(sessionId);
    if (!session || session.revokedAt) throw new DomainError('UNAUTHENTICATED', 'Session ended');
    const roles = Array.isArray(payload['roles']) ? (payload['roles'] as string[]) : [];
    const restrictedUntil = typeof payload['restricted_until'] === 'string' ? payload['restricted_until'] : undefined;
    return { partyId: String(payload.sub), roles, sessionId, deviceId: String(payload['did']), ...(restrictedUntil ? { restrictedUntil } : {}) };
  }

  /** Ends every session of one device (used by refresh reuse, "not you? lock", and recovery). */
  async revokeDevice(partyId: string, deviceId: string, reason = 'revoked'): Promise<number> {
    const at = this.clock.now().toISOString();
    let n = 0;
    for (const s of await this.repo.listSessions(partyId)) {
      if (s.deviceId === deviceId && !s.revokedAt) {
        await this.repo.revokeSession(s.sessionId, reason, at);
        n += 1;
      }
    }
    return n;
  }

  async revokeAll(partyId: string, reason: string): Promise<number> {
    const at = this.clock.now().toISOString();
    let n = 0;
    for (const s of await this.repo.listSessions(partyId)) {
      if (!s.revokedAt) {
        await this.repo.revokeSession(s.sessionId, reason, at);
        n += 1;
      }
    }
    return n;
  }

  private async pair(session: SessionFamily, refreshToken: string): Promise<TokenPair> {
    const now = this.clock.now();
    const exp = new Date(now.getTime() + ACCESS_TTL_MS);
    const restriction = await this.repo.getRestriction(session.partyId);
    const restrictedUntil = restriction && Date.parse(restriction.until) > now.getTime() ? restriction.until : undefined;
    const jwt = new SignJWT({ sid: session.sessionId, did: session.deviceId, roles: [...session.roles], ...(restrictedUntil ? { restricted_until: restrictedUntil } : {}) })
      .setProtectedHeader({ alg: 'ES256', kid: this.key.kid, typ: 'at+jwt' })
      .setSubject(session.partyId)
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(exp.getTime() / 1000))
      .setJti(randomUUID());
    return { accessToken: await jwt.sign(this.key.privateKey), refreshToken, accessExpiresAt: exp.toISOString(), ...(restrictedUntil ? { restrictedUntil } : {}) };
  }
}

const newRefreshToken = (): string => `rt_${randomBytes(32).toString('base64url')}`;
const hash = (token: string): string => createHash('sha256').update(token).digest('base64url');
