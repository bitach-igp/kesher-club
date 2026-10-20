// A standards-shaped OpenID Connect issuer for the local console (T-0919). The console keeps its full
// Identity Center path (discovery, authorization code, token, JWKS); locally this answers it. Served by
// the simulator panel under /oidc:
//   GET  /.well-known/openid-configuration   discovery
//   GET  /authorize                          a persona picker where a password form would be
//   GET  /authorize/choose                   issues a one-time code for the picked persona
//   POST /token                              code → ES256 ID token (client_secret_post, or PKCE S256)
//   GET  /jwks                               the public signing key
// The signing key is generated at start and held in memory. Staff personas are fixed; each ID token says
// `amr: ["hwk"]`, the hardware key Identity Center would require. Redirects go to this machine only, and
// the issuer answers only to a loopback Host, so it cannot stand in for an identity provider elsewhere.
import { webcrypto as crypto } from 'node:crypto';

export interface StaffPersona {
  sub: string;
  name: string;
  email: string;
  roles: readonly string[];
}

/** Fictional staff: one per console role, and a second admin for two-person flips. */
export const STAFF_PERSONAS: readonly StaffPersona[] = [
  { sub: 'staff-support-1', name: 'Sam Support', email: 'sam.support@example.test', roles: ['support'] },
  { sub: 'staff-compliance-1', name: 'Cleo Compliance', email: 'cleo.compliance@example.test', roles: ['compliance'] },
  { sub: 'staff-finance-1', name: 'Finn Finance', email: 'finn.finance@example.test', roles: ['finance'] },
  { sub: 'staff-admin-1', name: 'Ada Admin', email: 'ada.admin@example.test', roles: ['admin'] },
  { sub: 'staff-admin-2', name: 'Abe Admin', email: 'abe.admin@example.test', roles: ['admin'] },
];

/** The local console's client. Not a secret: this issuer exists only on a developer's machine. */
export const LOCAL_CLIENT = { id: 'kesher-admin-local', secret: 'local-simulator-client' } as const;

export interface OidcResponse {
  status: number;
  body: string;
  contentType: string;
  headers?: Record<string, string>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string | undefined;
  persona: StaffPersona;
  challenge: string | undefined;
  issuer: string;
  expiresAt: number;
  used: boolean;
}

const CODE_TTL_MS = 60_000;
const ID_TOKEN_TTL_S = 3600;
const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/;

const b64u = (b: Uint8Array | string): string => Buffer.from(b).toString('base64url');
const json = (status: number, body: unknown, headers?: Record<string, string>): OidcResponse => ({ status, body: JSON.stringify(body), contentType: 'application/json; charset=utf-8', ...(headers ? { headers } : {}) });
const oauthError = (error: string, description: string): OidcResponse => json(400, { error, error_description: description });
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Only redirects back to this machine: the issuer must never send a code anywhere else. */
const loopbackRedirect = (raw: string | null): URL | undefined => {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOST.test(u.host) ? u : undefined;
  } catch {
    return undefined;
  }
};

export class OidcIssuer {
  private readonly codes = new Map<string, PendingCode>();
  private readonly clients: ReadonlyMap<string, string>;
  private readonly now: () => number;
  private readonly kid: string;
  private readonly privateKey: CryptoKey;
  private readonly publicJwk: JsonWebKey;

  private constructor(keys: { kid: string; privateKey: CryptoKey; publicJwk: JsonWebKey }, clients: ReadonlyMap<string, string>, now: () => number) {
    this.kid = keys.kid;
    this.privateKey = keys.privateKey;
    this.publicJwk = keys.publicJwk;
    this.clients = clients;
    this.now = now;
  }

