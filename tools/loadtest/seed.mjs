#!/usr/bin/env node
// Seed helper for the JIT load test (T-0055). The public API cannot make funded test cards by itself: sign-in needs a passkey
// ceremony, a purse load needs a fresh step-up, and no endpoint returns the processor card id the JIT call is keyed by
// (CardView carries only our own id). So this script does the two things that are possible from outside, and the README
// documents the rest (how the members, cards and funds are made on staging).
//
//   node tools/loadtest/seed.mjs manifest --input rows.json [--out tools/loadtest/cards.json] [--min-balance 100000] [--burst-cards 30]
//       rows.json is the output of the read-only query in README.md ("Seed query"), as a JSON array of
//       { "processor_card_id": "...", "status": "active", "balance_minor": "123456" }. Writes cards.json for jit.js:
//       the active cards funded to at least --min-balance minor units; the richest --burst-cards (default 30, enough for a burst of 5 per second under the velocity rule) become burstCards.
//   node tools/loadtest/seed.mjs check --url "$JIT_URL"   (the signature is read from the JIT_SIGNATURE environment variable)
//       One signed, decline-only probe (an unknown card): proves the host answers and accepts the signature. Moves no money.
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNotProd, buildRequest, burstCardsNeeded } from './lib.mjs';

/**
 * Pure: rows from the seed query to the manifest jit.js reads. Balances are bigint strings; money never becomes a number.
 * The `burstCount` richest funded cards become `burstCards` (the burst scenario rotates over them), the rest `cards`.
 */
export function toManifest(rows, minBalance = 100_000n, burstCount = 1) {
  const funded = rows
    .filter((r) => r.status === 'active' && typeof r.processor_card_id === 'string' && r.processor_card_id.length > 0 && BigInt(r.balance_minor ?? '0') >= minBalance)
    .sort((a, b) => (BigInt(b.balance_minor) > BigInt(a.balance_minor) ? 1 : BigInt(b.balance_minor) < BigInt(a.balance_minor) ? -1 : 0));
  if (funded.length === 0) throw new Error('no active card is funded to the minimum balance');
  const burstCards = funded.slice(0, burstCount).map((r) => r.processor_card_id);
  const rest = funded.slice(burstCount).map((r) => r.processor_card_id);
  return { burstCards, cards: rest.length > 0 ? rest : burstCards };
}

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const cmd = args[0];
  if (cmd === 'manifest') {
    const input = value('input');
    if (!input) throw new Error('--input rows.json is required');
    const out = value('out') ?? fileURLToPath(new URL('./cards.json', import.meta.url));
    const manifest = toManifest(JSON.parse(fs.readFileSync(input, 'utf8')), BigInt(value('min-balance') ?? '100000'), Number(value('burst-cards') ?? burstCardsNeeded(5, 1)));
    fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${out}: ${manifest.cards.length} cards and ${manifest.burstCards.length} burst cards`);
  } else if (cmd === 'check') {
    const url = value('url');
    assertNotProd(url);
    const sig = process.env.JIT_SIGNATURE;
    const req = buildRequest({ kind: 'unknown_card', cardId: 'card_probe', authId: `lt_probe_${Date.now()}`, receivedAt: new Date().toISOString(), signature: sig });
    const res = await fetch(url, { method: 'POST', headers: req.headers, body: req.rawBody });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200 || body.result !== 'DECLINED') throw new Error(`probe failed: HTTP ${res.status}`);
    console.log(`probe ok: declined ${body.reason}`);
  } else {
    throw new Error('usage: seed.mjs manifest --input rows.json | seed.mjs check --url URL (with JIT_SIGNATURE set)');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
