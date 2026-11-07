// The smoke checks (T-0051). Each check is { name, run(ctx) }: it returns a one-line detail when it passes, throws Fail
// (via fail()) when it does not, and throws Skip (via skip()) when it cannot tell. Every request is a GET or HEAD, or a POST
// that is deliberately invalid (a forged webhook signature); no check creates data.
import fs from 'node:fs';
import tls from 'node:tls';
import { fail, skip } from './lib.mjs';

export const STATUS_CAPABILITIES = ['wallet', 'card', 'p2p', 'fx', 'payouts'];
export const CAPABILITY_STATES = ['ok', 'degraded', 'off'];
/** The header or body field a deployed API may carry its image tag in. The API exposes none today (see docs/setup/deploy.md). */
export const VERSION_HEADER = 'x-kesher-version';

const join = (origin, path) => `${origin}${path}`;

/** Operations in an OpenAPI document: JSON text, or the committed YAML (a line scan of the path table; no parser dependency). */
export function countOperations(text) {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  try {
    const doc = JSON.parse(text);
    if (doc && typeof doc === 'object' && doc.paths) return Object.values(doc.paths).reduce((n, p) => n + Object.keys(p ?? {}).filter((k) => methods.has(k)).length, 0);
  } catch {
    // not JSON: read it as YAML below
  }
  let inPaths = false;
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) inPaths = true;
    else if (/^\S/.test(line) && !line.startsWith('#')) inPaths = false;
    else if (inPaths && /^ {4}(get|post|put|patch|delete|head|options):/.test(line)) n += 1;
  }
  return n;
}

/** Security headers the web host must send, with what each is for. A failure names every missing one. */
export const WEB_HEADER_RULES = [
  { name: 'strict-transport-security', test: (h) => /max-age=(\d+)/i.exec(h('strict-transport-security') ?? '')?.[1] >= 15_552_000, need: 'Strict-Transport-Security with max-age of at least 15552000 (180 days)' },
  { name: 'x-content-type-options', test: (h) => (h('x-content-type-options') ?? '').toLowerCase() === 'nosniff', need: 'X-Content-Type-Options: nosniff' },
  { name: 'frame protection', test: (h) => /^(deny|sameorigin)$/i.test((h('x-frame-options') ?? '').trim()) || /frame-ancestors\s/i.test(h('content-security-policy') ?? ''), need: 'X-Frame-Options DENY or SAMEORIGIN, or a CSP frame-ancestors directive' },
  { name: 'content-security-policy', test: (h) => (h('content-security-policy') ?? '').trim() !== '', need: 'a Content-Security-Policy header' },
];

/** What the TLS probes do: injected in the tests, node:tls in the CLI. Resolves with the negotiated protocol, rejects on failure. */
export function realTlsProbe({ host, port, minVersion, maxVersion, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, ...(minVersion ? { minVersion } : {}), ...(maxVersion ? { maxVersion } : {}), timeout: timeoutMs }, () => {
      const protocol = socket.getProtocol();
      socket.end();
      resolve({ protocol });
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timed out'));
    });
    socket.once('error', reject);
  });
}

/**
 * ctx = { client, urls: { api, jit?, admin?, console?, web? } (parsed targets), expectedTag?, openapiUrl?, contractPath,
 *         webhookPath, tlsProbe, now }
 */
