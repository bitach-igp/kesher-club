// TST-AUTH-008 (T-1120, contract half of T-0792): the staff SSO routes exist with the contract's methods, security, parameters,
// responses and headers, and answer 404 FEATURE_OFF with nothing stored until the behaviour card (T-0792) replaces the default
// handler. The contract is read STRUCTURALLY (by indentation, per operation), not by substring, so a deleted `security: []`, a
// renamed header or a dropped response code fails a named test. (No YAML library is a dependency of this package.)
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { match, ROUTES } from '../routes.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
const INSTITUTION = '0192a7b2-0000-7000-8000-00000000a001';
const YAML = fs.readFileSync(new URL('../../../../contracts/openapi.yaml', import.meta.url), 'utf8').split('\n');

interface Op {
  path: string;
  method: string;
  security: string | undefined;
  parameters: string[];
  codes: string[];
  headers: Record<string, string[]>;
  text: string;
}
const indentOf = (l: string): number => l.length - l.trimStart().length;

/** One operation's structure, from the lines between its `operationId` owner (indent 4) and the next key at indent <= 4. */
function operation(operationId: string): Op {
  const at = YAML.findIndex((l) => l.trim() === `operationId: ${operationId}`);
  expect(at, `operationId ${operationId} in the contract`).toBeGreaterThan(0);
  let start = at;
  while (!/^ {4}(get|post|patch|delete):\s*$/.test(YAML[start]!)) start -= 1;
  let end = at;
  while (end + 1 < YAML.length && (YAML[end + 1]!.trim() === '' || indentOf(YAML[end + 1]!) > 4)) end += 1;
  let pathLine = start;
  while (!/^ {2}\/\S+:\s*$/.test(YAML[pathLine]!)) pathLine -= 1;
  const lines = YAML.slice(start + 1, end + 1);
  const out: Op = { path: YAML[pathLine]!.trim().slice(0, -1), method: YAML[start]!.trim().slice(0, -1), security: undefined, parameters: [], codes: [], headers: {}, text: lines.join('\n') };
  let section = '';
  let code = '';
  let inHeaders = false;
  for (const l of lines) {
    const i = indentOf(l);
    const t = l.trim();
    if (i === 6) {
      section = t.split(':')[0]!;
      if (section === 'security') out.security = t.slice('security:'.length).trim();
      inHeaders = false;
    } else if (section === 'parameters' && i === 8 && t.startsWith('- ')) out.parameters.push(t.slice(2));
    else if (section === 'responses' && i === 8) {
      code = t.split(':')[0]!.replace(/"/g, '');
      out.codes.push(code);
      inHeaders = false;
    } else if (section === 'responses' && i === 10) inHeaders = t === 'headers:';
    else if (section === 'responses' && i === 12 && inHeaders) (out.headers[code] ??= []).push(t.split(':')[0]!);
  }
  return out;
}
/** The hand-kept HEADER_OPS row of the SDK client (`packages/sdk/src/client.ts`), read as text: this package does not depend on the SDK. */
const CLIENT = fs.readFileSync(new URL('../../../../packages/sdk/src/client.ts', import.meta.url), 'utf8');
const operationHeaders = new Proxy({} as Record<string, { idempotency: boolean; stepUp: boolean } | undefined>, {
  get: (_t, key: string) => {
    const m = new RegExp(`'${key.replace(/[{}/]/g, '\\$&')}': \\{ idempotency: (true|false), stepUp: (true|false) \\}`).exec(CLIENT);
    return m ? { idempotency: m[1] === 'true', stepUp: m[2] === 'true' } : undefined;
  },
});
/** A component schema's lines (indent 4 key, until the next key at indent <= 4). */
function schema(name: string): string {
  const at = YAML.findIndex((l) => l === `    ${name}:`);
  expect(at, `schema ${name}`).toBeGreaterThan(0);
  let end = at + 1;
  while (end < YAML.length && indentOf(YAML[end]!) > 4) end += 1;
  return YAML.slice(at, end).join('\n');
}
const num = (text: string, key: string): number => Number(new RegExp(`${key}: (\\d+)`).exec(text)?.[1] ?? Number.NaN);
const requiredOf = (text: string): string[] => (/required: \[([^\]]*)\]/.exec(text)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const hasParam = (op: Op, needle: string) => op.parameters.some((p) => p.includes(needle));

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example' });
}, 60_000);
afterAll(async () => db.close());

