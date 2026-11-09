// Shared by record.mjs and manifest.test.mjs (T-0073): reads the screenshot manifest and checks it against the
// files under handoff/done. Pure Node, no Playwright, so the test runs anywhere `pnpm test` does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const DONE_DIR = path.join(ROOT, 'handoff/done');
export const MANIFEST_PATH = path.join(here, 'manifest.json');

export const APPS = ['mobile', 'console', 'admin', 'simulator'];
export const THEMES = ['light', 'dark'];
export const LOCALES = ['en', 'he'];
export const STATUSES = ['recorded', 'not-retaken'];

export function loadManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The .png files directly under handoff/done, sorted. */
export function pngsOnDisk(dir = DONE_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
}

/**
 * What is wrong with a manifest, as sentences. Empty means it is sound: every png is listed once, every entry
 * has its file, and every entry says what is needed to take it again.
 */
export function problems(manifest, pngs) {
  const out = [];
  const seen = new Set();
  for (const e of manifest.entries ?? []) {
    if (seen.has(e.file)) out.push(`${e.file} is listed twice`);
    seen.add(e.file);
    if (!pngs.includes(e.file)) out.push(`${e.file} is in the manifest but has no file under handoff/done`);
    if (!/^T-\d{4}-[a-z0-9-]+\.png$/.test(e.file ?? '')) out.push(`${e.file} does not look like T-NNNN-name.png`);
    if (!/^T-\d{4}$/.test(e.card ?? '')) out.push(`${e.file}: card must be T-NNNN`);
    if (!APPS.includes(e.app)) out.push(`${e.file}: app must be one of ${APPS.join(', ')}`);
    if (!THEMES.includes(e.theme)) out.push(`${e.file}: theme must be one of ${THEMES.join(', ')}`);
    if (!LOCALES.includes(e.locale)) out.push(`${e.file}: locale must be one of ${LOCALES.join(', ')}`);
    if (!STATUSES.includes(e.status)) out.push(`${e.file}: status must be one of ${STATUSES.join(', ')}`);
    for (const k of ['persona', 'route', 'state', 'flow']) if (typeof e[k] !== 'string' || !e[k]) out.push(`${e.file}: ${k} is required`);
    if (!Number.isInteger(e.viewport?.width) || !Number.isInteger(e.viewport?.height)) out.push(`${e.file}: viewport needs integer width and height`);
    if (e.status === 'not-retaken' && !e.reason) out.push(`${e.file}: a not-retaken entry needs a reason`);
  }
  for (const f of pngs) if (!seen.has(f)) out.push(`${f} is under handoff/done but not in the manifest`);
  return out;
}
