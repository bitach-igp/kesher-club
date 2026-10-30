// T-1017 the demo assistant (TST-AGT-010, demo row): its metadata document lists the panel's redirect URI; start
// answers an authorization URL with S256 PKCE, a state and the MCP resource; the callback refuses an unknown state,
// reports access_denied, and trades a code at the token endpoint with the verifier it kept, after which it says what
// was granted and never shows the token.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DemoAssistant, DEMO_ASSISTANT_CLIENT_ID } from './assistant.ts';
import { handle } from './server.ts';
import { SimulatorHost } from './host.ts';

const API = 'http://localhost:3000';
const PANEL = 'http://localhost:4010';

function assistant(answer: { status: number; body: unknown } = { status: 200, body: { access_token: 'at-secret', refresh_token: 'rt-secret', scope: 'balances:read' } }) {
  const sent: { url: string; body: URLSearchParams }[] = [];
  const fetchFake = (async (url: string, init?: { body?: string }) => {
    sent.push({ url, body: new URLSearchParams(init?.body ?? '') });
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
  }) as unknown as typeof fetch;
  return { a: new DemoAssistant({ apiUrl: () => API, panelUrl: () => PANEL, fetch: fetchFake }), sent };
}

describe('the demo assistant (T-1017)', () => {
  it('its document lists the panel\'s redirect URI; start asks with S256 PKCE, a state and the MCP resource', () => {
    const { a } = assistant();
    expect(a.document()).toMatchObject({ client_id: DEMO_ASSISTANT_CLIENT_ID, client_name: 'Demo Assistant', redirect_uris: [`${PANEL}/assistant/callback`], token_endpoint_auth_method: 'none' });
    const u = new URL(a.start());
    expect(`${u.origin}${u.pathname}`).toBe(`${API}/oauth/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: DEMO_ASSISTANT_CLIENT_ID, redirect_uri: `${PANEL}/assistant/callback`, code_challenge_method: 'S256', resource: `${API}/mcp` });
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('trades the code with the verifier it kept, once; the page and the status never show a token', async () => {
    const { a, sent } = assistant();
    const ask = new URL(a.start());
    const state = ask.searchParams.get('state')!;
    const r = await a.callback(new URLSearchParams({ code: 'the-code', state }));
    expect(r).toEqual({ ok: true, message: 'Connected. Granted: balances:read.' });
    const form = sent[0]!.body;
    expect([sent[0]!.url, form.get('grant_type'), form.get('code'), form.get('client_id')]).toEqual([`${API}/oauth/token`, 'authorization_code', 'the-code', DEMO_ASSISTANT_CLIENT_ID]);
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(ask.searchParams.get('code_challenge'));
    expect(JSON.stringify([r, a.status()])).not.toContain('secret');
    expect(a.accessToken()).toBe('at-secret');
    expect((await a.callback(new URLSearchParams({ code: 'again', state }))).ok).toBe(false);
  });

  it('reports a denial and a failed exchange in words, and refuses an unknown state', async () => {
    const { a } = assistant({ status: 400, body: { error: 'invalid_grant' } });
    const denied = new URL(a.start()).searchParams.get('state')!;
    expect(await a.callback(new URLSearchParams({ error: 'access_denied', state: denied }))).toEqual({ ok: false, message: 'The member did not connect (access_denied).' });
    const failed = new URL(a.start()).searchParams.get('state')!;
    expect(await a.callback(new URLSearchParams({ code: 'x', state: failed }))).toEqual({ ok: false, message: 'The token exchange failed (invalid_grant).' });
    expect((await a.callback(new URLSearchParams({ code: 'x', state: 'forged' }))).ok).toBe(false);
  });

  it('the panel serves the document, a 302 to start, the callback page as escaped text, and the status', async () => {
    const { a } = assistant();
    const host = new SimulatorHost();
    expect((await handle(host, 'GET', '/assistant/client.json', '', { assistant: a })).body).toMatchObject({ client_id: DEMO_ASSISTANT_CLIENT_ID });
    const start = await handle(host, 'GET', '/assistant/start', '', { assistant: a });
    expect([start.status, start.headers?.['location']?.startsWith(`${API}/oauth/authorize?`)]).toEqual([302, true]);
    const page = await handle(host, 'GET', '/assistant/callback?error=%3Cscript%3E&state=nope', '', { assistant: a });
    expect([page.status, String(page.body).includes('<script>')]).toEqual([400, false]);
    expect((await handle(host, 'GET', '/assistant/status', '', { assistant: a })).body).toEqual({ connected: false });
  });
});
