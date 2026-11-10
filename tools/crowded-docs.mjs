#!/usr/bin/env node
// Crowded's published API docs, as a file we can read and cite. Their docs live in a Postman collection
// (https://documenter.getpostman.com/view/20019814/2sBXwnuYMb); this fetches the collection JSON and renders it to
// plain markdown in docs/vendors/crowded/postman-collection.md, so a question about the API ("which calls answer 409?",
// "how are webhooks retried?") is answered by grep and cited by line, not from memory.
//
// Crowded has published more than one view of the docs, and they differ (the 2026-11-10 comparison is in README.md): every
// view we know is fetched, each into its own file, named by its published id.
//
//   node tools/crowded-docs.mjs            fetch and write every snapshot
//   node tools/crowded-docs.mjs --check    fetch and compare with the committed snapshots (exit 1 when Crowded changed their docs)
//   node tools/crowded-docs.mjs --id 2sBXwnuYMb   only that view
//   node tools/crowded-docs.mjs --from collection.json --id 2sBXwnuYMb   render a collection you saved yourself (no network)
//
// The collection is data from a third party: it is parsed as JSON and rendered as text, nothing in it is ever run.
// Only the one host below is contacted, over https, with a size cap and a timeout. In the cloud sandbox Node's fetch needs
// NODE_USE_ENV_PROXY=1 and NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt (the WebFetch tool cannot reach this host; curl and Node can).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://documenter.gw.postman.com/api/collections/20019814/';
/** The published views of Crowded's docs. `2sBXwnuYMb` is the link Crowded sent on 2026-11-10; `2sBYArTsS6` is the one api-inventory.md was written from. */
export const VIEWS = [
  { id: '2sBXwnuYMb', file: new URL('../docs/vendors/crowded/postman-2sBXwnuYMb.md', import.meta.url) },
  { id: '2sBYArTsS6', file: new URL('../docs/vendors/crowded/postman-2sBYArTsS6.md', import.meta.url) },
];
export const COLLECTION_URL = `${BASE}${VIEWS[0].id}`;
const MAX_BYTES = 5 * 1024 * 1024;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** HTML from a Postman description to plain text. Tags are dropped, a few block tags become line breaks. */
export function clean(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d|li|tr|pre|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .trim();
}

const describe = (o) => {
  const d = o?.description;
  return clean(typeof d === 'object' && d !== null ? d.content : d);
};

/** The collection as markdown: folders become headings, each request its method and URL, description, body and responses. */
export function render(collection) {
  const out = [`# ${collection?.info?.name ?? 'Collection'}`, describe(collection?.info)];
  const walk = (items, depth) => {
    for (const it of items ?? []) {
      if (Array.isArray(it.item)) {
        out.push(`\n${'#'.repeat(depth)} ${it.name}`);
        const t = describe(it);
        if (t) out.push(t);
        walk(it.item, Math.min(depth + 1, 5));
        continue;
      }
      const r = it.request ?? {};
      const url = r.url && typeof r.url === 'object' ? r.url.raw : r.url;
      out.push(`\n${'#'.repeat(Math.min(depth, 6))} ${it.name} — ${r.method} ${url}`);
      const t = describe(r) || describe(it);
      if (t) out.push(t);
      if (r.body?.raw) out.push(`REQUEST BODY: ${String(r.body.raw).slice(0, 1500)}`);
      for (const resp of it.response ?? []) out.push(`RESPONSE ${resp.code} ${resp.name}: ${String(resp.body ?? '').slice(0, 900)}`);
    }
  };
  walk(collection?.item, 2);
  return `${out.join('\n')}\n`;
}

export async function download(url = COLLECTION_URL, fetchImpl = fetch) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'documenter.gw.postman.com') throw new Error('Only https://documenter.gw.postman.com is contacted');
  const res = await fetchImpl(u, { signal: globalThis.AbortSignal.timeout(60_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Postman answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('The collection is larger than expected; refusing to render it');
  return JSON.parse(text);
}

async function main(argv) {
  const check = argv.includes('--check');
  const idAt = argv.indexOf('--id');
  const views = idAt >= 0 ? VIEWS.filter((v) => v.id === argv[idAt + 1]) : VIEWS;
  if (views.length === 0) throw new Error(`Unknown view; known: ${VIEWS.map((v) => v.id).join(', ')}`);
  const from = argv.indexOf('--from');
  if (from >= 0 && views.length !== 1) throw new Error('--from needs --id, to say which view the file is');
  let status = 0;
  for (const v of views) {
    const collection = from >= 0 ? JSON.parse(readFileSync(argv[from + 1], 'utf8')) : await download(`${BASE}${v.id}`);
    const md = render(collection);
    if (check) {
      if (readFileSync(v.file, 'utf8') === md) console.log(`${v.id}: the snapshot matches the published docs.`);
      else {
        console.error(`${v.id}: Crowded changed this view of their API docs since the committed snapshot: run \`node tools/crowded-docs.mjs\`, read the diff, and update api-inventory.md and the vendor notes.`);
        status = 1;
      }
      continue;
    }
    writeFileSync(v.file, md);
    console.log(`${v.id}: wrote ${fileURLToPath(v.file)} (${md.length} characters).`);
  }
  return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
