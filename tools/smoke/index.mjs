#!/usr/bin/env node
// Smoke suite for a deployed environment (T-0051). Over HTTPS only, it GETs and deliberately-invalid-POSTs and creates nothing.
//   node tools/smoke/index.mjs --base-url https://api-il.staging.example [--jit-url ...] [--admin-url ...] [--console-url ...]
//        [--web-url ...] [--openapi-url ...] [--expected-tag sha-0123456789ab] [--webhook-path /v1/webhooks/crowded] [--strict]
// Every option has an environment variable (SMOKE_BASE_URL, SMOKE_JIT_URL, SMOKE_ADMIN_URL, SMOKE_CONSOLE_URL, SMOKE_WEB_URL,
// SMOKE_OPENAPI_URL, SMOKE_EXPECTED_TAG, SMOKE_WEBHOOK_PATH). Exit 0 when every check passed or was skipped, 1 at the first failure.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realTlsProbe, runChecks } from './checks.mjs';
import { makeClient, parseTarget } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPTIONS = { 'base-url': 'SMOKE_BASE_URL', 'jit-url': 'SMOKE_JIT_URL', 'admin-url': 'SMOKE_ADMIN_URL', 'console-url': 'SMOKE_CONSOLE_URL', 'web-url': 'SMOKE_WEB_URL', 'openapi-url': 'SMOKE_OPENAPI_URL', 'expected-tag': 'SMOKE_EXPECTED_TAG', 'webhook-path': 'SMOKE_WEBHOOK_PATH' };
const FLAGS = new Set(['strict', 'allow-local']);

export function parseArgs(argv, env = {}) {
  const o = {};
  for (const [k, e] of Object.entries(OPTIONS)) if (env[e]) o[k] = env[e];
  if (env['SMOKE_STRICT'] === '1') o['strict'] = true;
  if (env['SMOKE_ALLOW_LOCAL'] === '1') o['allow-local'] = true;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (FLAGS.has(k)) o[k] = true;
    else if (k in OPTIONS) {
      const v = argv[(i += 1)];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
      o[k] = v;
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Runs the suite. `deps` lets the tests inject fetch, the TLS probe and the output. Resolves with the exit code. */
export async function main(argv, env = {}, deps = {}) {
  const out = deps.out ?? ((l) => console.log(l));
  let opts;
  let urls;
  try {
    opts = parseArgs(argv, env);
    if (!opts['base-url']) throw new Error('--base-url (or SMOKE_BASE_URL) is required: the API host, https://');
    const allowLocal = opts['allow-local'] === true;
    urls = { api: parseTarget(opts['base-url'], '--base-url', { allowLocal }) };
    for (const [k, label] of [['jit', '--jit-url'], ['admin', '--admin-url'], ['console', '--console-url'], ['web', '--web-url']]) if (opts[label.slice(2)]) urls[k] = parseTarget(opts[label.slice(2)], label, { allowLocal });
    if (opts['openapi-url']) parseTarget(opts['openapi-url'], '--openapi-url', { allowLocal });
  } catch (e) {
    out(`FAIL setup: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const ctx = {
    client: makeClient(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    urls,
    expectedTag: opts['expected-tag'],
    openapiUrl: opts['openapi-url'],
    contractPath: deps.contractPath ?? path.join(root, 'contracts', 'openapi.yaml'),
    webhookPath: opts['webhook-path'] ?? '/v1/webhooks/crowded',
    tlsProbe: deps.tlsProbe ?? realTlsProbe,
  };
  const { ok, results } = await runChecks(ctx, out, { strict: opts['strict'] === true, ...(deps.checks ? { checks: deps.checks } : {}) });
  const skipped = results.filter((r) => r.status === 'skip').length;
  out(ok ? `smoke: ${results.length - skipped} passed, ${skipped} skipped` : `smoke: FAILED at ${results[results.length - 1].name}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code), (e) => {
    console.error(e);
    process.exit(1);
  });
}
