#!/usr/bin/env node
// Migration lint (T-0005; Tab 3 §8 "default credentials" + club-ddl rules). Runs in CI on every PR:
//   node db/lint.mjs            lint every file under db/migrations
//   node db/lint.mjs <file>…    lint specific files
// Rules (each one is a function below so the test file can exercise it in isolation):
//   R1 header names the task and REQs:            -- T-NNNN … (REQ-…)   (or "-- T-NNNN … (enabling)")
//   R2 no `timestamp` without time zone
//   R3 money columns are bigint (+ currency), never numeric/float/money/double
//   R4 ledger.* grants to club_app are select/insert only; never update/delete/truncate/all
//   R5 no seeded users or credentials (insert into *user*/*admin*, `password`, `secret`)
//   R6 no soft deletes (deleted_at) on money schemas (ledger, billing, addons)
//   R7 primary keys are uuid or identity bigint; no serial
//   R8 files are numbered NNNN_slug.sql and numbers are contiguous per schema
// After the house rules, Squawk (pinned) checks every migration for destructive and locking
// statements; see SQUAWK below for the exclusions and their reasons (T-0012).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Write grants on ledger.* that history already carries. Applied migrations are forward-only, so the
 * line cannot be edited; the waiver is pinned to the file and line and names the migration that
 * undid it. Any other write grant on ledger.* fails R4.
 */
export const R4_WAIVERS = Object.freeze({
  'ledger/0001_init.sql:92': 'T-0012: balance cache grant; ledger/0005 moves the cache to ops.account_balance, drops the table and revokes writes',
});

export const rules = {
  R1(sql, file) {
    const head = sql.split('\n').slice(0, 3).join('\n');
    return /^--\s*T-\d{4}\b.*\((?:REQ-[A-Z]+-\d{3}(?:,\s*REQ-[A-Z]+-\d{3})*|enabling)\)/m.test(head)
      ? []
      : [`${file}: first lines must name the task and REQs, e.g. "-- T-0201 ledger core (REQ-LED-001)"`];
  },
  R2(sql, file) {
    const out = [];
    for (const [i, line] of lines(sql)) {
      if (/\btimestamp\b(?!\s*tz)(?!\s+with\s+time\s+zone)/i.test(stripComments(line)) && !/timestamptz/i.test(line)) {
        out.push(`${file}:${i}: use timestamptz, not timestamp`);
      }
    }
    return out;
  },
  R3(sql, file) {
    const out = [];
    for (const [i, line] of lines(sql)) {
      const l = stripComments(line);
      if (/\b(amount|price|cost|fee|balance|markup|total)\w*\s+(numeric|decimal|float\d*|double\s+precision|real|money|int(eger)?)\b/i.test(l)) {
        out.push(`${file}:${i}: money columns are bigint minor units + currency (constitution art. 3)`);
      }
    }
    return out;
  },
  R4(sql, file) {
    const out = [];
    for (const [i, line] of lines(sql)) {
      const l = stripComments(line).toLowerCase();
      const m = /^\s*grant\s+(.+?)\s+on\s+(.+?)\s+to\s+club_(app|jit|readonly)\b/.exec(l);
      if (!m) continue;
      const [, privileges, target] = m;
      const touchesLedger = /\bledger\./.test(target) || /in schema[^;]*\bledger\b/.test(target);
      const writes = /\b(update|delete|truncate|all)\b/.test(privileges);
      if (touchesLedger && writes && !waived(file, i)) out.push(`${file}:${i}: ledger.* is insert-only for service roles (REQ-LED-002)`);
    }
    return out;
  },
  R5(sql, file) {
    const out = [];
    for (const [i, line] of lines(sql)) {
      const l = stripComments(line).toLowerCase();
      if (/^\s*insert\s+into\s+\S*(user|admin|staff|credential|api_key)/.test(l)) out.push(`${file}:${i}: no seeded users or credentials in migrations (seed scripts live in tools/seed, local/preview only)`);
      if (/\b(password|secret|api_key)\s*=\s*'/.test(l) || /\bpassword\s+'/.test(l)) out.push(`${file}:${i}: no literal credentials`);
    }
    return out;
  },
  R6(sql, file) {
    if (!/\/(ledger|billing|addons)\//.test(file.replace(/\\/g, '/'))) return [];
    const out = [];
    for (const [i, line] of lines(sql)) {
      if (/\bdeleted_at\b/i.test(stripComments(line))) out.push(`${file}:${i}: no soft deletes on money tables; closure is a state change`);
    }
    return out;
  },
  R7(sql, file) {
    const out = [];
    for (const [i, line] of lines(sql)) {
      if (/\b(big)?serial\b/i.test(stripComments(line))) out.push(`${file}:${i}: use uuid (app-generated UUIDv7) or "bigint generated always as identity", not serial`);
    }
    return out;
  },
};

export function lintFile(file, sql = fs.readFileSync(file, 'utf8')) {
  return Object.values(rules).flatMap((r) => r(sql, file));
}

/** R8: numbering per directory. */
export function lintDirectory(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const out = [];
  let expected = 1;
  for (const f of files) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f);
    if (!m) {
      out.push(`${path.join(dir, f)}: migrations are named NNNN_snake_case.sql`);
      continue;
    }
    if (Number(m[1]) !== expected) out.push(`${path.join(dir, f)}: expected number ${String(expected).padStart(4, '0')} (contiguous, forward-only)`);
    expected = Number(m[1]) + 1;
    out.push(...lintFile(path.join(dir, f)));
  }
  return out;
}

