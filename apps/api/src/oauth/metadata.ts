// Authorization server metadata (T-1014, RFC 8414, ADR-009): what an assistant reads to find the endpoints.
// S256 only, public clients only (no secret), clients identified by their metadata document (REQ-AGT-003).
import { SCOPES } from '@kesher/ports';
import type { OAuthConfig } from './authorize.ts';

export function authorizationServerMetadata(cfg: Pick<OAuthConfig, 'issuer'>): Record<string, unknown> {
  const base = cfg.issuer.replace(/\/$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    jwks_uri: `${base}/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    scopes_supported: Object.keys(SCOPES),
  };
}
