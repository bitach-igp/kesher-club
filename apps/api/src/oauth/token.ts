// The token endpoint (T-1016, REQ-AGT-011, REQ-AGT-002, ADR-009): an assistant trades the member's one-time code
// for tokens, and later a refresh token for new ones. OAuth requires a form-encoded body and JSON errors of its
// own, so this answers `{ error, error_description }` with 400, never a problem document.
// - `authorization_code`: the code is checked once, within its 60 seconds, against the client, the redirect URI
//   and the PKCE verifier (S256); a failed check burns it, and a reused one revokes its grant. It answers:
//     - an access token: ES256, 10 minutes, audience the MCP URL;
//     - a refresh token: opaque, stored as a hash, good for 30 days.
// - `refresh_token`: rotates; the old one stops working. Presenting one already rotated is taken as theft and
//   revokes the whole grant, so the next /mcp call is 401 (the validator checks the grant on every call).
// A revoked grant (the grants screen, T-1006) refreshes nothing: every exchange checks the grant is active.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { SigningKey } from '../auth/tokens.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database, SqlClient } from '../db.ts';
import { route, type Handler, type HttpResponse } from '../http.ts';
import { MCP_FLAG, type OAuthConfig } from './authorize.ts';
import { codeHash } from './consent.ts';

export const ACCESS_TTL_S = 600;
export const REFRESH_TTL_MS = 30 * 86_400_000;

