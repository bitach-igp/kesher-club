// Tests for tools/loadtest (T-0055). Run with `node --test tools/loadtest/*.test.mjs` (the root `pnpm test` does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardIssuingSimulator } from '../../packages/ports/src/card-issuing.simulator.ts';
import { assertNotProd, buildRequest, DECLINE_KINDS, DECLINE_SHARE, pickKind, signHeaders } from './lib.mjs';
import { toManifest } from './seed.mjs';

const OK = 'https://jit.staging.kesher.example/v1/jit/card-authorizations';

test('the prod guard accepts staging, preview, sandbox and localhost hosts', () => {
  for (const u of [OK, 'https://jit-stg.example.com/v1/jit/card-authorizations', 'https://pr-12.preview.example.com/v1/jit/card-authorizations/', 'http://localhost:8080/v1/jit/card-authorizations', 'http://127.0.0.1:3000/v1/jit/card-authorizations']) {
    assert.doesNotThrow(() => assertNotProd(u), u);
  }
});

test('the prod guard refuses prod-looking hosts, unnamed hosts, odd schemes, credentials and other paths', () => {
  for (const u of [
    'https://jit.kesher.example/v1/jit/card-authorizations',
    'https://jit.prod.kesher.example/v1/jit/card-authorizations',
    'https://jit-production.kesher.example/v1/jit/card-authorizations',
    'https://jit.live.kesher.example/v1/jit/card-authorizations',
    'https://staging.prod.kesher.example/v1/jit/card-authorizations', // says both: prod wins
    'https://user:pw@jit.staging.kesher.example/v1/jit/card-authorizations',
    'https://staging.kesher.example@jit.prod.kesher.example/v1/jit/card-authorizations',
    'http://jit.staging.kesher.example/v1/jit/card-authorizations',
    'https://jit.staging.kesher.example/v1/cards',
    'ftp://jit.staging.kesher.example/v1/jit/card-authorizations',
    'jit.staging.kesher.example',
    '',
    undefined,
  ]) {
    assert.throws(() => assertNotProd(u), /refusing to run/, String(u));
  }
});

test('the signing function is accepted by the simulator real verification, and a wrong value is refused', async () => {
  const sim = new CardIssuingSimulator();
  const req = buildRequest({ kind: 'approve', cardId: 'card_000001', authId: 'lt_test_1', receivedAt: '2026-11-07T09:00:00.000Z', signature: 'sim', amountMinor: '1800' });
  const parsed = await sim.parseAuthorization(req.headers, req.rawBody);
  assert.equal(parsed.authId, 'lt_test_1');
  assert.equal(parsed.cardId, 'card_000001');
  assert.equal(parsed.amount.minor, 1800n);
  assert.equal(parsed.amount.currency, 'ILS');
  assert.equal(parsed.channel, 'pos');
  const bad = buildRequest({ kind: 'approve', cardId: 'card_000001', authId: 'lt_test_2', receivedAt: '2026-11-07T09:00:00.000Z', signature: 'not-sim' });
  await assert.rejects(() => sim.parseAuthorization(bad.headers, bad.rawBody), /signature/i);
  assert.throws(() => signHeaders(undefined), /JIT_SIGNATURE/);
});

test('a built request has the same keys and wire shape as the simulator authorize()', () => {
  const sim = new CardIssuingSimulator();
  const theirs = sim.authorize('card_000001', { amount: { minor: 1800n, currency: 'ILS' }, merchant: { name: 'x', mcc: '5814', country: 'IL' }, channel: 'pos' });
  const ours = buildRequest({ kind: 'approve', cardId: 'card_000001', authId: 'a', receivedAt: 'now', signature: 'sim' });
  assert.deepEqual(Object.keys(JSON.parse(ours.rawBody)).sort(), Object.keys(JSON.parse(theirs.rawBody)).sort());
  assert.equal(ours.headers['x-sim-signature'], theirs.headers['x-sim-signature']);
});

test('the decline mix is about 10 %, split between unknown cards and amounts no wallet holds', () => {
  assert.equal(DECLINE_SHARE, 0.1);
  const N = 10_000;
  const counts = { approve: 0, unknown_card: 0, insufficient_funds: 0 };
  for (let i = 0; i < N; i++) counts[pickKind((i + 0.5) / N)]++;
  assert.equal(counts.approve, 9_000);
  assert.equal(counts.unknown_card, 500);
  assert.equal(counts.insufficient_funds, 500);
  assert.deepEqual([...DECLINE_KINDS].sort(), ['insufficient_funds', 'unknown_card']);
  const unknown = JSON.parse(buildRequest({ kind: 'unknown_card', cardId: 'card_000001', authId: 'u1', receivedAt: 'now', signature: 'sim' }).rawBody);
  assert.notEqual(unknown.cardId, 'card_000001');
  const poor = JSON.parse(buildRequest({ kind: 'insufficient_funds', cardId: 'card_000001', authId: 'p1', receivedAt: 'now', signature: 'sim' }).rawBody);
  assert.ok(BigInt(poor.amount.minor) > 10n ** 12n);
});

test('the seed manifest keeps funded active cards, makes the richest the burst wallet and compares bigint balances', () => {
  const m = toManifest([
    { processor_card_id: 'c1', status: 'active', balance_minor: '500000' },
    { processor_card_id: 'c2', status: 'frozen', balance_minor: '900000000' },
    { processor_card_id: 'c3', status: 'active', balance_minor: '9000000000000000000000' },
    { processor_card_id: 'c4', status: 'active', balance_minor: '50' },
  ]);
  assert.deepEqual(m, { burstCard: 'c3', cards: ['c1'] });
  assert.throws(() => toManifest([{ processor_card_id: 'c4', status: 'active', balance_minor: '50' }]), /funded/);
});
