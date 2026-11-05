// Tests for db/prepare.mjs (T-0044). Run with `node --test db/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, migratorUrl, planPrepare, REQUIRED, ROLE_SQL, run } from './prepare.mjs';

const PASSWORDS = { DB_APP_PASSWORD: 'app-pw-secret', DB_JIT_PASSWORD: 'jit-pw-secret', DB_READONLY_PASSWORD: 'ro-pw-secret', DB_MIGRATOR_PASSWORD: 'mig/pw:with@odd#chars?' };
const ENV = { PGHOST: 'db.internal', PGPORT: '5432', PGDATABASE: 'club', PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/app/db/certs/rds-global-bundle.pem', PGUSER: 'master', PGPASSWORD: 'master-pw-secret', ...PASSWORDS };

test('plans roles, then passwords and grants, then the migration, in that order', () => {
  const plan = planPrepare(ENV, '/app');
  assert.deepEqual(plan.map((s) => s.name), ['roles', 'passwords and grants', 'migrate']);
  assert.deepEqual(plan[0].args, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '/app/db/roles.sql']);
  assert.equal(plan[1].input, ROLE_SQL);
  assert.deepEqual(plan[2].args, ['/app/db/migrate.mjs']);
});

test('every missing key is named, and nothing runs', () => {
  for (const key of REQUIRED) {
    const env = { ...ENV };
    delete env[key];
    assert.throws(() => planPrepare(env), new RegExp(`Missing configuration: ${key}$`));
  }
  assert.throws(() => planPrepare({ ...ENV, DB_JIT_PASSWORD: '', DB_APP_PASSWORD: '' }), /DB_APP_PASSWORD, DB_JIT_PASSWORD/);
  let ran = false;
  assert.throws(() => run({}, () => ((ran = true), { status: 0 })));
  assert.equal(ran, false);
});

test('each step gets only the environment it needs: the migration never sees the master or the other roles\' passwords', () => {
  const full = { ...ENV, PATH: '/usr/bin', HOME: '/tmp', UNRELATED: 'x' };
  const [roles, passwords, migrate] = planPrepare(full).map((s) => childEnv(s, full));
  assert.equal(roles.PGPASSWORD, 'master-pw-secret');
  assert.equal(roles.DB_APP_PASSWORD, undefined);
  assert.equal(passwords.DB_JIT_PASSWORD, 'jit-pw-secret');
  assert.equal(passwords.UNRELATED, undefined);
  assert.deepEqual(Object.keys(migrate).sort(), ['ATLAS_URL', 'HOME', 'PATH']);
});

test('no password is in any step input or psql argument; the migrator password appears only in atlas\'s URL, which is its step env', () => {
  const secrets = [...Object.values(PASSWORDS), ENV.PGPASSWORD];
  for (const step of planPrepare(ENV)) {
    const visible = JSON.stringify({ args: step.args, input: step.input ?? '' });
    for (const s of secrets) assert.ok(!visible.includes(s), `${step.name} shows a secret`);
  }
  for (const s of Object.values(PASSWORDS)) assert.ok(!ROLE_SQL.includes(s));
});

test('the SQL reads passwords with \\getenv, sets all four roles and grants connect and create', () => {
  for (const [role, v] of [['club_app', 'app_pw'], ['club_jit', 'jit_pw'], ['club_readonly', 'readonly_pw'], ['club_migrator', 'migrator_pw']]) {
    assert.ok(ROLE_SQL.includes(`alter role ${role} password :'${v}';`), role);
  }
  assert.match(ROLE_SQL, /\\getenv dbname PGDATABASE/);
  assert.match(ROLE_SQL, /grant connect on database :"dbname" to club_app, club_jit, club_readonly, club_migrator;/);
  assert.match(ROLE_SQL, /grant create on database :"dbname" to club_migrator;/);
  assert.match(ROLE_SQL, /SHOW_CONTEXT never/);
});

test('the migrator connects as club_migrator with the password encoded and the certificate verified', () => {
  const url = new URL(migratorUrl(ENV));
  assert.equal(url.username, 'club_migrator');
  assert.equal(decodeURIComponent(url.password), PASSWORDS.DB_MIGRATOR_PASSWORD);
  assert.equal(url.hostname, 'db.internal');
  assert.equal(url.searchParams.get('sslmode'), 'verify-full');
  assert.equal(url.searchParams.get('sslrootcert'), '/app/db/certs/rds-global-bundle.pem');
  // A local database without TLS says so itself: the mode is the task's, never hard-coded.
  const plain = new URL(migratorUrl({ ...ENV, PGSSLMODE: 'disable', PGSSLROOTCERT: '' }));
  assert.equal(plain.searchParams.get('sslmode'), 'disable');
  assert.equal(plain.searchParams.get('sslrootcert'), null);
});

test('stops at the first failing step and says which, without printing a value', () => {
  const lines = [];
  const log = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    const calls = [];
    const results = run(ENV, (step) => (calls.push(step.name), { status: step.name === 'passwords and grants' ? 1 : 0 }));
    assert.deepEqual(calls, ['roles', 'passwords and grants']);
    assert.deepEqual(results.map((r) => r.ok), [true, false]);
  } finally {
    console.log = log;
  }
  assert.deepEqual(lines, ['ok   roles', 'FAIL passwords and grants']);
});

test('the migrate step carries the URL in its environment only', () => {
  const [, , migrate] = planPrepare(ENV);
  assert.equal(migrate.env.ATLAS_URL, migratorUrl(ENV));
  assert.ok(!migrate.args.join(' ').includes('postgres://'));
});
