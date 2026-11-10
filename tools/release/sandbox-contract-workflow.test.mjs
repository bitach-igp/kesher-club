// Pins .github/workflows/sandbox-contract.yml (T-0690) and docs/setup/sandbox-contracts.md. Run with `node --test tools/release/*.test.mjs`
// (the root `pnpm test` does). The repo has no YAML dependency, so the workflow is read as text and by indentation; it must keep the
// layout asserted here. actionlint is not run in CI: this file is the guard for the properties that matter (never on a pull request,
// scheduled and manual, minimal permissions, every secret documented, every secret a test reads is wired).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const workflow = read('.github/workflows/sandbox-contract.yml');
const doc = read('docs/setup/sandbox-contracts.md');
const lines = workflow.split('\n').filter((l) => !l.trimStart().startsWith('#'));
const code = lines.join('\n');
const indentOf = (l) => l.length - l.trimStart().length;

/** Lines nested under a header line at the given indent (blank lines kept out). */
function under(header, indent, from = lines) {
  const start = from.findIndex((l) => l === `${' '.repeat(indent)}${header}`);
  assert.notEqual(start, -1, `missing ${header}`);
  const out = [];
  for (let i = start + 1; i < from.length; i += 1) {
    if (from[i].trim() !== '' && indentOf(from[i]) <= indent) break;
    if (from[i].trim() !== '') out.push(from[i]);
  }
  return out;
}

const triggers = under('on:', 0).filter((l) => indentOf(l) === 2).map((l) => l.trim().replace(/:$/, ''));
const jobNames = under('jobs:', 0).filter((l) => indentOf(l) === 2).map((l) => l.trim().replace(/:$/, ''));
const portJobs = jobNames.filter((j) => j !== 'uncovered');

test('runs on a schedule and by hand, never on a pull request, push or fork-reachable event', () => {
  assert.deepEqual(triggers.sort(), ['schedule', 'workflow_dispatch']);
  assert.match(code, /cron: "\d+ \d+ \* \* \*"/);
  assert.doesNotMatch(code, /pull_request|pull_request_target|workflow_run|^\s+push:/m);
});

test('permissions are explicit: read-only by default, issues: write only on the port jobs', () => {
  assert.deepEqual(under('permissions:', 0), ['  contents: read']);
  for (const job of portJobs) {
    const body = under(`${job}:`, 2);
    assert.deepEqual(under('permissions:', 4, body), ['      contents: read', '      issues: write'], job);
  }
  assert.equal(code.match(/issues: write/g).length, portJobs.length);
  assert.doesNotMatch(code, /(contents|id-token|actions|pull-requests|packages|security-events): write|write-all/);
  assert.deepEqual(under('permissions:', 0).length, 1);
});

test('every job refuses a forked repository and has a timeout', () => {
  for (const job of jobNames) {
    const body = under(`${job}:`, 2);
    assert.ok(body.includes('    if: ${{ !github.event.repository.fork }}'), job);
    assert.ok(body.some((l) => /^ {4}timeout-minutes: \d+$/.test(l)), job);
  }
});

test('actions are pinned the way ci.yml pins them and nothing is fetched from elsewhere', () => {
  const ci = read('.github/workflows/ci.yml');
  const used = [...code.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const u of used) {
    assert.match(u, /^[\w-]+\/[\w-]+@v\d+$/, u);
    assert.ok(ci.includes(`uses: ${u}`), `ci.yml does not use ${u}`);
  }
  assert.doesNotMatch(code, /curl |wget /);
});

test('a port without its secrets skips with a notice and a failure files an issue titled by the port, deduped by title', () => {
  for (const job of portJobs) {
    const body = under(`${job}:`, 2).join('\n');
    assert.match(body, /::notice title=/, job);
    assert.match(body, /run=false/, job);
    assert.match(body, /- if: failure\(\)/, job);
    assert.match(body, /title="Sandbox contract failing: \$PORT"/, job);
    assert.match(body, new RegExp(`PORT: ${job}\\b`), job);
    assert.match(body, /gh issue list .*--state open/, job);
    assert.match(body, /gh issue comment/, job);
    assert.match(body, /gh issue create/, job);
    assert.match(body, /SANDBOX_CONTRACTS: "1"/, job);
    // Every step after the gate is conditional on it, apart from the failure report.
    const steps = body.split(/\n {6}- /).slice(2);
    for (const s of steps) assert.ok(/^if: (steps\.gate\.outputs\.run == 'true'|failure\(\))/.test(s), `${job}: ${s.slice(0, 50)}`);
  }
});

const secretNames = [...new Set([...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].filter((n) => n !== 'GITHUB_TOKEN');

test('every secret the workflow references is listed in docs/setup/sandbox-contracts.md', () => {
  assert.ok(secretNames.length >= 10);
  for (const n of secretNames) assert.ok(doc.includes(`\`${n}\``), `${n} missing from the doc`);
  assert.doesNotMatch(code, /secrets\.(?!GITHUB_TOKEN\b)[A-Z0-9_]*(LIVE|PROD)/);
});

test('every environment variable the sandbox tests read is wired from a secret of the same name, and no other secret is', () => {
  const tests = [read('packages/adapters/src/sandbox.contract.test.ts'), read('packages/adapters/src/crowded/sandbox.test.ts')].join('\n');
  const read_ = new Set([...tests.matchAll(/env\('([A-Z0-9_]+)'\)/g), ...tests.matchAll(/process\.env\['([A-Z0-9_]+)'\]/g)].map((m) => m[1]));
  read_.delete('SANDBOX_CONTRACTS');
  assert.deepEqual([...read_].sort(), [...secretNames].sort());
  for (const n of secretNames) assert.match(code, new RegExp(`^\\s+${n}: \\$\\{\\{ secrets\\.${n} \\}\\}$`, 'm'));
});

test('the doc names every port job and has no value that looks like a key', () => {
  for (const job of portJobs) assert.ok(doc.includes(`\`${job}\``), job);
  assert.doesNotMatch(workflow + doc, /(sk|rk|pk)_(test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|AC[0-9a-f]{32}/);
});
