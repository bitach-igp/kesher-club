#!/usr/bin/env node
// Generates and loads the secrets Terraform creates empty (T-0056). Usage:
//   node tools/secrets/index.mjs --env staging [--region us-east-1] [--only name,name] [--rotate] [--dry-run]
// For each secret under kesher/<env>/ it generates a value, checks it, and loads it with `aws secretsmanager put-secret-value`.
// It refuses to replace a secret that already has a value unless --rotate is given, and never replaces the PII keys (that needs a
// re-seal job first; docs/setup/secrets.md). The admin key pair is loaded, kept or rotated as one unit. A value is never an argument, never printed and never logged: the AWS CLI reads it from this process's
// standard input. Output names the secrets and what happened, nothing else.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll, GENERATED } from './generate.mjs';

const SELF = fileURLToPath(import.meta.url);
export const ENVS = ['staging', 'prod'];

/** The shape checks a value must pass before it is stored; the same rules the processes' config schemas apply. */
export const VALIDATORS = {
  'jwt-signing-key': (v) => isPrivateEs256(v),
  'admin-api-signing-key': (v) => isPrivateEs256(v),
  'pii-data-key': (v) => isKey32(v),
  'pii-index-key': (v) => isKey32(v),
  'staff-jwks': (v) => {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j.keys) && j.keys.length > 0 && j.keys.every((k) => k.kty === 'EC' && k.d === undefined);
    } catch {
      return false;
    }
  },
  'db-app-password': (v) => isPassword(v),
  'db-jit-password': (v) => isPassword(v),
  'db-readonly-password': (v) => isPassword(v),
  'db-migrator-password': (v) => isPassword(v),
};
function isPrivateEs256(v) {
  try {
    const j = JSON.parse(v);
    return j.kty === 'EC' && j.crv === 'P-256' && ['x', 'y', 'd'].every((f) => typeof j[f] === 'string');
  } catch {
    return false;
  }
}
function isKey32(v) {
  const b = Buffer.from(v, 'base64');
  return b.length === 32 && b.toString('base64') === v;
}
function isPassword(v) {
  return /^[A-Za-z0-9_-]{40,}$/.test(v);
}

/** The AWS CLI invocations for one secret, without running anything. The value travels on stdin, never in `args`. */
export function awsCalls(env, name, region) {
  const id = `kesher/${env}/${name}`;
  return {
    read: { args: ['secretsmanager', 'get-secret-value', '--secret-id', id, '--region', region, '--query', 'VersionId', '--output', 'text'] },
    write: { args: ['secretsmanager', 'put-secret-value', '--secret-id', id, '--region', region, '--secret-string', 'file:///dev/stdin'] },
  };
}

/** Secrets that were sealed or indexed with the old key: replacing one orphans live data until a re-seal job exists. */
export const PROTECTED = ['pii-data-key', 'pii-index-key'];
/** One key pair: the console signs with the private half, the API verifies with the public half. Never one without the other. */
export const PAIR = ['admin-api-signing-key', 'staff-jwks'];

/** What `get-secret-value` said: has a value, has none, no such container, or something else (denied, throttled). */
function probe(exec, env, name, region) {
  const r = exec(awsCalls(env, name, region).read.args, undefined);
  const err = r.stderr ?? '';
  if (r.status === 0) return 'value';
  if (/specified secret value/.test(err)) return 'empty';
  return /ResourceNotFoundException/.test(err) ? 'no-container' : 'failed';
}

/**
 * Runs the plan. `exec(args, input)` is injectable and returns { status, stderr }. A secret that already has a value is kept
 * (or replaced under --rotate, except the PII keys, which this tool never replaces); a container that does not exist (Terraform
 * not applied) is an error naming it. The admin key pair is decided as one unit so its halves can never disagree.
 */
export function run({ env, region, only, rotate = false, dryRun = false }, exec = defaultExec, generate = generateAll) {
  if (!ENVS.includes(env)) throw new Error(`--env must be one of ${ENVS.join(', ')}`);
  if (!region) throw new Error('--region is required (no default)');
  const names = only ?? GENERATED;
  for (const n of names) if (!GENERATED.includes(n)) throw new Error(`Unknown secret ${n}; this tool generates: ${GENERATED.join(', ')}`);
  if (rotate && only && only.some((n) => PROTECTED.includes(n))) {
    throw new Error(`${only.filter((n) => PROTECTED.includes(n)).join(', ')} cannot be rotated with this tool: sealed fields and blind indexes need a re-seal job first (docs/setup/secrets.md)`);
  }
  if (PAIR.some((n) => names.includes(n)) && !PAIR.every((n) => names.includes(n))) {
    throw new Error(`${PAIR.join(' and ')} are one key pair: name both, or neither`);
  }
  const values = generate(env);
  const results = [];
  const store = (name, hasValue) => {
    if (dryRun) return hasValue ? 'would-rotate' : 'would-load';
    const w = exec(awsCalls(env, name, region).write.args, values[name]);
    return w.status === 0 ? (hasValue ? 'rotated' : 'loaded') : 'failed';
  };
  const handled = new Set();
  for (const name of names) {
    if (handled.has(name)) continue;
    const group = PAIR.includes(name) ? PAIR : [name];
    for (const n of group) {
      handled.add(n);
      if (!VALIDATORS[n](values[n])) {
        results.push({ name: n, outcome: 'invalid' });
        return results;
      }
    }
    const states = group.map((n) => probe(exec, env, n, region));
    const bad = states.findIndex((st) => st === 'no-container' || st === 'failed');
    if (bad >= 0) {
      results.push({ name: group[bad], outcome: states[bad] });
      return results;
    }
    const withValue = states.filter((st) => st === 'value').length;
    if (group.length > 1 && withValue === 1 && !rotate) {
      results.push({ name: group.join('+'), outcome: 'pair-mismatch' });
      return results;
    }
    if (withValue === group.length && !rotate) {
      for (const n of group) results.push({ name: n, outcome: 'kept' });
      continue;
    }
    if (rotate && PROTECTED.includes(name) && withValue > 0) {
      results.push({ name, outcome: 'protected' });
      continue;
    }
    for (const [i, n] of group.entries()) {
      const outcome = store(n, states[i] === 'value');
      results.push({ name: n, outcome });
      if (outcome === 'failed') return results;
    }
  }
  return results;
}

function defaultExec(args, input) {
  const r = spawnSync('aws', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  // stdout carries a version id at most; stderr is kept only for the not-found check and never printed.
  return { status: r.status ?? 1, stderr: r.stderr ?? '' };
}

function parseArgs(argv) {
  const o = { env: undefined, region: process.env.AWS_REGION, only: undefined, rotate: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') o.env = argv[++i];
    else if (a === '--region') o.region = argv[++i];
    else if (a === '--only') o.only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--rotate') o.rotate = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  let results;
  try {
    results = run(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  for (const r of results) console.log(`${r.outcome.padEnd(12)} ${r.name}`);
  process.exit(results.every((r) => ['loaded', 'rotated', 'kept', 'protected', 'would-load', 'would-rotate'].includes(r.outcome)) ? 0 : 1);
}