describe('staff SSO contract (T-1120)', () => {
  it('startStaffSso: POST, public (`security: []`), the shared Id parameter only, 200 with Set-Cookie, no step-up or idempotency', () => {
    const op = operation('startStaffSso');
    expect([op.method, op.path, op.security]).toEqual(['post', '/institutions/{id}/sso/start', '[]']);
    expect(op.parameters).toEqual(['{ $ref: "#/components/parameters/Id" }']);
    expect(op.codes).toEqual(['200', 'default']);
    expect(op.headers['200']).toEqual(['Set-Cookie']);
    expect(operationHeaders['post /institutions/{id}/sso/start']).toBeUndefined();
    expect(op.text).toContain('NO application-level counter');
    expect(op.text).toContain('no money');
    // purpose and inviteToken moved to the link operation: the sign-in body is the device and the PKCE challenge only.
    expect(requiredOf(schema('StaffSsoStartRequest')).sort()).toEqual(['challenge', 'deviceId']);
    expect(schema('StaffSsoStartRequest')).not.toContain('inviteToken');
    expect(op.text).toContain('login CSRF');
  });

  it('startStaffSsoLink: POST, bearer (no `security` override), the SHARED required StepUp parameter, a HEADER_OPS row that matches', () => {
    const op = operation('startStaffSsoLink');
    expect([op.method, op.path, op.security]).toEqual(['post', '/institutions/{id}/sso/link/start', undefined]);
    expect(hasParam(op, '#/components/parameters/Id')).toBe(true);
    expect(hasParam(op, '#/components/parameters/StepUp')).toBe(true);
    expect(hasParam(op, 'IdempotencyKey')).toBe(false);
    // The shared parameter itself: the header the client sends, and required (an optional one would let a link start skip the step-up).
    const sp = YAML.findIndex((l) => l === '    StepUp:');
    expect(YAML.slice(sp, sp + 4).map((l) => l.trim())).toEqual(['StepUp:', 'name: X-Step-Up', 'in: header', 'required: true']);
    expect(op.codes).toEqual(['200', 'default']);
    expect(op.headers['200']).toEqual(['Set-Cookie']);
    expect(operationHeaders['post /institutions/{id}/sso/link/start']).toEqual({ idempotency: false, stepUp: true });
    expect(op.text).toContain('401 STEP_UP_REQUIRED');
    expect(op.text).toContain('VALIDATED here');
    // B2: the membership check comes first; the SSO-record answer is shown only to a member; the global flag-off is the same for everyone.
    expect(op.text.replace(/\s+/g, ' ')).toMatch(/membership check comes FIRST.*one answer 404 NOT_FOUND.*only a caller who passes it can see 404 FEATURE_OFF/);
    expect(op.text.replace(/\s+/g, ' ')).toContain('flag is off for the whole platform');
    // The body is required now (the challenge is), and the challenge is mandatory in it.
    expect(op.text).toMatch(/requestBody:\n\s+required: true/);
    expect(requiredOf(schema('StaffSsoLinkStartRequest'))).toEqual(['challenge']);
  });

  it('completeStaffSso: GET, public, every query parameter OPTIONAL (a refusal is a 302, never a 422), 302 with the four headers, never 200', () => {
    const op = operation('completeStaffSso');
    expect([op.method, op.path, op.security]).toEqual(['get', '/sso/callback', '[]']);
    expect(op.parameters.map((p) => /name: (\w+)/.exec(p)![1])).toEqual(['code', 'state', 'error', 'error_description']);
    for (const p of op.parameters) {
      expect(p).toContain('in: query');
      expect(p).toContain('required: false');
    }
    // No unverified length floor on the IdP's code; our own state keeps its 256-bit floor.
    expect(op.parameters[0]).not.toContain('minLength');
    expect(num(op.parameters[1]!, 'minLength')).toBeGreaterThanOrEqual(43);
    expect(op.codes).toEqual(['302', 'default']);
    expect(op.headers['302']).toEqual(['Location', 'Cache-Control', 'Referrer-Policy', 'Set-Cookie']);
    expect(op.text).toContain('Max-Age=0');
    expect(op.text).toContain('#error=refused');
    expect(op.text).toContain('never a 422 page');
    expect(op.text).toContain('ALB access log');
    expect(operationHeaders['get /sso/callback']).toBeUndefined();
  });

  it('exchangeStaffSso: POST, public, 200 with the session, a body that is only the code (>= 43 chars)', () => {
    const op = operation('exchangeStaffSso');
    expect([op.method, op.path, op.security]).toEqual(['post', '/sso/exchange', '[]']);
    expect(op.codes).toEqual(['200', 'default']);
    expect(operationHeaders['post /sso/exchange']).toBeUndefined();
    // B1: the verifier is required beside the code, base64url, 43 to 128 characters; the challenge is the exact SHA-256 length.
    const ex = schema('StaffSsoExchangeRequest');
    expect(requiredOf(ex).sort()).toEqual(['code', 'verifier']);
    const verifier = ex.split('\n').find((l) => l.includes('verifier:'))!;
    expect(num(verifier, 'minLength')).toBeGreaterThanOrEqual(43);
    expect(num(verifier, 'maxLength')).toBeLessThanOrEqual(128);
    expect(verifier).toContain('^[A-Za-z0-9_-]+$');
    const code = ex.split('\n').find((l) => l.includes('code: {'))!;
    expect(num(code, 'minLength')).toBeGreaterThanOrEqual(43);
    const ch = schema('StaffSsoChallenge');
    expect([num(ch, 'minLength'), num(ch, 'maxLength')]).toEqual([43, 43]);
    expect(ch).toContain('^[A-Za-z0-9_-]{43}$');
    expect(op.text.replace(/\s+/g, ' ')).toContain('A wrong verifier does NOT consume the code');
    expect(op.text.replace(/\s+/g, ' ')).toContain('cap of 5 attempts per code');
  });

  it('the route table has exactly these four, with the right methods and public flags', () => {
    const rows = ROUTES.filter((r) => /sso/.test(r.path)).map((r) => `${r.method} ${r.path} ${r.operationId} ${r.public ? 'public' : 'bearer'}`);
    expect(rows).toEqual([
      'POST /institutions/{id}/sso/start startStaffSso public',
      'POST /institutions/{id}/sso/link/start startStaffSsoLink bearer',
      'GET /sso/callback completeStaffSso public',
      'POST /sso/exchange exchangeStaffSso public',
    ]);
    expect(match('PUT', '/sso/callback')).toBeUndefined();
    expect(match('POST', '/sso/callback')).toBeUndefined();
    expect(match('GET', '/sso/exchange')).toBeUndefined();
    expect(match('GET', `/institutions/${INSTITUTION}/sso/start`)).toBeUndefined();
  });
});

