// Tests for tools/release (T-0049). Run with `node --test tools/release/*.test.mjs` (the root `pnpm test` does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyIgnoreList, parseDay, validateIgnoreList } from './ignore-list.mjs';
import { parseArgs, run } from './check-findings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TODAY = '2026-11-10';
const entry = (over = {}) => ({
  id: 'CVE-2026-0001',
  image: 'kesher/api',
  reason: 'not reachable: the library is only used at build time',
  owner: '@zvi',
  signedOn: '2026-11-05',
  expires: '2026-12-05',
  ...over,
});

test('the committed ignore list is well formed', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, '.github/security/image-scan-ignore.json'), 'utf8'));
  assert.deepEqual(validateIgnoreList(doc, TODAY), []);
});

test('parseDay accepts real dates only', () => {
  assert.equal(parseDay('2026-02-30'), null);
  assert.equal(parseDay('2026-2-3'), null);
  assert.equal(parseDay(20261105), null);
  assert.notEqual(parseDay('2026-02-28'), null);
});

test('a well formed 30-day entry passes; 31 days fails', () => {
  assert.deepEqual(validateIgnoreList({ entries: [entry()] }, TODAY), []);
  const long = validateIgnoreList({ entries: [entry({ expires: '2026-12-06' })] }, TODAY);
  assert.equal(long.length, 1);
  assert.match(long[0], /more than 30 days/);
});

test('malformed entries fail', () => {
  assert.ok(validateIgnoreList(null, TODAY).length > 0);
  assert.ok(validateIgnoreList({ entries: 'x' }, TODAY).length > 0);
  assert.ok(validateIgnoreList({ entries: [entry({ owner: 'zvi' })] }, TODAY).length > 0);
  assert.ok(validateIgnoreList({ entries: [entry({ reason: ' ' })] }, TODAY).length > 0);
  assert.ok(validateIgnoreList({ entries: [entry({ expires: 'soon' })] }, TODAY).length > 0);
  assert.ok(validateIgnoreList({ entries: [entry({ expires: '2026-11-01' })] }, TODAY).length > 0);
  assert.ok(validateIgnoreList({ entries: [entry({ signedOn: '2026-11-20', expires: '2026-11-25' })] }, TODAY).length > 0);
  assert.ok(validateIgnoreList({ entries: [{ ...entry(), extra: 1 }] }, TODAY).length > 0);
  const noId = entry();
  delete noId.id;
  assert.ok(validateIgnoreList({ entries: [noId] }, TODAY).length > 0);
});

test('an active entry excuses its finding; an expired one does not; the image must match', () => {
  const doc = { entries: [entry(), entry({ id: 'CVE-2026-0002', signedOn: '2026-10-01', expires: '2026-10-31' }), entry({ id: 'CVE-2026-0003', image: 'kesher/worker' }), entry({ id: 'CVE-2026-0004', image: '*' })] };
  assert.deepEqual(validateIgnoreList(doc, TODAY), []);
  const findings = ['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-0003', 'CVE-2026-0004', 'CVE-2026-0005'].map((id) => ({ id }));
  const { ignored, blocking } = applyIgnoreList(doc, 'kesher/api', findings, TODAY);
  assert.deepEqual(ignored.map((f) => f.id), ['CVE-2026-0001', 'CVE-2026-0004']);
  assert.deepEqual(blocking.map((f) => f.id), ['CVE-2026-0002', 'CVE-2026-0003', 'CVE-2026-0005']);
});

test('an entry is still in force on its expiry day', () => {
  const doc = { entries: [entry({ expires: TODAY })] };
  assert.equal(applyIgnoreList(doc, 'kesher/api', [{ id: 'CVE-2026-0001' }], TODAY).blocking.length, 0);
  assert.equal(applyIgnoreList(doc, 'kesher/api', [{ id: 'CVE-2026-0001' }], '2026-11-11').blocking.length, 1);
});

