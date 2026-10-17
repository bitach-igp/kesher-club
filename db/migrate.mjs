#!/usr/bin/env node
// Applies every schema's migrations in dependency order (T-0011). Atlas runs `for_each` envs in
// alphabetical order, so `atlas migrate apply --env local` ran `addons` before `ledger` and failed;
// this runner is the apply entry point for every environment. Schemas share one database, so each
// directory after the first is applied with --allow-dirty (its revisions table starts empty while
// earlier schemas already exist). Usage:
//   node db/migrate.mjs --url "$ATLAS_URL" [--dry-run] [--docker] [--schemas ledger,org]
//   --docker runs the official Atlas image instead of a local binary (Windows without winget Atlas).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Dependency order. db/atlas.hcl `locals.schemas` and apps/api/src/test-db.ts must list the same. */
export const SCHEMA_ORDER = ['ledger', 'identity', 'org', 'billing', 'legal', 'addons', 'notify', 'audit', 'agent'];

export const ATLAS_IMAGE = 'arigaio/atlas:latest';

/** Reads `schemas = [ ... ]` out of atlas.hcl so a drift between the two lists fails the tests. */
export function schemasFromAtlasHcl(text) {
  const m = /schemas\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!m) throw new Error('atlas.hcl has no locals.schemas list');
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

/** Inside the Atlas container, localhost is the container; Docker Desktop and the host-gateway alias reach the host. */
export const dockerUrl = (url) => url.replace(/@(localhost|127\.0\.0\.1)(?=[:/])/, '@host.docker.internal');

/**
 * The atlas invocations, in order, without running anything. Directories that do not exist yet
 * (identity has no migrations) are skipped. Returns [{ schema, command, args }].
 */
export function planApply({ url, root = ROOT, schemas = SCHEMA_ORDER, dryRun = false, docker = false, atlasBin = 'atlas' }) {
  if (!url) throw new Error('Database URL required: pass --url or export ATLAS_URL (never a default)');
  for (const schema of schemas) if (!SCHEMA_ORDER.includes(schema)) throw new Error(`Unknown schema ${schema}`);
  const plan = [];
  // Always the global order, whatever order a subset was typed in.
  for (const schema of SCHEMA_ORDER.filter((s) => schemas.includes(s))) {
    if (!fs.existsSync(path.join(root, 'db/migrations', schema))) continue;
    const args = ['migrate', 'apply', '--url', docker ? dockerUrl(url) : url, '--dir', `file://db/migrations/${schema}`, '--revisions-schema', `atlas_${schema}`];
    if (plan.length > 0) args.push('--allow-dirty');
    if (dryRun) args.push('--dry-run');
    plan.push(docker ? { schema, command: 'docker', args: ['run', '--rm', '--add-host=host.docker.internal:host-gateway', '-v', `${root}:/work`, '-w', '/work', ATLAS_IMAGE, ...args] } : { schema, command: atlasBin, args });
  }
  return plan;
}

/** Runs the plan step by step and stops at the first failure. `exec` is injectable for tests. */
export function run(options, exec = (command, args) => spawnSync(command, args, { cwd: options.root ?? ROOT, stdio: 'inherit' })) {
  const results = [];
  for (const step of planApply(options)) {
    const r = exec(step.command, step.args);
    if (r.error) console.error(`${step.command}: ${r.error.message}`);
    const ok = r.status === 0;
    results.push({ schema: step.schema, ok, status: r.status ?? null });
    if (!ok) break;
  }
  return results;
}

function parseArgs(argv) {
  const o = { url: process.env.ATLAS_URL, dryRun: false, docker: false, schemas: SCHEMA_ORDER, atlasBin: process.env.ATLAS_BIN || 'atlas' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--docker') o.docker = true;
    else if (a === '--schemas') o.schemas = (argv[++i] ?? '').split(',').filter(Boolean);
    else throw new Error(`Unknown argument ${a}`);
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  let results;
  try {
    results = run(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.schema}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