describe('staff SSO routes while no behaviour is built (T-1120)', () => {
  const stored = async () => (await db.query('select 1 from ops.workflow_marker')).rowCount + (await db.query('select 1 from org.staff_idp_link')).rowCount;
  const off = (res: Awaited<ReturnType<typeof dispatch>>) => {
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'FEATURE_OFF' });
    expect(res.headers?.['set-cookie']).toBeUndefined();
    expect(res.headers?.['location']).toBeUndefined();
  };

  it('each of the three public operations answers 404 FEATURE_OFF signed out, with no cookie, no redirect and nothing stored', async () => {
    off(await dispatch(app, { method: 'POST', url: `/v1/institutions/${INSTITUTION}/sso/start`, headers: {}, rawBody: JSON.stringify({ deviceId: 'web-1' }) }));
    off(await dispatch(app, { method: 'GET', url: '/v1/sso/callback?code=ok%3Aidp-1%3Aa%40b.c&state=abc', headers: {}, rawBody: '' }));
    off(await dispatch(app, { method: 'GET', url: '/v1/sso/callback?error=access_denied&error_description=nope', headers: {}, rawBody: '' }));
    off(await dispatch(app, { method: 'GET', url: '/v1/sso/callback', headers: {}, rawBody: '' }));
    off(await dispatch(app, { method: 'POST', url: '/v1/sso/exchange', headers: {}, rawBody: JSON.stringify({ code: 'x'.repeat(43), verifier: 'v'.repeat(43) }) }));
    expect(await stored()).toBe(0);
  });

  it('the bearer operation needs a bearer (401) and, signed in with the platform flag off, answers 404 FEATURE_OFF (global, the same for every caller) with nothing stored', async () => {
    const anon = await dispatch(app, { method: 'POST', url: `/v1/institutions/${INSTITUTION}/sso/link/start`, headers: {}, rawBody: '{}' });
    expect(anon.status).toBe(401);
    const s = app.services;
    const partyId = '0192a7b2-0000-7000-8000-00000000b001';
    const token = (await s.tokens.issue({ partyId, deviceId: 'web-1', roles: ['member', 'org_staff'] })).accessToken;
    off(await dispatch(app, { method: 'POST', url: `/v1/institutions/${INSTITUTION}/sso/link/start`, headers: { authorization: `Bearer ${token}`, 'x-step-up': 'su_x' }, rawBody: '{}' }));
    expect(await stored()).toBe(0);
  });

  it('a wrong method, HEAD and an unknown sub-path answer 404 NOT_FOUND (not FEATURE_OFF) and store nothing', async () => {
    for (const [method, url] of [['GET', `/v1/institutions/${INSTITUTION}/sso/start`], ['PUT', '/v1/sso/callback'], ['POST', '/v1/sso/callback'], ['HEAD', '/v1/sso/callback?code=a&state=b'], ['GET', '/v1/sso/exchange'], ['POST', `/v1/institutions/${INSTITUTION}/sso/other`]] as const) {
      const res = await dispatch(app, { method, url, headers: {}, rawBody: '' });
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body, `${method} ${url}`).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await stored()).toBe(0);
  });
});
