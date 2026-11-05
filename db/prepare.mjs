#!/usr/bin/env node
// Prepares a deployed database from inside the VPC (T-0044). The RDS instance has no public endpoint, so this runs as a
// one-off Fargate task (infra/terraform/modules/migrate-task) on the image built from tools/migrate/Dockerfile. Three steps, in
// order, each safe to repeat:
//   1. roles.sql as the RDS master user (the managed master secret arrives as PGUSER / PGPASSWORD);
//   2. the four service roles' passwords from Secrets Manager (DB_*_PASSWORD), plus the CONNECT and CREATE grants roles.sql
//      leaves out: it revokes CONNECT from PUBLIC and grants it to nobody, so without step 2 no service role could log in
//      and club_migrator could not create a schema;
//   3. migrate.mjs as club_migrator, every schema in dependency order.
// No secret is ever an argument, a statement or a log line: psql reads each password from its environment with \getenv, and
// the migrator's URL travels in ATLAS_URL. Missing configuration stops it before anything runs. Tests: node --test db/.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');

/** Everything the task is given. Nothing has a default: a missing key names itself and stops the run. */
export const REQUIRED = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGSSLMODE', 'PGUSER', 'PGPASSWORD', 'DB_APP_PASSWORD', 'DB_JIT_PASSWORD', 'DB_READONLY_PASSWORD', 'DB_MIGRATOR_PASSWORD'];

/** The statements of step 2. Static text: every value comes from the environment through psql, so a password is never in it. */
export const ROLE_SQL = [
  '\\set VERBOSITY terse',
  '\\set SHOW_CONTEXT never',
  '\\getenv dbname PGDATABASE',
  '\\getenv app_pw DB_APP_PASSWORD',
  '\\getenv jit_pw DB_JIT_PASSWORD',
  '\\getenv readonly_pw DB_READONLY_PASSWORD',
  '\\getenv migrator_pw DB_MIGRATOR_PASSWORD',
  "alter role club_app password :'app_pw';",
  "alter role club_jit password :'jit_pw';",
  "alter role club_readonly password :'readonly_pw';",
  "alter role club_migrator password :'migrator_pw';",
  'grant connect on database :"dbname" to club_app, club_jit, club_readonly, club_migrator;',
  'grant create on database :"dbname" to club_migrator;',
  '',
].join('\n');

/**
 * The migrator's connection URL. The password is encoded: Secrets Manager values may hold any character. TLS follows the task's
 * own PGSSLMODE and PGSSLROOTCERT (Terraform passes verify-full and the RDS bundle), so the migrator verifies the server exactly
 * as psql does in step 1.
 */
export function migratorUrl(env) {
  const tls = `sslmode=${encodeURIComponent(env.PGSSLMODE)}${env.PGSSLROOTCERT ? `&sslrootcert=${encodeURIComponent(env.PGSSLROOTCERT)}` : ''}`;
  return `postgres://club_migrator:${encodeURIComponent(env.DB_MIGRATOR_PASSWORD)}@${env.PGHOST}:${env.PGPORT}/${encodeURIComponent(env.PGDATABASE)}?${tls}`;
}

/**
 * The steps, in order, without running anything. `input` is psql's standard input; `env` is what the child gets on top of the
 * process environment. No step's arguments, input or extra env hold a password except step 3's ATLAS_URL, which exists only to
 * reach the child's environment.
 */
export function planPrepare(env = process.env, root = ROOT) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  const psql = ['-X', '-q', '-v', 'ON_ERROR_STOP=1'];
  return [
    { name: 'roles', command: 'psql', args: [...psql, '-f', path.join(root, 'db/roles.sql')] },
    { name: 'passwords and grants', command: 'psql', args: psql, input: ROLE_SQL },
    { name: 'migrate', command: 'node', args: [path.join(root, 'db/migrate.mjs')], env: { ATLAS_URL: migratorUrl(env) } },
  ];
}

/** Runs the plan and stops at the first failure. `exec` is injectable for tests. Only step names are printed. */
export function run(env = process.env, exec = defaultExec, root = ROOT) {
  const results = [];
  for (const step of planPrepare(env, root)) {
    const r = exec(step, env);
    const ok = r.status === 0;
    results.push({ name: step.name, ok, status: r.status ?? null });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${step.name}`);
    if (!ok) break;
  }
  return results;
}

function defaultExec(step, env) {
  return spawnSync(step.command, step.args, {
    cwd: ROOT,
    env: { ...env, ...(step.env ?? {}) },
    input: step.input,
    stdio: [step.input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  let results;
  try {
    results = run();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  process.exit(results.length === 3 && results.every((r) => r.ok) ? 0 : 1);
}
