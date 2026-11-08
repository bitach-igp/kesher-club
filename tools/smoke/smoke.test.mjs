// Tests for tools/smoke (T-0051). Run with `node --test tools/smoke/*.test.mjs` (the root `pnpm test` does).
// The checks run against a real createApp served over node:http; local has no TLS, so the TLS probe is a fake.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulatorHost } from '../../apps/simulators/src/index.ts';
import { generateSigningKey } from '../../apps/api/src/auth/tokens.ts';
import { StaticFlags } from '../../apps/api/src/billing/capabilities.ts';
import { createApp } from '../../apps/api/src/app.ts';
import { createServer } from '../../apps/api/src/server.ts';
import { createTestDatabase } from '../../apps/api/src/test-db.ts';
import { buildChecks, countOperations, runChecks, VERSION_HEADER } from './checks.mjs';
import { main, parseArgs } from './index.mjs';
import { makeClient, parseTarget, targetUrl } from './lib.mjs';

const contractPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/openapi.yaml');
let db;
let apiServer;
let jitServer;
let api;
let jit;
const sent = [];

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const closeServer = (s) => new Promise((resolve) => s.close(() => resolve()));
/** fetch that records every request the suite makes. */
const recordingFetch = (url, init) => {
  sent.push({ method: init?.method ?? 'GET', path: new URL(url).pathname, headers: init?.headers ?? {} });
  return fetch(url, init);
};
const lookupOk = async () => ({ address: '127.0.0.1' });
const goodTls = async ({ maxVersion }) => {
  if (maxVersion === 'TLSv1.2') throw new Error('alert protocol version');
  return { protocol: 'TLSv1.3' };
};
/** A static server for the hosts the API does not play: web, console, admin. */
const staticServer = (handler) => http.createServer((req, res) => handler(req, res));

before(async () => {
  db = await createTestDatabase();
  const app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', flags: new StaticFlags(undefined, { 'institutions.usBanking': true }) });
  apiServer = createServer(app);
  jitServer = createServer(app, { role: 'jit' });
  api = await listen(apiServer);
  jit = await listen(jitServer);
}, 60_000);
after(async () => {
  await closeServer(apiServer);
  await closeServer(jitServer);
  await db.close();
});

const lines = () => {
  const out = [];
  return { out, report: (l) => out.push(l) };
};

