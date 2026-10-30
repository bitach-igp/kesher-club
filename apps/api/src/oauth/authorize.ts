// The authorization request (T-1014, REQ-AGT-010, ADR-009): an assistant sends the member's browser here to ask
// for a grant. OAuth 2.1 code flow, S256 PKCE only, clients identified by their metadata document (T-1003).
// The checks run in RFC 6749's order:
// - the client and its redirect URI first: until both are known good, nothing is sent back to the client, and
//   the error stops here as 422 VALIDATION_FAILED;
// - then every other fault goes back to the client's redirect URI with the error and the state;
// - a good request is stored for 10 minutes and the browser goes to the member app's consent screen (T-1017).
// Nothing here identifies the member: they sign in and consent in the app (T-1015).
import { DomainError, uuidv7 } from '@kesher/domain';
import { SCOPES } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import { route, type Handler } from '../http.ts';
import type { CimdRegistry } from '../mcp/cimd.ts';
import { authorizationServerMetadata } from './metadata.ts';

export const MCP_FLAG = 'mcp.enabled';

export const REQUEST_TTL_MS = 10 * 60_000;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE_MAX = 512;

export interface OAuthConfig {
  /** The token issuer, e.g. https://api.kesher.example; the endpoints hang off it. */
  issuer: string;
  /** The one resource tokens are issued for (RFC 8707): the MCP URL. */
  resource: string;
  /** Where the member app's consent screen lives; the request id is appended, e.g. https://app.kesher.example/connect. */
  consentUrl: string;
}

export type AuthorizeOutcome = { redirect: string };

/** An error the client is told about at its own redirect URI (RFC 6749 §4.1.2.1, RFC 8707 §2). */
const back = (redirectUri: string, state: string | undefined, error: 'invalid_request' | 'unsupported_response_type' | 'invalid_scope' | 'invalid_target', description: string): AuthorizeOutcome => {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state !== undefined) u.searchParams.set('state', state);
  return { redirect: u.href };
};

export class AuthorizeService {
  private readonly db: Database;
  private readonly cimd: Pick<CimdRegistry, 'register'>;
  private readonly cfg: OAuthConfig;
  constructor(db: Database, cimd: Pick<CimdRegistry, 'register'>, cfg: OAuthConfig) {
    this.db = db;
    this.cimd = cimd;
    this.cfg = cfg;
  }

  async request(q: Record<string, string | undefined>, now: Date): Promise<AuthorizeOutcome> {
    const clientId = q['client_id'];
    if (!clientId) throw new DomainError('VALIDATION_FAILED', 'client_id is required');
    // The registry's SSRF guard refuses private hosts, http, redirects and oversized documents (REQ-AGT-003).
    const client = await this.cimd.register(clientId).catch((e: unknown) => {
      throw e instanceof DomainError ? new DomainError('VALIDATION_FAILED', `The client could not be verified: ${e.message}`) : e;
    });
    const redirectUri = q['redirect_uri'];
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) throw new DomainError('VALIDATION_FAILED', 'redirect_uri must exactly match one in the client metadata document');

    const state = q['state'];
    if (!state || state.length > STATE_MAX) return back(redirectUri, undefined, 'invalid_request', 'state is required, up to 512 characters');
    if (q['response_type'] !== 'code') return back(redirectUri, state, 'unsupported_response_type', 'only response_type=code');
    if (q['code_challenge_method'] !== 'S256' || !CHALLENGE.test(q['code_challenge'] ?? '')) return back(redirectUri, state, 'invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (q['resource'] !== this.cfg.resource) return back(redirectUri, state, 'invalid_target', `resource must be ${this.cfg.resource}`);
    const scopes = [...new Set((q['scope'] ?? '').split(' ').filter(Boolean))];
    if (!scopes.length || !scopes.every((s) => s in SCOPES)) return back(redirectUri, state, 'invalid_scope', `scope must name one or more of: ${Object.keys(SCOPES).join(' ')}`);

    const id = uuidv7(now);
    await this.db.query(
      `insert into agent.authorization_request (id, client_id, redirect_uri, scopes, state, code_challenge, resource, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, client.client_id, redirectUri, scopes, state, q['code_challenge'], this.cfg.resource, now, new Date(now.getTime() + REQUEST_TTL_MS)],
    );
    return { redirect: `${this.cfg.consentUrl.replace(/\/$/, '')}/${id}` };
  }
}

/**
 * The authorization server's public face: discovery, the signing key, and the authorization request. All three
 * answer only while `mcp.enabled` is on; off, they are 404 like /mcp itself.
 */
export function oauthHandlers(d: { authorize: AuthorizeService; cfg: OAuthConfig; jwks: () => Promise<{ keys: unknown[] }>; flags: FeatureFlags }): Record<'getAuthorizationServerMetadata' | 'getOAuthJwks' | 'authorizeAgent', Handler> {
  const gate = async () => {
    if (!(await d.flags.isOn(MCP_FLAG))) throw new DomainError('FEATURE_OFF', 'Assistant access is not enabled');
  };
  return {
    getAuthorizationServerMetadata: route(async () => {
      await gate();
      return { status: 200, body: authorizationServerMetadata(d.cfg), headers: { 'cache-control': 'public, max-age=3600' } };
    }),
    getOAuthJwks: route(async () => {
      await gate();
      return { status: 200, body: await d.jwks(), headers: { 'cache-control': 'public, max-age=3600' } };
    }),
    authorizeAgent: route(async (req) => {
      await gate();
      const { redirect } = await d.authorize.request(req.query, req.now);
      return { status: 302, headers: { location: redirect } };
    }),
  };
}
