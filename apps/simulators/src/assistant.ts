// A demo assistant for the local stack (T-1017, ADR-009): an OAuth client of Kesher's MCP authorization server,
// so the demo can connect a persona end to end and an assistant can then call /mcp (T-1013, REC-09).
// - Its Client ID Metadata Document names one redirect URI, on this panel.
// - `start` makes a PKCE verifier and a state, remembers both, and answers the authorization URL.
// - `callback` checks the state, trades the code at the token endpoint and keeps the tokens in memory.
// Nothing here prints a token: the page says what was granted, and only the process holding the panel can ask
// for the access token. Local only: the client id sits on a reserved .test host, which the demo answers
// in-process; nothing resolves it on a real network.
import { createHash, randomBytes } from 'node:crypto';

export const DEMO_ASSISTANT_HOST = 'assistant.kesher.test';
export const DEMO_ASSISTANT_CLIENT_ID = `https://${DEMO_ASSISTANT_HOST}/client.json`;
export const DEMO_ASSISTANT_SCOPE = 'balances:read transactions:read card:status:read p2p:propose';

export interface DemoAssistantOptions {
  /** Where the API answers, e.g. http://localhost:3000: the authorization and token endpoints. */
  apiUrl: () => string;
  /** The API's token issuer, when it differs from where it answers (a test on a random port): the MCP resource is {issuer}/mcp. */
  issuer?: () => string;
  /** This panel's base, e.g. http://localhost:4010; the redirect URI hangs off it. */
  panelUrl: () => string;
  fetch?: typeof fetch;
}

type Tokens = { access: string; refresh: string; scope: string };

export class DemoAssistant {
  private readonly o: DemoAssistantOptions;
  private readonly pending = new Map<string, string>();
  private tokens: Tokens | undefined;
  constructor(o: DemoAssistantOptions) {
    this.o = o;
  }

  private resource(): string {
    return `${(this.o.issuer ?? this.o.apiUrl)().replace(/\/$/, '')}/mcp`;
  }

  redirectUri(): string {
    return `${this.o.panelUrl().replace(/\/$/, '')}/assistant/callback`;
  }

  /** The Client ID Metadata Document Kesher fetches (T-1003): public client, one redirect URI. */
  document(): Record<string, unknown> {
    return { client_id: DEMO_ASSISTANT_CLIENT_ID, client_name: 'Demo Assistant', client_uri: `https://${DEMO_ASSISTANT_HOST}`, redirect_uris: [this.redirectUri()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }

  /** The authorization URL, with a fresh PKCE pair and state. */
  start(scope = DEMO_ASSISTANT_SCOPE): string {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    this.pending.set(state, verifier);
    const api = this.o.apiUrl().replace(/\/$/, '');
    const q = new URLSearchParams({ response_type: 'code', client_id: DEMO_ASSISTANT_CLIENT_ID, redirect_uri: this.redirectUri(), state, scope, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: this.resource() });
    return `${api}/oauth/authorize?${q}`;
  }

  /** The redirect back: an error, or a code to trade. Answers what to show, never a token. */
  async callback(params: URLSearchParams): Promise<{ ok: boolean; message: string }> {
    const state = params.get('state') ?? '';
    const verifier = this.pending.get(state);
    if (!verifier) return { ok: false, message: 'Unknown or already used state: start again.' };
    this.pending.delete(state);
    const error = params.get('error');
    if (error) return { ok: false, message: `The member did not connect (${error}).` };
    const api = this.o.apiUrl().replace(/\/$/, '');
    const res = await (this.o.fetch ?? fetch)(`${api}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code') ?? '', code_verifier: verifier, client_id: DEMO_ASSISTANT_CLIENT_ID, redirect_uri: this.redirectUri(), resource: this.resource() }).toString(),
    });
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
    if (!res.ok || !body.access_token || !body.refresh_token) return { ok: false, message: `The token exchange failed (${body.error ?? res.status}).` };
    this.tokens = { access: body.access_token, refresh: body.refresh_token, scope: body.scope ?? '' };
    return { ok: true, message: `Connected. Granted: ${this.tokens.scope}.` };
  }

  status(): { connected: boolean; scope?: string } {
    return this.tokens ? { connected: true, scope: this.tokens.scope } : { connected: false };
  }

  /** For the hosting process only (a recording calling /mcp, T-1013); the panel never serves it. */
  accessToken(): string | undefined {
    return this.tokens?.access;
  }
}

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The panel's /assistant routes: the document, start (302), the callback page, and the status. */
export async function assistantRoute(a: DemoAssistant, method: string, path: string, query: URLSearchParams): Promise<{ status: number; body: unknown; contentType?: string; headers?: Record<string, string> } | undefined> {
  if (method !== 'GET') return undefined;
  if (path === '/client.json') return { status: 200, body: a.document() };
  if (path === '/start') return { status: 302, body: '', headers: { location: a.start(query.get('scope') ?? undefined) } };
  if (path === '/status') return { status: 200, body: a.status() };
  if (path === '/callback') {
    const r = await a.callback(query);
    return { status: r.ok ? 200 : 400, body: `<!doctype html><meta charset="utf-8"><title>Demo Assistant</title><body style="font-family:system-ui;padding:24px"><h1>Demo Assistant</h1><p data-testid="assistant-result">${escape(r.message)}</p></body>`, contentType: 'text/html; charset=utf-8' };
  }
  return undefined;
}
