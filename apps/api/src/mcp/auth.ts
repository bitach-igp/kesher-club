// Token validation for /mcp (T-1002, REQ-AGT-002, REQ-AGT-005): audience-bound JWTs from the
// authorization server, scope tiers, and the grant's live status (revocation effective within
// 60 s because this reads the grant row on every call, never a cache older than that).
import { jwtVerify, type CryptoKey, type JWK, type JWTPayload, createLocalJWKSet } from 'jose';
import { SCOPES, type ScopeTier } from '@kesher/ports';
import type { Database } from '../db.ts';

export interface AgentPrincipal {
  grantId: string;
  clientId: string;
  partyId: string;
  scopes: readonly string[];
  /** Covered members (the grant's party and, for funders, their household). */
  memberPartyIds: readonly string[];
}

export type AuthResult = { ok: true; principal: AgentPrincipal } | { ok: false; reason: string };

export interface AuthServerKeys {
  /** The AS's JWKS (fetched and cached by the host; rotated keys land here). */
  jwks: { keys: JWK[] };
  issuer: string;
}

export class McpTokenValidator {
  private readonly getKey: ReturnType<typeof createLocalJWKSet>;

  private readonly db: Database;
  private readonly resource: string;
  constructor(
    db: Database,
    keys: AuthServerKeys | { key: CryptoKey; issuer: string },
    resource: string,
  ) {
    this.db = db;
    this.resource = resource;
    this.issuer = keys.issuer;
    this.getKey = 'jwks' in keys ? createLocalJWKSet(keys.jwks) : ((async () => keys.key) as unknown as ReturnType<typeof createLocalJWKSet>);
  }
  private readonly issuer: string;

  async validate(authorization: string | undefined, now: Date): Promise<AuthResult> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m) return { ok: false, reason: 'missing bearer token' };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(m[1]!, this.getKey, { issuer: this.issuer, audience: this.resource, algorithms: ['ES256', 'EdDSA'], currentDate: now, clockTolerance: 5 }));
    } catch (e) {
      return { ok: false, reason: `token rejected: ${(e as Error).name}` };
    }
    const grantId = typeof payload['grant_id'] === 'string' ? payload['grant_id'] : undefined;
    const clientId = typeof payload['client_id'] === 'string' ? payload['client_id'] : undefined;
    if (!grantId || !clientId || !payload.sub) return { ok: false, reason: 'token lacks grant_id, client_id or sub' };
    const scopes = String(payload['scope'] ?? '').split(/\s+/).filter(Boolean);
    const grant = await this.db.query<{ status: string; scopes: string[]; party_id: string; client_id: string; client_status: string }>(
      'select g.status, g.scopes, g.party_id, g.client_id, c.status as client_status from agent.grant g join agent.client c on c.client_id = g.client_id where g.id = $1',
      [grantId],
    );
    const g = grant.rows[0];
    if (!g || g.status !== 'active') return { ok: false, reason: 'grant revoked or unknown' };
    if (g.client_status !== 'active') return { ok: false, reason: 'client blocked' };
    if (g.client_id !== clientId || g.party_id !== payload.sub) return { ok: false, reason: 'token does not match the grant' };
    // A token can never carry more than the grant allows.
    const effective = scopes.filter((s) => g.scopes.includes(s) && s in SCOPES);
    await this.db.query('update agent.grant set last_used_at = $2 where id = $1', [grantId, now]);
    return { ok: true, principal: { grantId, clientId, partyId: g.party_id, scopes: effective, memberPartyIds: [g.party_id] } };
  }
}

export const tierOf = (scope: string): ScopeTier | undefined => SCOPES[scope];
export const hasScope = (p: AgentPrincipal, scope: string): boolean => p.scopes.includes(scope);
