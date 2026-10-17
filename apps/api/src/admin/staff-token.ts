// Staff identity for /admin/* (T-0906, ADR-013). The admin console's server side signs a 5-minute
// ES256 JWT with its own key: iss kesher-admin, aud kesher-api:admin, sub = the Identity Center
// subject, roles from the SSO session. The API verifies it against the console's public JWKS and
// never accepts a member or agent token on an admin route (nor a staff token elsewhere).
import { createHash } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, jwtVerify, type JWK } from 'jose';
import { DomainError } from '@kesher/domain';
import type { Clock } from '@kesher/ports';
import type { HttpRequest, Principal } from '../http.ts';

export const STAFF_AUDIENCE = 'kesher-api:admin';
export const STAFF_ISSUER = 'kesher-admin';
export const STAFF_TOKEN_TTL_MS = 5 * 60_000;

/**
 * Approval and audit rows key actors by uuid, and Identity Center subjects are not uuids, so a
 * staff member gets a stable uuid derived from the subject (version nibble 8, variant 10). The
 * subject itself travels in the principal for display and audit payloads.
 */
export function staffPartyId(subject: string): string {
  const h = createHash('sha256').update(`kesher-staff:${subject}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface StaffVerifierOptions {
  jwks: readonly JWK[];
  clock: Clock;
}

/** True when the bearer claims the staff audience; decides which verifier runs, proves nothing. */
export function looksLikeStaffToken(token: string): boolean {
  try {
    const aud = decodeJwt(token).aud;
    return aud === STAFF_AUDIENCE || (Array.isArray(aud) && aud.includes(STAFF_AUDIENCE));
  } catch {
    return false;
  }
}

export class StaffTokenVerifier {
  private readonly keys: ReturnType<typeof createLocalJWKSet>;

  constructor(private readonly opts: StaffVerifierOptions) {
    if (opts.jwks.length === 0) throw new Error('Staff JWKS is empty');
    this.keys = createLocalJWKSet({ keys: [...opts.jwks] });
  }

  async verify(token: string): Promise<Principal> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, { issuer: STAFF_ISSUER, audience: STAFF_AUDIENCE, algorithms: ['ES256'], currentDate: this.opts.clock.now(), clockTolerance: 0, maxTokenAge: `${STAFF_TOKEN_TTL_MS / 1000}s` }));
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Invalid or expired staff token');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) throw new DomainError('UNAUTHENTICATED', 'Staff token has no subject');
    const roles = Array.isArray(payload['roles']) ? (payload['roles'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
    return { kind: 'staff', partyId: staffPartyId(payload.sub), subject: payload.sub, roles: ['admin', ...roles.filter((r) => r !== 'admin')], sessionId: typeof payload['sid'] === 'string' ? payload['sid'] : `staff:${payload.sub}`, deviceId: 'admin-console' };
  }
}

/** Middleware step: a staff bearer becomes a staff principal; anything else passes through untouched. */
export function staffBearerMiddleware(verifier: StaffTokenVerifier | undefined) {
  return async (req: HttpRequest): Promise<HttpRequest> => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers['authorization'] ?? '');
    if (!m || !looksLikeStaffToken(m[1]!)) return req;
    if (!verifier) throw new DomainError('UNAUTHENTICATED', 'Staff access is not configured on this API');
    return { ...req, principal: await verifier.verify(m[1]!) };
  };
}

/** The staff principal, or FORBIDDEN for members and agents, UNAUTHENTICATED without a token. */
export function requireStaff(req: HttpRequest, ...roles: string[]): Principal {
  const p = req.principal;
  if (!p) throw new DomainError('UNAUTHENTICATED', 'Staff sign-in required');
  if (p.kind !== 'staff') throw new DomainError('FORBIDDEN', 'Admin operations need a staff session');
  if (roles.length && !roles.some((r) => p.roles.includes(r))) throw new DomainError('FORBIDDEN', `Needs one of: ${roles.join(', ')}`);
  return p;
}

/** The actor shape the approval, flag and audit services take. */
export const staffActor = (p: Principal): { partyId: string; role: string } => ({ partyId: p.partyId, role: 'admin' });
