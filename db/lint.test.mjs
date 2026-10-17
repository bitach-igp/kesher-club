// Tests for db/lint.mjs (T-0005). Run with `node --test db/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintDirectory, lintFile, R4_WAIVERS, rules, SQUAWK, squawkArgs, waiverKey } from './lint.mjs';

const ok = '-- T-0201 ledger core (REQ-LED-001, REQ-LED-002)\ncreate table ledger.x (id uuid primary key, at timestamptz not null, amount_minor bigint not null);\ngrant select, insert on all tables in schema ledger to club_app;\n';

test('the committed ledger migration passes every rule', () => {
  assert.deepEqual(lintDirectory(new URL('./migrations/ledger', import.meta.url).pathname), []);
});

test('R1 requires a task + REQ header', () => {
  assert.equal(rules.R1('create table t();', 'f.sql').length, 1);
  assert.equal(rules.R1('-- T-0005 roles (enabling)\ncreate table t();', 'f.sql').length, 0);
  assert.equal(rules.R1(ok, 'f.sql').length, 0);
});

test('R2 rejects timestamp without time zone', () => {
  assert.match(rules.R2('create table t (at timestamp not null);', 'f.sql')[0], /timestamptz/);
  assert.equal(rules.R2('create table t (at timestamptz not null, b timestamp with time zone);', 'f.sql').length, 0);
});

test('R3 rejects numeric money', () => {
  assert.equal(rules.R3('amount numeric(12,2)', 'f.sql').length, 1);
  assert.equal(rules.R3('price_minor integer', 'f.sql').length, 1);
  assert.equal(rules.R3('amount_minor bigint not null, currency ledger.currency', 'f.sql').length, 0);
});

test('R4 keeps ledger insert-only for service roles', () => {
  assert.equal(rules.R4('grant update on ledger.posting to club_app;', 'f.sql').length, 1);
  assert.equal(rules.R4('grant all on all tables in schema ledger to club_app;', 'f.sql').length, 1);
  assert.equal(rules.R4('grant select, insert on all tables in schema ledger to club_app;', 'f.sql').length, 0);
  assert.equal(rules.R4('grant update on ledger.account_balance to club_app;', 'f.sql').length, 1, 'no exception since T-0012: the balance cache lives in ops');
  assert.equal(rules.R4('grant select, insert, update on ops.account_balance to club_app;', 'f.sql').length, 0);
  assert.equal(rules.R4('grant select, insert, update on all tables in schema ops to club_app;', 'f.sql').length, 0);
});

test('R5 rejects seeded users and literal credentials', () => {
  assert.equal(rules.R5("insert into identity.user_account (id) values ('x');", 'f.sql').length, 1);
  assert.equal(rules.R5("alter role club_app password 'hunter2';", 'f.sql').length, 1);
  assert.equal(rules.R5('insert into billing.plan (code) values (\'basic\');', 'f.sql').length, 0);
});

test('R6 bans soft deletes on money schemas only', () => {
  assert.equal(rules.R6('deleted_at timestamptz', 'db/migrations/ledger/0002_x.sql').length, 1);
  assert.equal(rules.R6('deleted_at timestamptz', 'db/migrations/notify/0001_x.sql').length, 0);
});

test('R7 bans serial', () => {
  assert.equal(rules.R7('id bigserial primary key', 'f.sql').length, 1);
  assert.equal(rules.R7('id bigint generated always as identity primary key', 'f.sql').length, 0);
});

test('R8 numbering must be contiguous and snake_case', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, '0001_init.sql'), ok);
  fs.writeFileSync(path.join(dir, '0003_gap.sql'), ok);
  fs.writeFileSync(path.join(dir, 'bad-name.sql'), ok);
  const problems = lintDirectory(dir);
  assert.equal(problems.filter((p) => /expected number 0002/.test(p)).length, 1);
  assert.equal(problems.filter((p) => /named NNNN_snake_case/.test(p)).length, 1);
});

test('lintFile aggregates every rule', () => {
  const sql = 'create table ledger.t (id serial, at timestamp, amount numeric);\ngrant delete on ledger.t to club_app;';
  const problems = lintFile('db/migrations/ledger/0001_t.sql', sql);
  assert.ok(problems.length >= 5, problems.join('\n'));
});

test('R4 waivers are pinned to a file and line of applied history, with a reason, and never float', () => {
  assert.deepEqual(Object.keys(R4_WAIVERS), ['ledger/0001_init.sql:92']);
  for (const reason of Object.values(R4_WAIVERS)) assert.match(reason, /^T-\d{4}: /);
  const sql = Array(91).fill('').join('\n') + '\ngrant update on ledger.account_balance to club_app;\n';
  assert.equal(rules.R4(sql, '/any/prefix/db/migrations/ledger/0001_init.sql').length, 0, 'waived at its line');
  assert.equal(rules.R4(sql, 'C:\\work\\db\\migrations\\ledger\\0001_init.sql').length, 0, 'Windows paths too');
  assert.equal(rules.R4('\n' + sql, 'db/migrations/ledger/0001_init.sql').length, 1, 'a moved line is not waived');
  assert.equal(rules.R4(sql, 'db/migrations/ledger/0006_other.sql').length, 1, 'another file is not waived');
  assert.equal(waiverKey('/x/db/migrations/org/0002_allowance.sql', 7), 'org/0002_allowance.sql:7');
});

test('Squawk is pinned and every exclusion carries a reason', () => {
  assert.match(SQUAWK.version, /^\d+\.\d+\.\d+$/);
  for (const [rule, reason] of SQUAWK.excludedRules) {
    assert.match(rule, /^[a-z-]+$/);
    assert.ok(reason.length > 20, `reason for ${rule}`);
  }
  for (const [p, reason] of SQUAWK.excludedPaths) {
    assert.ok(fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', p)), `${p} exists`);
    assert.ok(reason.length > 20, `reason for ${p}`);
  }
  const args = squawkArgs();
  assert.equal(args[1], `squawk-cli@${SQUAWK.version}`);
  assert.ok(args.includes('--assume-in-transaction'), 'matches how Atlas applies a file');
  assert.ok(args.some((a) => a.startsWith('--exclude=') && a.includes('prefer-robust-stmts')));
  assert.ok(!args.some((a) => a.includes('ban-drop-table') || a.includes('ban-drop-column') || a.includes('require-concurrent-index-creation')), 'destructive and locking rules stay on');
});