export function buildChecks() {
  return [
    {
      name: 'api-status',
      async run({ client, urls }) {
        const r = await client.get(join(urls.api.origin, '/v1/status'));
        if (r.status !== 200) fail(`GET /v1/status answered ${r.status}, wanted 200`);
        const caps = r.json?.capabilities;
        if (!caps || typeof caps !== 'object') fail('GET /v1/status has no capabilities object');
        for (const c of STATUS_CAPABILITIES) if (!CAPABILITY_STATES.includes(caps[c])) fail(`capability ${c} is ${JSON.stringify(caps[c])}, not one of ${CAPABILITY_STATES.join('/')}`);
        return `200, ${STATUS_CAPABILITIES.map((c) => `${c}=${caps[c]}`).join(' ')}`;
      },
    },
    {
      name: 'api-tag',
      async run({ client, urls, expectedTag }) {
        if (!expectedTag) skip('no expected tag given (--expected-tag or SMOKE_EXPECTED_TAG)');
        const r = await client.get(join(urls.api.origin, '/v1/status'));
        const reported = r.header(VERSION_HEADER) ?? (typeof r.json?.version === 'string' ? r.json.version : undefined) ?? (typeof r.json?.tag === 'string' ? r.json.tag : undefined);
        if (reported === undefined) skip(`the API exposes no deployed tag (no ${VERSION_HEADER} header, no version or tag in the /v1/status body); expected ${expectedTag}`);
        if (reported !== expectedTag) fail(`deployed tag is ${reported}, expected ${expectedTag}`);
        return `deployed tag ${reported}`;
      },
    },
    {
      name: 'openapi-operations',
      async run({ client, openapiUrl, contractPath }) {
        if (!openapiUrl) skip('no served OpenAPI document to compare (--openapi-url); the API serves none today');
        const r = await client.get(openapiUrl);
        if (r.status !== 200) fail(`GET ${openapiUrl} answered ${r.status}, wanted 200`);
        const served = countOperations(r.text);
        const committed = countOperations(fs.readFileSync(contractPath, 'utf8'));
        if (committed === 0) fail(`found no operations in ${contractPath}`);
        if (served !== committed) fail(`served document has ${served} operations, committed contracts/openapi.yaml has ${committed}`);
        return `${served} operations, equal to the committed contract`;
      },
    },
    {
      name: 'api-tls13-only',
      async run({ urls, tlsProbe }) {
        const t = urls.api;
        if (!t.https) skip('the API URL is http (local); nothing to negotiate');
        const target = { host: t.host, port: t.port };
        let old;
        try {
          old = await tlsProbe({ ...target, maxVersion: 'TLSv1.2' });
        } catch {
          old = undefined; // refused: what a TLS 1.3 only host does
        }
        if (old) fail(`the API host completed a handshake at ${old.protocol} when offered TLS 1.2 at most`);
        let modern;
        try {
          modern = await tlsProbe({ ...target, minVersion: 'TLSv1.3' });
        } catch (e) {
          fail(`the API host did not complete a TLS 1.3 handshake: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (modern.protocol !== 'TLSv1.3') fail(`TLS 1.3 was asked for and ${modern.protocol} was negotiated`);
        return 'TLS 1.2 refused, TLS 1.3 accepted';
      },
    },
    {
      name: 'jit-health',
      async run({ client, urls }) {
        if (!urls.jit) skip('no JIT URL given (--jit-url)');
        const r = await client.get(join(urls.jit.origin, '/v1/status'));
        if (r.status !== 200) fail(`JIT GET /v1/status answered ${r.status}, wanted 200`);
        if (r.json?.role !== 'jit' || r.json?.status !== 'ok') fail(`JIT /v1/status body is ${r.text.slice(0, 80)}, wanted {"role":"jit","status":"ok"}`);
        return '200 {role:jit,status:ok}';
      },
    },
    {
      name: 'admin-closed-outside-vpn',
      async run({ client, urls }) {
        if (!urls.admin) skip('no admin URL given (--admin-url)');
        let r;
        try {
          r = await client.get(join(urls.admin.origin, '/'));
        } catch (e) {
          return `refused from here (${e instanceof Error ? e.name : 'error'}): no answer outside the VPN`;
        }
        if (r.status >= 200 && r.status < 400) fail(`admin answered ${r.status} to a request from outside the VPN; it must refuse`);
        return `refused with ${r.status}`;
      },
    },
    {
      name: 'console-healthz',
      async run({ client, urls }) {
        if (!urls.console) skip('no console URL given (--console-url)');
        const r = await client.get(join(urls.console.origin, '/healthz'));
        if (r.status !== 200) fail(`console GET /healthz answered ${r.status}, wanted 200`);
        return '200';
      },
    },
    {
      name: 'web-security-headers',
      async run({ client, urls }) {
        if (!urls.web) skip('no web URL given (--web-url)');
        const r = await client.get(join(urls.web.origin, '/'));
        const missing = WEB_HEADER_RULES.filter((rule) => !rule.test(r.header)).map((rule) => rule.need);
        if (missing.length) fail(`web host (${r.status}) lacks: ${missing.join('; ')}`);
        return `${WEB_HEADER_RULES.map((x) => x.name).join(', ')} present`;
      },
    },
    {
      name: 'webhook-bad-signature',
      async run({ client, urls, webhookPath }) {
        // Two identical deliveries with a wrong signature and one event id. The API keeps a refused delivery apart from genuine ones
        // (T-0207), so both must be refused the same way. A 200, or a second answer that differs ("duplicate"), would mean the
        // first one was accepted or claimed the id.
        const url = join(urls.api.origin, webhookPath);
        const body = JSON.stringify({ events: [{ id: 'smoke-forged-event', type: 'smoke.invalid' }] });
        const headers = { 'x-webhook-signature': 'sha256=' + '0'.repeat(64), 'webhook-id': 'smoke-forged-event', 'webhook-timestamp': '1', 'webhook-signature': 'v1,AAAA', 'stripe-signature': 't=1,v1=00' };
        const first = await client.postInvalid(url, body, headers);
        const second = await client.postInvalid(url, body, headers);
        for (const [n, r] of [['first', first], ['second', second]]) {
          if (r.status < 400 || r.status > 499) fail(`${n} forged delivery answered ${r.status}, wanted 4xx`);
          if (/duplicate/i.test(r.text)) fail(`${n} forged delivery was answered as a duplicate: it claimed an event id`);
        }
        if (first.status !== second.status) fail(`forged deliveries answered ${first.status} then ${second.status}: the first one changed what the second saw`);
        return `forged delivery refused twice with ${first.status}, never a duplicate`;
      },
    },
    {
      name: 'money-route-needs-auth',
      async run({ client, urls }) {
        const r = await client.get(join(urls.api.origin, '/v1/accounts'));
        if (r.status !== 401) fail(`GET /v1/accounts without a bearer answered ${r.status}, wanted 401`);
        return '401 without a bearer';
      },
    },
  ];
}

/** Runs the checks in order and stops at the first failure. `report(line)` gets one line per check. Returns { ok, results }. */
export async function runChecks(ctx, report, { strict = false, checks = buildChecks() } = {}) {
  const results = [];
  for (const c of checks) {
    let line;
    let status = 'pass';
    try {
      line = await c.run(ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e?.constructor?.name === 'Skip' && !strict) {
        status = 'skip';
        line = msg;
      } else {
        status = 'fail';
        line = e?.constructor?.name === 'Skip' ? `${msg} (--strict: a skipped check is a failure)` : e?.constructor?.name === 'Fail' ? msg : `${e?.name ?? 'Error'}: ${msg}`;
      }
    }
    results.push({ name: c.name, status, detail: line });
    report(`${status.toUpperCase().padEnd(4)} ${c.name}: ${line}`);
    if (status === 'fail') return { ok: false, results };
  }
  return { ok: true, results };
}
