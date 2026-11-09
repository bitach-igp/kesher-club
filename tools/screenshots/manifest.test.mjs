// T-0073: the screenshot manifest and handoff/done agree. Fails on a png that is not listed, and on an entry
// whose file is missing. Run with `node --test tools/screenshots/*.test.mjs` (part of `pnpm test`).
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadManifest, pngsOnDisk, problems } from './lib.mjs';

test('every handoff/done png is in the manifest and every entry has its file', () => {
  assert.deepEqual(problems(loadManifest(), pngsOnDisk()), []);
});

test('a png that is not in the manifest is reported', () => {
  const manifest = loadManifest();
  const found = problems(manifest, [...pngsOnDisk(), 'T-9999-new.png']);
  assert.deepEqual(found, ['T-9999-new.png is under handoff/done but not in the manifest']);
});

test('an entry with no file is reported', () => {
  const manifest = loadManifest();
  const [dropped, ...rest] = pngsOnDisk();
  assert.ok(dropped);
  assert.ok(problems(manifest, rest).includes(`${dropped} is in the manifest but has no file under handoff/done`));
});

test('an entry that names no persona, or a not-retaken one with no reason, is reported', () => {
  const manifest = loadManifest();
  const first = manifest.entries[0];
  const bad = { ...manifest, entries: [{ ...first, persona: '' }, ...manifest.entries.slice(1)] };
  assert.ok(problems(bad, pngsOnDisk()).includes(`${first.file}: persona is required`));
  const noReason = { ...manifest, entries: [{ ...first, status: 'not-retaken' }, ...manifest.entries.slice(1)] };
  assert.ok(problems(noReason, pngsOnDisk()).includes(`${first.file}: a not-retaken entry needs a reason`));
});

test('the manifest entries are in sorted file-name order', () => {
  const files = loadManifest().entries.map((e) => e.file);
  assert.deepEqual(files, [...files].sort());
});
