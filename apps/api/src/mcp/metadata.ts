// Protected Resource Metadata (T-1001, REQ-AGT-001, RFC 9728): /mcp is an OAuth 2.1 resource
// server. Unauthenticated calls get 401 with WWW-Authenticate pointing at the metadata document.
import { challengeHeader, SCOPES, type ProtectedResourceMetadata } from '@kesher/ports';
import { ok, route, type Handler } from '../http.ts';

export interface McpConfig {
  /** The resource identifier tokens must be bound to (RFC 8707), e.g. https://api.kesher.example/mcp */
  resource: string;
  /** Authorization server(s) issuing tokens for this audience (ADR-009). */
  authorizationServers: readonly string[];
}

export const metadataUrl = (resource: string): string => {
  const u = new URL(resource);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`;
};

export function protectedResourceMetadata(cfg: McpConfig): ProtectedResourceMetadata {
  return { resource: cfg.resource, authorization_servers: [...cfg.authorizationServers], scopes_supported: Object.keys(SCOPES), bearer_methods_supported: ['header'] };
}

/** GET /.well-known/oauth-protected-resource/mcp */
export const metadataHandler = (cfg: McpConfig): Handler => route(async () => ({ status: 200, body: protectedResourceMetadata(cfg), headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } }));

export const unauthorizedChallenge = (cfg: McpConfig, description?: string): string => challengeHeader(metadataUrl(cfg.resource), { error: 'invalid_token', ...(description ? { description } : {}) });
export const insufficientScopeChallenge = (cfg: McpConfig, scope: string): string => challengeHeader(metadataUrl(cfg.resource), { error: 'insufficient_scope', scope });

export { ok };