test('the CLI exit codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-gate-'));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const list = write('ignore.json', { entries: [entry()] });
  const none = write('none.json', []);
  const excused = write('excused.json', [{ id: 'CVE-2026-0001' }]);
  const bad = write('bad.json', [{ id: 'CVE-2026-9999', package: 'openssl', fixedIn: '3.0.1' }]);
  assert.equal(run({ ignore: list, today: TODAY }).code, 0);
  assert.equal(run({ ignore: list, image: 'kesher/api', findings: none, today: TODAY }).code, 0);
  assert.equal(run({ ignore: list, image: 'kesher/api', findings: excused, today: TODAY }).code, 0);
  const blocked = run({ ignore: list, image: 'kesher/api', findings: bad, today: TODAY });
  assert.equal(blocked.code, 1);
  assert.match(blocked.lines.join('\n'), /CVE-2026-9999 in openssl \(fixed in 3\.0\.1\)/);
  assert.equal(run({ ignore: write('malformed.json', '{nope'), today: TODAY }).code, 1);
  assert.equal(run({ ignore: write('long.json', { entries: [entry({ expires: '2027-01-01' })] }), today: TODAY }).code, 1);
  assert.equal(run({ ignore: path.join(dir, 'missing.json'), today: TODAY }).code, 1);
  assert.equal(run({ today: TODAY }).code, 2);
});

test('every Dockerfile builds from the same digest-pinned node base', () => {
  const files = ['apps/api', 'apps/worker', 'apps/admin', 'apps/console', 'tools/migrate'].map((d) => path.join(root, d, 'Dockerfile'));
  const refs = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const nodeFroms = [...text.matchAll(/^FROM\s+(node:\S+)/gm)].map((m) => m[1]);
    assert.ok(nodeFroms.length > 0, `${file} has no node FROM`);
    for (const ref of nodeFroms) refs.add(ref);
  }
  assert.equal(refs.size, 1, `the Dockerfiles use different bases: ${[...refs].join(', ')}`);
  assert.match([...refs][0], /^node:22\.22\.0-bookworm-slim@sha256:[0-9a-f]{64}$/);
});

test('admin and console build @kesher/tokens before the app', () => {
  for (const app of ['admin', 'console']) {
    const text = fs.readFileSync(path.join(root, 'apps', app, 'Dockerfile'), 'utf8');
    assert.ok(text.indexOf('pnpm --filter @kesher/tokens build') > 0, `${app} must build tokens`);
    assert.ok(text.indexOf('pnpm --filter @kesher/tokens build') < text.indexOf(`pnpm --filter @kesher/${app} build`));
  }
});

test('ids and images are checked for typos', () => {
  assert.deepEqual(validateIgnoreList({ entries: [entry({ id: 'GHSA-cfgh-2345-wxrv' }), entry({ image: '*' })] }, TODAY), []);
  assert.equal(validateIgnoreList({ entries: [entry({ id: 'cve-2026-0001' })] }, TODAY).length, 1);
  assert.equal(validateIgnoreList({ entries: [entry({ id: 'CVE-26-1' })] }, TODAY).length, 1);
  assert.equal(validateIgnoreList({ entries: [entry({ image: 'kesher/apii' })] }, TODAY).length, 1);
});

test('--help prints the usage and exits 0', () => {
  const r = run(parseArgs(['--help']));
  assert.equal(r.code, 0);
  assert.match(r.lines[0], /usage:/);
});

test('a failing check fails a `| tee` pipeline under pipefail, as the release step does (regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-pipe-'));
  const ignore = path.join(dir, 'ignore.json');
  const findings = path.join(dir, 'findings.json');
  fs.writeFileSync(ignore, '{"entries":[]}');
  fs.writeFileSync(findings, '[{"id":"CVE-2026-9999"}]');
  const cli = path.join(root, 'tools/release/check-findings.mjs');
  const pipeline = `node "${cli}" --ignore "${ignore}" --image kesher/api --findings "${findings}" | tee /dev/null`;
  assert.equal(spawnSync('bash', ['-e', '-c', pipeline]).status, 0, 'without pipefail the failure is lost');
  assert.notEqual(spawnSync('bash', ['-e', '-c', `set -o pipefail; ${pipeline}`]).status, 0);
});

test('the release workflow keeps pipefail and the enhanced-scanning guard on its gate steps', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const step = (name) => {
    const start = yml.indexOf(`- name: ${name}`);
    assert.ok(start > 0, `step "${name}" is missing`);
    const next = yml.indexOf('\n      - ', start + 1);
    return yml.slice(start, next > 0 ? next : undefined);
  };
  assert.match(step('Fail on critical findings that have a fix'), /set -o pipefail/);
  assert.match(step('Fail on critical findings that have a fix'), /PARTIAL/);
  assert.match(step('Fail on critical findings that have a fix'), /SUPPRESSED/);
  assert.match(step('Attach the SBOM to the ECR image'), /set -o pipefail/);
  assert.match(step('Attach the SBOM to the ECR image'), /-gt 0/);
  assert.match(step('Require enhanced scanning on the registry'), /get-registry-scanning-configuration/);
});
