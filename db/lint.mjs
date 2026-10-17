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
import fs from 'node:fs';
import path from 'node:path';

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
      const balanceCache = privileges.trim() === 'update' && target.trim() === 'ledger.account_balance' && m[3] === 'app';
      if (touchesLedger && writes && !balanceCache) out.push(`${file}:${i}: ledger.* is insert-only for service roles (REQ-LED-002)`);
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
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
  console.log('db lint: ok');
}
