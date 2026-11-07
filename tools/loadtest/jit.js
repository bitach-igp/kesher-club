// k6 load test for POST /v1/jit/card-authorizations (T-0055, REQ-CRD-003, RUN-02): signed card authorisations at LOAD_RPS
// (default 50, twice the pilot peak) with about 10 % declines, plus a burst of concurrent authorisations for ONE wallet
// (the T-0544 lock path). Exits non-zero when p99 passes 300 ms or more than 1 % of requests fail.
//
//   k6 run -e JIT_URL=https://jit.staging.example/v1/jit/card-authorizations -e JIT_SIGNATURE=sim tools/loadtest/jit.js
//
// A decline is a normal 200 answer, so it is not an HTTP failure; http_req_failed counts non-2xx/3xx answers and transport errors.
// The service FAILS CLOSED (jit.ts): a throw or a budget overrun is a 200 DECLINED with reason TIMEOUT, which http_req_failed
// cannot see. jit_timeout_rate (the share of answers that are TIMEOUT, the same event as jit.error) and jit_unexpected_rate
// (a non-200 or an unreadable answer) are gated too.
// Refuses to start for a URL that could be production (assertNotProd, run in the init context so no request is ever made).
/* global __ENV, __VU, open */
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';
import { assertNotProd, buildRequest, burstCardsNeeded, cardsNeeded, classify, pickKind } from './lib.mjs';

const JIT_URL = __ENV.JIT_URL;
assertNotProd(JIT_URL);
const SIGNATURE = __ENV.JIT_SIGNATURE;
if (!SIGNATURE) throw new Error('JIT_SIGNATURE is required (the simulator constant "sim" on a PROVIDER_CARD=sim staging)');

const RPS = Number(__ENV.LOAD_RPS || 50);
const DURATION = __ENV.LOAD_DURATION || '5m';
const BURST_SIZE = Number(__ENV.BURST_SIZE || 5);
const BURST_EVERY_S = Number(__ENV.BURST_EVERY_S || 1);
const DECLINE_SHARE = Number(__ENV.DECLINE_SHARE || 0.1);
if (!(RPS > 0)) throw new Error('LOAD_RPS must be a positive number');

// cards.json is made by seed.mjs: { "cards": [...], "burstCards": [...] } (processor card ids of funded, active cards).
const manifest = JSON.parse(open(__ENV.CARDS_FILE || './cards.json'));
const cards = manifest.cards;
const burstCards = manifest.burstCards;
if (!Array.isArray(cards) || cards.length === 0 || !Array.isArray(burstCards) || burstCards.length === 0) throw new Error('cards.json needs "cards" and "burstCards"; run seed.mjs first');
// The velocity rule (10 approvals per card in a sliding minute) would otherwise decline approve requests for the wrong reason.
const needCards = cardsNeeded(RPS, DECLINE_SHARE);
const needBurst = burstCardsNeeded(BURST_SIZE, BURST_EVERY_S);
if (cards.length < needCards || burstCards.length < needBurst) {
  const msg = `cards.json has ${cards.length} cards and ${burstCards.length} burst cards; ${RPS} req/s with a burst of ${BURST_SIZE} every ${BURST_EVERY_S}s needs ${needCards} and ${needBurst} to stay under the velocity rule`;
  if (__ENV.ALLOW_FEW_CARDS !== '1') throw new Error(`${msg} (set ALLOW_FEW_CARDS=1 for a smoke run)`);
  console.warn(`WARNING: ${msg}; velocity declines will be in the mix`);
}

const approved = new Counter('jit_approved');
const declined = new Counter('jit_declined');
const unexpected = new Counter('jit_unexpected');
const timeoutRate = new Rate('jit_timeout_rate');
const unexpectedRate = new Rate('jit_unexpected_rate');

export const options = {
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(20, Math.ceil(RPS / 2)),
      maxVUs: Math.max(100, RPS * 4),
      exec: 'steady',
    },
    // BURST_SIZE authorisations for one wallet in flight at the same moment, every BURST_EVERY_S seconds.
    burst: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: `${BURST_EVERY_S}s`,
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: 'burst',
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<300'],
    http_req_failed: ['rate<0.01'],
    jit_timeout_rate: ['rate<0.01'],
    jit_unexpected_rate: ['rate<0.01'],
    jit_unexpected: ['count<1'],
  },
};

let seq = 0;
let burstTurn = Math.floor(Math.random() * 1000);
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const nextAuthId = (prefix) => `lt_${RUN}_${prefix}_${__VU}_${++seq}`;

function note(res) {
  let body;
  try {
    body = res.json();
  } catch {
    body = undefined;
  }
  const k = classify(res.status, body);
  timeoutRate.add(k === 'timeout');
  unexpectedRate.add(k === 'unexpected');
  if (k === 'unexpected') unexpected.add(1);
  else if (k === 'approved') approved.add(1);
  else declined.add(1);
}

export function steady() {
  const kind = pickKind(Math.random(), DECLINE_SHARE);
  const card = cards[Math.floor(Math.random() * cards.length)];
  const r = buildRequest({ kind, cardId: card, authId: nextAuthId('s'), receivedAt: new Date().toISOString(), signature: SIGNATURE, amountMinor: String(100 + Math.floor(Math.random() * 1900)) });
  note(http.post(JIT_URL, r.rawBody, { headers: r.headers, tags: { kind } }));
}

export function burst() {
  // One wallet per burst, rotating, so a card stays under the velocity rule between its turns.
  const burstCard = burstCards[burstTurn++ % burstCards.length];
  const reqs = [];
  for (let i = 0; i < BURST_SIZE; i++) {
    const r = buildRequest({ kind: 'approve', cardId: burstCard, authId: nextAuthId('b'), receivedAt: new Date().toISOString(), signature: SIGNATURE, amountMinor: '500' });
    reqs.push(['POST', JIT_URL, r.rawBody, { headers: r.headers, tags: { kind: 'burst' } }]);
  }
  // http.batch sends them in parallel: the service sees them together and the funding wallet's lock decides which approve.
  for (const res of http.batch(reqs)) note(res);
}