function* lines(sql) {
  let n = 0;
  for (const line of sql.split('\n')) yield [++n, line];
}
const stripComments = (line) => line.replace(/--.*$/, '');

/** `<schema>/<file>:<line>` of a path like db/migrations/ledger/0001_init.sql, whatever the prefix. */
export const waiverKey = (file, line) => {
  const parts = file.replace(/\\/g, '/').split('/');
  return `${parts.slice(-2).join('/')}:${line}`;
};
const waived = (file, line) => Object.hasOwn(R4_WAIVERS, waiverKey(file, line));

/** Squawk: pinned version, rules it enforces by default minus these exclusions, each with its reason. */
export const SQUAWK = Object.freeze({
  version: '2.70.0',
  pgVersion: '16.0',
  excludedRules: Object.freeze([
    ['prefer-robust-stmts', 'Atlas runs each file in one transaction and never re-applies a file; IF NOT EXISTS buys nothing'],
    ['prefer-bigint-over-int', 'money is already bigint by R3; counters and attempt columns stay int'],
    ['require-statement-timeout', 'pre-launch, no live traffic; revisit with the first migration against a live table'],
    ['require-lock-timeout', 'pre-launch, no live traffic; revisit with the first migration against a live table'],
    ['ban-char-field', 'char(3) ISO currency codes are intentional (ledger.currency)'],
  ]),
  excludedPaths: Object.freeze([
    ['db/migrations/ledger/0003_transfers.sql', 'applied pre-launch; its index on a 0001 table had no live rows to lock'],
    ['db/migrations/ledger/0012_fee_transfers.sql', 'pre-launch, no live rows in ops.transfer or ops.case: the kind check is dropped only to be re-added as a superset in the same transaction, and the ops.case index locks nothing'],
  ]),
});

export function squawkArgs(pattern = 'db/migrations/*/*.sql') {
  return [
    '--yes',
    `squawk-cli@${SQUAWK.version}`,
    `--pg-version=${SQUAWK.pgVersion}`,
    '--assume-in-transaction',
    '--reporter=gcc',
    `--exclude=${SQUAWK.excludedRules.map(([rule]) => rule).join(',')}`,
    ...SQUAWK.excludedPaths.map(([p]) => `--exclude-path=${p}`),
    pattern,
  ];
}

/** Runs Squawk from the repo root. Returns its exit status; output goes to the console. */
export function runSquawk(exec = (cmd, args, opts) => spawnSync(cmd, args, opts)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = exec(process.platform === 'win32' ? 'npx.cmd' : 'npx', squawkArgs(), { cwd: root, stdio: 'inherit' });
  if (r.error) {
    console.error(`squawk: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

const SELF = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (isMain) {
  const root = path.dirname(SELF);
  const args = process.argv.slice(2);
  const problems = args.length
    ? args.flatMap((f) => lintFile(f))
    : fs
        .readdirSync(path.join(root, 'migrations'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => lintDirectory(path.join(root, 'migrations', d.name)));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('db lint: house rules ok');
  if (!args.length) {
    const status = runSquawk();
    if (status !== 0) process.exit(status);
    console.log('db lint: squawk ok');
  }
}
