// Tests for tools/loadtest (T-0055). Run with `node --test tools/loadtest/*.test.mjs` (the root `pnpm test` does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardIssuingSimulator } from '../../packages/ports/src/card-issuing.simulator.ts';
import { assertNotProd, buildRequest, burstCardsNeeded, cardsNeeded, classify, DECLINE_KINDS, DECLINE_SHARE, pickKind, signHeaders } from './lib.mjs';
import { toManifest } from './seed.mjs';

const OK = 'https://jit.staging.kesher.example/v1/jit/card-authorizations';

test('the prod guard accepts hosts inside the staging zone and local addresses', () => {
  for (const u of [OK, 'https://staging.kesher.example/v1/jit/card-authorizations', 'https://a.b.staging.kesher.example/v1/jit/card-authorizations/', 'http://localhost:8080/v1/jit/card-authorizations', 'http://127.0.0.1:3000/v1/jit/card-authorizations']) {
    assert.doesNotThrow(() => assertNotProd(u), u);
  }
});

test('the prod guard refuses prod-looking and foreign hosts, odd schemes and other paths', () => {
  for (const u of [
    'https://jit.kesher.example/v1/jit/card-authorizations',
    'https://jit.prod.kesher.example/v1/jit/card-authorizations',
    'https://jit.live.staging.kesher.example/v1/jit/card-authorizations',
    'https://jit.staging.kesher.example.evil.test/v1/jit/card-authorizations',
    'https://notstaging.kesher.example/v1/jit/card-authorizations',
    'https://jit-stg.example.com/v1/jit/card-authorizations',
    'https://pr-1.preview.example.com/v1/jit/card-authorizations',
    'https://JIT.STAGING.KESHER.EXAMPLE/v1/jit/card-authorizations',
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

test('the prod guard refuses a backslash, tab, newline, userinfo or odd host characters that a URL parser would read as another host', () => {
  for (const u of [
    'https://jit.kesher.club\\x.staging.kesher.example/v1/jit/card-authorizations',
    'https://jit.kesher.club\\@x.staging.kesher.example/v1/jit/card-authorizations',
    'https://jit.kesher.club\t.staging.kesher.example/v1/jit/card-authorizations',
    'https://jit.kesher.club\n.staging.kesher.example/v1/jit/card-authorizations',
    ' https://jit.staging.kesher.example/v1/jit/card-authorizations',
    'https://user:pw@jit.staging.kesher.example/v1/jit/card-authorizations',
    'https://jit.staging.kesher.example@jit.prod.kesher.example/v1/jit/card-authorizations',
    'https://jit.staging.kesher.example@evil.test/v1/jit/card-authorizations',
    'https://jit_x.staging.kesher.example/v1/jit/card-authorizations',
    'https://jit..staging.kesher.example/v1/jit/card-authorizations',
    'https://.staging.kesher.example/v1/jit/card-authorizations',
  ]) {
    assert.throws(() => assertNotProd(u), /refusing to run/, JSON.stringify(u));
  }
});

test('the velocity rule sets how many cards a run needs: 270 at 50 req/s, and 30 burst cards for 5 per second', () => {
  assert.equal(cardsNeeded(50), 270);
  assert.equal(cardsNeeded(25), 135);
  assert.equal(cardsNeeded(50, 0), 300);
  assert.equal(burstCardsNeeded(5, 1), 30);
  assert.equal(burstCardsNeeded(5, 2), 15);
});

test('an answer is classified so a fail-closed TIMEOUT decline is counted as an error and a plain decline is not', () => {
  assert.equal(classify(200, { result: 'APPROVED' }), 'approved');
  assert.equal(classify(200, { result: 'DECLINED', reason: 'INSUFFICIENT_FUNDS' }), 'declined');
  assert.equal(classify(200, { result: 'DECLINED', reason: 'TIMEOUT' }), 'timeout');
  assert.equal(classify(500, { result: 'APPROVED' }), 'unexpected');
  assert.equal(classify(200, undefined), 'unexpected');
  assert.equal(classify(200, { result: 'MAYBE' }), 'unexpected');
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

test('the seed manifest keeps funded active cards, takes the richest as burst cards and compares bigint balances', () => {
  const rows = [
    { processor_card_id: 'c1', status: 'active', balance_minor: '500000' },
    { processor_card_id: 'c2', status: 'frozen', balance_minor: '900000000' },
    { processor_card_id: 'c3', status: 'active', balance_minor: '9000000000000000000000' },
    { processor_card_id: 'c4', status: 'active', balance_minor: '50' },
    { processor_card_id: 'c5', status: 'active', balance_minor: '700000' },
  ];
  assert.deepEqual(toManifest(rows), { burstCards: ['c3'], cards: ['c5', 'c1'] });
  assert.deepEqual(toManifest(rows, 100_000n, 2), { burstCards: ['c3', 'c5'], cards: ['c1'] });
  assert.throws(() => toManifest([{ processor_card_id: 'c4', status: 'active', balance_minor: '50' }]), /funded/);
});
