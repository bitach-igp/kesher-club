// Tests for db/migrate.mjs (T-0011). Run with `node --test db/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ATLAS_IMAGE, dockerUrl, planApply, ROOT, run, SCHEMA_ORDER, schemasFromAtlasHcl } from './migrate.mjs';

const URL_LOCAL = 'postgres://club_migrator:pw@localhost:5433/club?sslmode=disable';

function fixtureRoot(schemas) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  for (const s of schemas) fs.mkdirSync(path.join(root, 'db/migrations', s), { recursive: true });
  return root;
}

test('the order in migrate.mjs, atlas.hcl and the API test harness is one list', () => {
  assert.deepEqual(schemasFromAtlasHcl(fs.readFileSync(path.join(ROOT, 'db/atlas.hcl'), 'utf8')), SCHEMA_ORDER);
  const harness = fs.readFileSync(path.join(ROOT, 'apps/api/src/test-db.ts'), 'utf8');
  const m = /SCHEMA_ORDER = \[([^\]]*)\]/.exec(harness);
  assert.ok(m, 'test-db.ts declares SCHEMA_ORDER');
  assert.deepEqual([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), SCHEMA_ORDER);
  assert.equal(SCHEMA_ORDER[0], 'ledger', 'ledger creates ops and agent, so it goes first');
});

test('applies in dependency order, skips schemas without a directory, and allows a dirty database after the first', () => {
  const root = fixtureRoot(['ledger', 'org', 'addons']);
  const plan = planApply({ url: URL_LOCAL, root });
  assert.deepEqual(plan.map((p) => p.schema), ['ledger', 'org', 'addons']);
  assert.deepEqual(plan[0].args, ['migrate', 'apply', '--url', URL_LOCAL, '--dir', 'file://db/migrations/ledger', '--revisions-schema', 'atlas_ledger']);
  assert.ok(plan[1].args.includes('--allow-dirty'));
  assert.ok(plan[2].args.includes('--allow-dirty'));
  assert.ok(!plan[0].args.includes('--allow-dirty'), 'the first schema still proves the database is clean');
  assert.ok(planApply({ url: URL_LOCAL, root, dryRun: true }).every((p) => p.args.at(-1) === '--dry-run'));
});

test('a subset keeps the global order and an unknown schema or missing URL is refused', () => {
  const root = fixtureRoot(SCHEMA_ORDER);
  assert.deepEqual(planApply({ url: URL_LOCAL, root, schemas: ['agent', 'ledger', 'org'] }).map((p) => p.schema), ['agent', 'ledger', 'org'].sort((a, b) => SCHEMA_ORDER.indexOf(a) - SCHEMA_ORDER.indexOf(b)));
  assert.throws(() => planApply({ url: URL_LOCAL, root, schemas: ['public'] }), /Unknown schema/);
  assert.throws(() => planApply({ url: '', root }), /ATLAS_URL/);
});

test('--docker runs the Atlas image with the repo mounted and the host reachable', () => {
  const root = fixtureRoot(['ledger', 'org']);
  const plan = planApply({ url: URL_LOCAL, root, docker: true });
  assert.equal(plan[0].command, 'docker');
  assert.deepEqual(plan[0].args.slice(0, 8), ['run', '--rm', '--add-host=host.docker.internal:host-gateway', '-v', `${root}:/work`, '-w', '/work', ATLAS_IMAGE]);
  assert.ok(plan[0].args.includes('postgres://club_migrator:pw@host.docker.internal:5433/club?sslmode=disable'));
  assert.equal(dockerUrl('postgres://u:p@127.0.0.1/db'), 'postgres://u:p@host.docker.internal/db');
  assert.equal(dockerUrl('postgres://u:p@db.internal:5432/db'), 'postgres://u:p@db.internal:5432/db');
});

test('run() executes step by step and stops at the first failure', () => {
  const root = fixtureRoot(['ledger', 'org', 'billing']);
  const calls = [];
  const results = run({ url: URL_LOCAL, root }, (command, args) => {
    calls.push(`${command} ${args[args.indexOf('--dir') + 1]}`);
    return { status: args.includes('file://db/migrations/org') ? 1 : 0 };
  });
  assert.deepEqual(calls, ['atlas file://db/migrations/ledger', 'atlas file://db/migrations/org']);
  assert.deepEqual(results, [
    { schema: 'ledger', ok: true, status: 0 },
    { schema: 'org', ok: false, status: 1 },
  ]);
});