test('against a local createApp every check that can run passes, and each prints one line', async () => {
  const web = staticServer((_q, res) => res.writeHead(200, { 'strict-transport-security': 'max-age=31536000; includeSubDomains', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'" }).end('ok'));
  const consoleHost = staticServer((q, res) => res.writeHead(q.url === '/healthz' ? 200 : 404).end('{}'));
  const admin = staticServer((_q, res) => res.writeHead(403).end('{}'));
  const [webUrl, consoleUrl, adminUrl] = await Promise.all([listen(web), listen(consoleHost), listen(admin)]);
  try {
    sent.length = 0;
    const { out, report } = lines();
    const ctx = { client: makeClient({ fetchImpl: recordingFetch }), urls: { api: parseTarget(api, 'api', { allowLocal: true }), jit: parseTarget(jit, 'jit', { allowLocal: true }), web: parseTarget(webUrl, 'web', { allowLocal: true }), console: parseTarget(consoleUrl, 'console', { allowLocal: true }), admin: parseTarget(adminUrl, 'admin', { allowLocal: true }) }, contractPath, webhookPath: '/v1/webhooks/crowded', tlsProbe: goodTls, lookup: lookupOk };
    ctx.urls.api = { ...ctx.urls.api, https: true };
    const r = await runChecks(ctx, report);
    assert.equal(r.ok, true, out.join('\n'));
    assert.equal(out.length, buildChecks().length);
    assert.match(out.join('\n'), /PASS api-status: 200/);
    assert.match(out.join('\n'), /PASS jit-health/);
    assert.match(out.join('\n'), /PASS webhook-bad-signature: 401 invalid_signature/);
    assert.match(out.join('\n'), /PASS money-route-needs-auth/);
    assert.match(out.join('\n'), /SKIP api-tag/);
    assert.match(out.join('\n'), /SKIP openapi-operations/);
  } finally {
    await Promise.all([web, consoleHost, admin].map(closeServer));
  }
});

test('no check sends anything but GET, HEAD or a deliberately invalid POST, and never a credential', async () => {
  sent.length = 0;
  const closed = staticServer((_q, res) => res.writeHead(403).end('{}'));
  const open = staticServer((q, res) => res.writeHead(200, q.url === '/healthz' ? {} : { 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'" }).end('{}'));
  const [closedUrl, openUrl] = await Promise.all([listen(closed), listen(open)]);
  const local = (u, l) => parseTarget(u, l, { allowLocal: true });
  const ctx = { client: makeClient({ fetchImpl: recordingFetch }), urls: { api: { ...local(api, 'api'), https: true }, jit: local(jit, 'jit'), admin: local(closedUrl, 'admin'), console: local(openUrl, 'console'), web: local(openUrl, 'web') }, contractPath, webhookPath: '/v1/webhooks/crowded', tlsProbe: goodTls, lookup: lookupOk };
  const r = await runChecks(ctx, () => {});
  await Promise.all([closed, open].map(closeServer));
  assert.equal(r.ok, true);
  assert.ok(sent.length >= 7);
  for (const m of new Set(sent.map((s) => s.method))) assert.ok(['GET', 'HEAD', 'POST'].includes(m), m);
  const posts = sent.filter((s) => s.method === 'POST');
  assert.equal(posts.length, 1);
  for (const p of posts) {
    assert.equal(p.path, '/v1/webhooks/crowded');
    assert.equal(p.headers['x-webhook-signature'], 'sha256=' + '0'.repeat(64), 'a POST carries only a wrong signature');
  }
  for (const s of sent) assert.deepEqual(Object.keys(s.headers).filter((k) => ['authorization', 'cookie', 'x-api-key'].includes(k.toLowerCase())), []);
});

test('the client has no way to send PUT, PATCH or DELETE and refuses credential headers', async () => {
  const c = makeClient({ fetchImpl: recordingFetch });
  assert.deepEqual(Object.keys(c).sort(), ['get', 'head', 'postInvalid']);
  for (const h of ['Authorization', 'cookie', 'X-Api-Key', 'Proxy-Authorization']) {
    await assert.rejects(() => c.get(`${api}/v1/status`, { headers: { [h]: 'x' } }), /never sends a credential/);
    await assert.rejects(() => c.postInvalid(`${api}/v1/status`, '{}', { [h]: 'x' }), /never sends a credential/);
  }
});

test('a path cannot leave the vetted origin', () => {
  const t = parseTarget('https://api.example', 'api');
  assert.equal(targetUrl(t, '/v1/webhooks/crowded'), 'https://api.example/v1/webhooks/crowded');
  for (const p of ['.evil.example/x', '//evil.example/x', 'v1/x', '/a\\b', '/a b', '', undefined, 'https://evil.example/']) assert.throws(() => targetUrl(t, p), /--?path|must start|leaves/, String(p));
});

test('the first failure stops the run and names the check', async () => {
  const { out, report } = lines();
  const bad = staticServer((_q, res) => res.writeHead(503).end('{}'));
  const url = await listen(bad);
  try {
    const checks = buildChecks();
    const ctx = { client: makeClient(), urls: { api: { ...parseTarget(url, 'api', { allowLocal: true }), https: true } }, contractPath, webhookPath: '/x', tlsProbe: goodTls };
    const r = await runChecks(ctx, report, { checks });
    assert.equal(r.ok, false);
    assert.equal(out.length, 1);
    assert.match(out[0], /^FAIL api-status: GET \/v1\/status answered 503/);
  } finally {
    await closeServer(bad);
  }
});

test('the CLI refuses http:// (except local with --allow-local), credentials and a missing base URL, and exits 1', async () => {
  for (const argv of [['--base-url', 'http://api.staging.example'], ['--base-url', 'http://127.0.0.1:1'], ['--base-url', 'https://u:p@api.staging.example'], ['--base-url', 'ftp://x.example'], [], ['--base-url', 'https://api.example', '--jit-url', 'http://jit.example'], ['--base-url', 'https://api.example', '--bogus'], ['--base-url', 'https://api.example', '--webhook-path', '.evil.example/x']]) {
    const { out, report } = lines();
    assert.equal(await main(argv, {}, { out: report, fetchImpl: () => assert.fail('no request may be sent') }), 1, argv.join(' '));
    assert.match(out[0], /^FAIL setup:/);
  }
  const { out, report } = lines();
  await main(['--base-url', 'http://127.0.0.1:1'], {}, { out: report });
  assert.match(out[0], /must be https:\/\/ .*--allow-local/);
});

test('the CLI runs end to end against the local API, reading options from the environment', async () => {
  const { out, report } = lines();
  const code = await main(['--allow-local'], { SMOKE_BASE_URL: api, SMOKE_JIT_URL: jit }, { out: report, tlsProbe: goodTls, contractPath, lookup: lookupOk });
  assert.equal(code, 0, out.join('\n'));
  assert.match(out.at(-1), /^smoke: \d+ passed, \d+ skipped$/);
});

test('--strict turns a skipped check into a failure', async () => {
  const { out, report } = lines();
  const code = await main(['--allow-local', '--strict'], { SMOKE_BASE_URL: api }, { out: report, tlsProbe: goodTls, contractPath });
  assert.equal(code, 1);
  assert.match(out.join('\n'), /FAIL api-tag: no expected tag given .*--strict/);
});

test('the tag check compares an expected tag with the version header or body, and skips when the API exposes none', async () => {
  const run = (impl, expectedTag) => {
    const c = buildChecks().find((x) => x.name === 'api-tag');
    const fetchImpl = async () => impl();
    return c.run({ client: makeClient({ fetchImpl }), urls: { api: parseTarget('https://api.example', 'api') }, expectedTag });
  };
  const res = (body, headers = {}) => new globalThis.Response(JSON.stringify(body), { status: 200, headers });
  assert.match(await run(() => res({}, { [VERSION_HEADER]: 'sha-abc' }), 'sha-abc'), /sha-abc/);
  assert.match(await run(() => res({ version: 'sha-abc' }), 'sha-abc'), /sha-abc/);
  await assert.rejects(() => run(() => res({}, { [VERSION_HEADER]: 'sha-old' }), 'sha-abc'), /deployed tag is sha-old, expected sha-abc/);
  await assert.rejects(() => run(() => res({ capabilities: {} }), 'sha-abc'), /exposes no deployed tag/);
});

test('the OpenAPI check compares the served operation count with the committed contract', async () => {
  const committed = countOperations((await import('node:fs')).readFileSync(contractPath, 'utf8'));
  assert.ok(committed > 100);
  const doc = (n) => JSON.stringify({ paths: Object.fromEntries(Array.from({ length: n }, (_, i) => [`/p${i}`, { get: {} }])) });
  const run = (n) => buildChecks().find((x) => x.name === 'openapi-operations').run({ client: makeClient({ fetchImpl: async () => new globalThis.Response(doc(n)) }), openapiUrl: 'https://api.example/openapi.json', contractPath });
  assert.match(await run(committed), new RegExp(`${committed} operations`));
  await assert.rejects(() => run(committed - 1), /has the committed|committed contracts\/openapi.yaml has/);
  assert.equal(countOperations('paths:\n  /a:\n    get:\n    post:\n  /b:\n    delete:\ncomponents:\n    get:\n'), 3);
});

test('the TLS check wants TLS 1.2 refused and TLS 1.3 accepted', async () => {
  const run = (probe) => buildChecks().find((x) => x.name === 'api-tls13-only').run({ urls: { api: parseTarget('https://api.example', 'api') }, tlsProbe: probe });
  assert.match(await run(goodTls), /TLS 1.2 refused/);
  await assert.rejects(() => run(async () => ({ protocol: 'TLSv1.2' })), /completed a handshake at TLSv1.2/);
  await assert.rejects(() => run(async ({ maxVersion }) => { if (maxVersion) throw new Error('tlsv1 alert protocol version'); throw new Error('no cert'); }), /did not complete a TLS 1.3 handshake: no cert/);
  await assert.rejects(() => run(async ({ maxVersion }) => { if (maxVersion) throw new Error('tlsv1 alert protocol version'); return { protocol: 'TLSv1.2' }; }), /negotiated/);
  assert.match(await run(async ({ maxVersion }) => { if (maxVersion) throw Object.assign(new Error('x'), { code: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION' }); return { protocol: 'TLSv1.3' }; }), /refused/);
  for (const e of [Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), new Error('connect ECONNREFUSED'), new Error('certificate has expired')]) {
    await assert.rejects(() => run(async ({ maxVersion }) => { if (maxVersion) throw e; return { protocol: 'TLSv1.3' }; }), /could not tell whether TLS 1.2 is refused/);
  }
});

test('the admin check passes only on a 403 or a connection-level refusal, and fails on anything else', async () => {
  const run = (impl, lookup = lookupOk) => buildChecks().find((x) => x.name === 'admin-closed-outside-vpn').run({ lookup, client: makeClient({ fetchImpl: async () => impl() }), urls: { admin: parseTarget('https://admin.example', 'admin') } });
  const net = (code) => () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }); };
  assert.match(await run(() => new globalThis.Response('{}', { status: 403 })), /403/);
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) assert.match(await run(net(code)), new RegExp(code));
  assert.match(await run(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), /TimeoutError/);
  for (const status of [200, 303, 401, 404, 500, 502]) await assert.rejects(() => run(() => new globalThis.Response('x', { status })), /only 403/, String(status));
  await assert.rejects(() => run(net('CERT_HAS_EXPIRED')), /not a refusal/);
  await assert.rejects(() => run(net('ENOTFOUND')), /not a refusal/);
  await assert.rejects(() => run(() => new globalThis.Response('x', { status: 403 }), async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); }), /does not resolve/);
});

test('the web header check names every missing header, and the webhook check fails on a 200 or a duplicate', async () => {
  const web = (headers) => buildChecks().find((x) => x.name === 'web-security-headers').run({ client: makeClient({ fetchImpl: async () => new globalThis.Response('ok', { headers }) }), urls: { web: parseTarget('https://web.example', 'web') } });
  await assert.rejects(() => web({ 'x-content-type-options': 'nosniff' }), (e) => /Strict-Transport-Security/.test(e.message) && /frame/.test(e.message) && /Content-Security-Policy/.test(e.message) && !/nosniff/.test(e.message));
  await assert.rejects(() => web({ 'strict-transport-security': 'max-age=60', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'none'" }), /max-age/);
  await web({ 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" });
});

test('the webhook check wants a real 401 invalid_signature, skips a 404 and fails anything else', async () => {
  const hook = (res, webhookPath = '/v1/webhooks/crowded') => buildChecks().find((x) => x.name === 'webhook-bad-signature').run({ client: makeClient({ fetchImpl: async () => res() }), urls: { api: parseTarget('https://api.example', 'api') }, webhookPath });
  const problem = (status, code) => () => new globalThis.Response(JSON.stringify({ status, code }), { status });
  assert.match(await hook(problem(401, 'invalid_signature')), /401 invalid_signature/);
  await assert.rejects(() => hook(problem(404, 'FEATURE_OFF')), (e) => e.constructor.name === 'Skip' && /404/.test(e.message));
  await assert.rejects(() => hook(problem(401, 'UNAUTHENTICATED')), /invalid_signature/);
  await assert.rejects(() => hook(problem(422, 'VALIDATION_FAILED')), /wanted 401/);
  await assert.rejects(() => hook(problem(200, 'x')), /accepted with 200/);
  await assert.rejects(() => hook(problem(500, 'INTERNAL')), /wanted 401/);
  await assert.rejects(() => hook(problem(401, 'invalid_signature'), '.evil.example/x'), /--webhook-path/);
});

test('against the real API the forged delivery is refused 401 invalid_signature when the flag is on', async () => {
  const { out, report } = lines();
  const ctx = { client: makeClient(), urls: { api: parseTarget(api, 'api', { allowLocal: true }) }, webhookPath: '/v1/webhooks/crowded' };
  const r = await runChecks(ctx, report, { checks: buildChecks().filter((c) => c.name === 'webhook-bad-signature') });
  assert.equal(r.ok, true, out.join('\n'));
  assert.match(out[0], /PASS webhook-bad-signature: 401 invalid_signature/);
  // A wrong path is a 404 from the real router: skipped, so strict fails it.
  const wrong = await runChecks({ ...ctx, webhookPath: '/v1/webhooks/nope' }, () => {}, { strict: true, checks: buildChecks().filter((c) => c.name === 'webhook-bad-signature') });
  assert.equal(wrong.ok, false);
});

test('parseArgs reads flags over the environment', () => {
  const o = parseArgs(['--base-url', 'https://a.example', '--strict'], { SMOKE_BASE_URL: 'https://b.example', SMOKE_WEB_URL: 'https://w.example' });
  assert.deepEqual(o, { 'base-url': 'https://a.example', 'web-url': 'https://w.example', strict: true });
});