  static async create(opts: { clients?: Readonly<Record<string, string>>; now?: () => number } = {}): Promise<OidcIssuer> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { kty: string; crv: string; x: string; y: string };
    const kid = `sim-${b64u(crypto.getRandomValues(new Uint8Array(6)))}`;
    return new OidcIssuer({ kid, privateKey: pair.privateKey, publicJwk: { kty, crv, x, y } }, new Map(Object.entries(opts.clients ?? { [LOCAL_CLIENT.id]: LOCAL_CLIENT.secret })), opts.now ?? Date.now);
  }

  /** `path` is below /oidc; `host` is the request's Host header, which names the issuer. */
  async handle(method: string, path: string, query: URLSearchParams, rawBody: string, host: string | undefined): Promise<OidcResponse> {
    if (!host || !LOOPBACK_HOST.test(host)) return oauthError('invalid_request', 'the simulator issuer answers on this machine only');
    const issuer = `http://${host}/oidc`;
    if (method === 'GET' && path === '/.well-known/openid-configuration') return json(200, this.discovery(issuer));
    if (method === 'GET' && path === '/jwks') return json(200, { keys: [{ ...this.publicJwk, kid: this.kid, alg: 'ES256', use: 'sig' }] });
    if (method === 'GET' && path === '/authorize') return this.authorize(query, issuer, false);
    if (method === 'GET' && path === '/authorize/choose') return this.authorize(query, issuer, true);
    if (method === 'POST' && path === '/token') return this.token(new URLSearchParams(rawBody));
    return json(404, { error: 'not_found' });
  }

  private discovery(issuer: string) {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'email', 'profile'],
      claims_supported: ['sub', 'name', 'email', 'roles', 'amr', 'acr', 'nonce'],
    };
  }

  private authorize(q: URLSearchParams, issuer: string, chosen: boolean): OidcResponse {
    const clientId = q.get('client_id') ?? '';
    const redirect = loopbackRedirect(q.get('redirect_uri'));
    if (!this.clients.has(clientId)) return oauthError('unauthorized_client', 'unknown client_id');
    if (!redirect) return oauthError('invalid_request', 'redirect_uri must be an http(s) URL on this machine');
    if (q.get('response_type') !== 'code') return oauthError('unsupported_response_type', 'only code');
    const challengeMethod = q.get('code_challenge_method');
    if (q.get('code_challenge') && challengeMethod !== 'S256') return oauthError('invalid_request', 'code_challenge_method must be S256');

    if (!chosen) return { status: 200, contentType: 'text/html; charset=utf-8', body: this.picker(q) };
    const persona = STAFF_PERSONAS.find((p) => p.sub === q.get('persona'));
    if (!persona) return oauthError('invalid_request', 'unknown persona');
    const code = b64u(crypto.getRandomValues(new Uint8Array(24)));
    this.codes.set(code, { clientId, redirectUri: redirect.href, nonce: q.get('nonce') ?? undefined, persona, challenge: q.get('code_challenge') ?? undefined, issuer, expiresAt: this.now() + CODE_TTL_MS, used: false });
    redirect.searchParams.set('code', code);
    const state = q.get('state');
    if (state) redirect.searchParams.set('state', state);
    return { status: 302, contentType: 'text/plain; charset=utf-8', body: '', headers: { location: redirect.href } };
  }

  private picker(q: URLSearchParams): string {
    const rows = STAFF_PERSONAS.map((p) => {
      const link = new URLSearchParams(q);
      link.set('persona', p.sub);
      return `<li><a href="/oidc/authorize/choose?${esc(link.toString())}" data-persona="${esc(p.sub)}">${esc(p.name)}</a> <small>${esc(p.roles.join(', '))} · ${esc(p.email)}</small></li>`;
    }).join('');
    return `<!doctype html><meta charset="utf-8"><title>Simulator sign-in</title><style>body{font:16px system-ui;margin:2rem;max-width:40rem}li{margin:.6rem 0}</style>
<h1>Simulator identity provider</h1><p>Local only. Pick the staff member to sign in as; the ID token says a hardware key was used.</p><ul>${rows}</ul>`;
  }

  private async token(form: URLSearchParams): Promise<OidcResponse> {
    if (form.get('grant_type') !== 'authorization_code') return oauthError('unsupported_grant_type', 'only authorization_code');
    const code = form.get('code') ?? '';
    const pending = this.codes.get(code);
    if (!pending) return oauthError('invalid_grant', 'unknown code');
    // A code is good once; a second use is refused and the first exchange stands.
    if (pending.used) return oauthError('invalid_grant', 'code already used');
    pending.used = true;
    if (this.now() > pending.expiresAt) return oauthError('invalid_grant', 'code expired');
    if (form.get('client_id') !== pending.clientId || form.get('redirect_uri') !== pending.redirectUri) return oauthError('invalid_grant', 'client_id or redirect_uri does not match the authorization request');
    if (pending.challenge !== undefined) {
      const verifier = form.get('code_verifier') ?? '';
      const digest = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      if (digest !== pending.challenge) return oauthError('invalid_grant', 'code_verifier does not match');
    } else if (form.get('client_secret') !== this.clients.get(pending.clientId)) {
      return oauthError('invalid_client', 'client authentication failed');
    }
    return json(200, { token_type: 'Bearer', expires_in: ID_TOKEN_TTL_S, id_token: await this.idToken(pending) }, { 'cache-control': 'no-store' });
  }

  private async idToken(p: PendingCode): Promise<string> {
    const iat = Math.floor(this.now() / 1000);
    const header = { alg: 'ES256', typ: 'JWT', kid: this.kid };
    const claims = { iss: p.issuer, sub: p.persona.sub, aud: p.clientId, iat, exp: iat + ID_TOKEN_TTL_S, name: p.persona.name, email: p.persona.email, roles: p.persona.roles, amr: ['hwk'], acr: 'phrh', ...(p.nonce ? { nonce: p.nonce } : {}) };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.privateKey, new TextEncoder().encode(input)));
    return `${input}.${b64u(signature)}`;
  }
}
