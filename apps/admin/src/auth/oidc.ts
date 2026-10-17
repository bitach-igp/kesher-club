// OIDC authorization-code helpers for the Identity Center sign-in (T-0116). Pure over an injected fetch.

export interface OidcDiscovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

export const STATE_COOKIE = 'kesher_admin_oidc_state';
export const NONCE_COOKIE = 'kesher_admin_oidc_nonce';
export const RETURN_TO_COOKIE = 'kesher_admin_return_to';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function discover(issuer: string, fetchFn: FetchLike = fetch): Promise<OidcDiscovery> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetchFn(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('OIDC discovery document incomplete');
  return { authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint, jwks_uri: doc.jwks_uri };
}

export interface AuthorizationRequest {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly scopes?: readonly string[];
}

export function authorizationUrl(req: AuthorizationRequest): string {
  const url = new URL(req.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', req.clientId);
  url.searchParams.set('redirect_uri', req.redirectUri);
  url.searchParams.set('scope', (req.scopes ?? ['openid', 'email', 'profile']).join(' '));
  url.searchParams.set('state', req.state);
  url.searchParams.set('nonce', req.nonce);
  // Ask the IdP for a phishing-resistant authenticator up front; the session check enforces it anyway.
  url.searchParams.set('acr_values', 'phrh');
  return url.toString();
}

export interface CodeExchange {
  readonly tokenEndpoint: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Exchanges the code for tokens. Returns only the ID token; nothing is logged (Tab 3 §8). */
export async function exchangeCode(x: CodeExchange, fetchFn: FetchLike = fetch): Promise<{ idToken: string }> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: x.code, redirect_uri: x.redirectUri, client_id: x.clientId, client_secret: x.clientSecret });
  const res = await fetchFn(x.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== 'string') throw new Error('Token response has no id_token');
  return { idToken: json.id_token };
}

export const randomToken = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};