type OAuthErrorCode = 'invalid_request' | 'invalid_grant' | 'unsupported_grant_type' | 'invalid_target';
export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  constructor(code: OAuthErrorCode, description: string) {
    super(description);
    this.code = code;
    this.name = 'OAuthError';
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const hash = (token: string): Buffer => createHash('sha256').update(token).digest();
const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export class TokenEndpoint {
  private readonly db: Database;
  private readonly key: SigningKey;
  private readonly cfg: OAuthConfig;
  constructor(db: Database, key: SigningKey, cfg: OAuthConfig) {
    this.db = db;
    this.key = key;
    this.cfg = cfg;
  }

  async exchange(form: Record<string, unknown>, now: Date): Promise<TokenResponse> {
    const f = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : undefined);
    switch (f('grant_type')) {
      case 'authorization_code':
        return this.code(f, now);
      case 'refresh_token':
        return this.refresh(f, now);
      default:
        throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
  }

  private async code(f: (k: string) => string | undefined, now: Date): Promise<TokenResponse> {
    const code = f('code');
    const verifier = f('code_verifier');
    if (!code || !verifier || !f('client_id') || !f('redirect_uri')) throw new OAuthError('invalid_request', 'code, code_verifier, client_id and redirect_uri are required');
    if (!VERIFIER.test(verifier)) throw new OAuthError('invalid_request', 'code_verifier must be 43 to 128 unreserved characters');
    if (f('resource') !== undefined && f('resource') !== this.cfg.resource) throw new OAuthError('invalid_target', `resource must be ${this.cfg.resource}`);
    // Every mismatch reads the same, so the client learns nothing about which part was wrong.
    const bad = (why = 'The code is invalid, expired, already used, or was issued to another client') => new OAuthError('invalid_grant', why);
    const out = await this.db.transaction(async (tx): Promise<TokenResponse | 'bad' | 'replayed'> => {
      // One use: the row leaves `approved` in the same statement that finds it. A failed check still commits
      // that, so a wrong verifier burns the code rather than leaving it for another try.
      const r = (
        await tx.query<{ client_id: string; redirect_uri: string; code_challenge: string; grant_id: string; scopes: string[]; party_id: string; code_expires_at: string | Date }>(
          `update agent.authorization_request set status = 'exchanged' where code_hash = $1 and status = 'approved'
           returning client_id, redirect_uri, code_challenge, grant_id, scopes, party_id, code_expires_at`,
          [codeHash(code)],
        )
      ).rows[0];
      if (!r) {
        // A code that was already exchanged came back: whoever holds it is not the client that first used it.
        const used = await tx.query<{ grant_id: string }>(`select grant_id from agent.authorization_request where code_hash = $1 and status = 'exchanged'`, [codeHash(code)]);
        if (!used.rows[0]) return 'bad';
        await tx.query(`update agent.grant set status = 'revoked', revoked_at = $2 where id = $1 and status = 'active'`, [used.rows[0].grant_id, now]);
        return 'replayed';
      }
      if (new Date(r.code_expires_at) <= now || r.client_id !== f('client_id') || r.redirect_uri !== f('redirect_uri') || s256(verifier) !== r.code_challenge) return 'bad';
      if (!(await this.activeGrant(tx, r.grant_id))) return 'bad';
      return this.issue(tx, { grantId: r.grant_id, clientId: r.client_id, partyId: r.party_id, scopes: r.scopes }, randomUUID(), new Date(now.getTime() + REFRESH_TTL_MS), now);
    });
    if (out === 'replayed') throw bad('The code was already used; the grant is revoked');
    if (out === 'bad') throw bad();
    return out;
  }

  private async refresh(f: (k: string) => string | undefined, now: Date): Promise<TokenResponse> {
    const token = f('refresh_token');
    if (!token || !f('client_id')) throw new OAuthError('invalid_request', 'refresh_token and client_id are required');
    const bad = (why = 'The refresh token is invalid, expired or revoked') => new OAuthError('invalid_grant', why);
    const replayed = await this.db.transaction(async (tx) => {
      const r = (
        await tx.query<{ grant_id: string; family: string; expires_at: string | Date; rotated_at: string | Date | null; client_id: string; party_id: string; scopes: string[]; status: string }>(
          `select t.grant_id, t.family, t.expires_at, t.rotated_at, g.client_id, g.party_id, g.scopes, g.status
             from agent.refresh_token t join agent.grant g on g.id = t.grant_id where t.token_hash = $1 for update of t`,
          [hash(token)],
        )
      ).rows[0];
      if (!r || r.client_id !== f('client_id')) throw bad();
      if (r.rotated_at) {
        // A token already traded in came back: someone else holds the family. The whole grant goes.
        await tx.query(`update agent.grant set status = 'revoked', revoked_at = $2 where id = $1 and status = 'active'`, [r.grant_id, now]);
        return true;
      }
      if (r.status !== 'active' || new Date(r.expires_at) <= now) throw bad();
      await tx.query('update agent.refresh_token set rotated_at = $2 where token_hash = $1', [hash(token), now]);
      return this.issue(tx, { grantId: r.grant_id, clientId: r.client_id, partyId: r.party_id, scopes: r.scopes }, r.family, new Date(r.expires_at), now);
    });
    if (replayed === true) throw bad('The refresh token was already used; the grant is revoked');
    return replayed;
  }

  private async activeGrant(tx: SqlClient, grantId: string): Promise<boolean> {
    return ((await tx.query(`select 1 from agent.grant where id = $1 and status = 'active'`, [grantId])).rowCount ?? 0) > 0;
  }

  /** An access token for the MCP audience and a fresh refresh token in the family; the family keeps its first expiry. */
  private async issue(tx: SqlClient, g: { grantId: string; clientId: string; partyId: string; scopes: string[] }, family: string, refreshExpires: Date, now: Date): Promise<TokenResponse> {
    const iat = Math.floor(now.getTime() / 1000);
    const access = await new SignJWT({ scope: g.scopes.join(' '), grant_id: g.grantId, client_id: g.clientId })
      .setProtectedHeader({ alg: 'ES256', kid: this.key.kid, typ: 'at+jwt' })
      .setIssuer(this.cfg.issuer.replace(/\/$/, ''))
      .setAudience(this.cfg.resource)
      .setSubject(g.partyId)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TTL_S)
      .sign(this.key.privateKey);
    const refresh = randomBytes(32).toString('base64url');
    await tx.query('insert into agent.refresh_token (token_hash, grant_id, family, issued_at, expires_at) values ($1, $2, $3, $4, $5)', [hash(refresh), g.grantId, family, now, refreshExpires]);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: g.scopes.join(' ') };
  }
}

/** POST /oauth/token: public (the client has no secret), form-encoded, behind `mcp.enabled`. */
export function tokenHandler(d: { endpoint: TokenEndpoint; flags: FeatureFlags }): Record<'issueAgentToken', Handler> {
  return {
    issueAgentToken: route(async (req): Promise<HttpResponse> => {
      if (!(await d.flags.isOn(MCP_FLAG))) return { status: 404, body: { error: 'invalid_request', error_description: 'Assistant access is not enabled' } };
      try {
        return { status: 200, body: await d.endpoint.exchange((req.body ?? {}) as Record<string, unknown>, req.now) };
      } catch (e) {
        if (e instanceof OAuthError) return { status: 400, body: { error: e.code, error_description: e.message } };
        throw e;
      }
    }),
  };
}
