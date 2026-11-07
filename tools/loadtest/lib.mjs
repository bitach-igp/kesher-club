// Shared by the k6 script (jit.js), the seed script and the workflow guard (T-0055). Plain ES module with no imports and no
// Node or k6 APIs, so it loads in both runtimes; the node test imports it directly.

/** The header the card simulator's `parseAuthorization` checks (packages/ports/src/card-issuing.simulator.ts). */
export const SIGNATURE_HEADER = 'x-sim-signature';

/** Where the JIT route lives; JIT_URL is the full URL including this path. */
export const JIT_PATH = '/v1/jit/card-authorizations';

/** A host has to say it is not production AND say it is a test environment. Both lists are deliberately blunt. */
const PROD_WORDS = /(^|[.\-_])(prod|production|prd|live)([.\-_]|$)/i;
const TEST_WORDS = /(^|[.\-_])(staging|stage|stg|preview|sandbox|dev|localhost)([.\-_]|$)|^127\.0\.0\.1$/i;

/** Parses the pieces of a URL the guard needs without the URL global (older k6 builds lack it). */
export function parseTarget(raw) {
  const m = /^(https?):\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)(?::(\d+))?([^?#]*)/i.exec(String(raw ?? '').trim());
  if (!m) return undefined;
  return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), port: m[3], path: m[4] || '/' };
}

/**
 * Throws unless `raw` is a staging-looking JIT URL. Refuses an unparseable URL, a prod-looking host, a host that does
 * not name a test environment, a userinfo part (a credential or a host-spoofing trick), plain http outside localhost,
 * and any path but the JIT route.
 */
export function assertNotProd(raw) {
  const t = parseTarget(raw);
  if (!t) throw new Error('JIT_URL is missing or not an http(s) URL; refusing to run');
  if (/^(https?):\/\/[^/?#]*@/i.test(String(raw).trim())) throw new Error('JIT_URL must not carry credentials; refusing to run');
  if (PROD_WORDS.test(t.host)) throw new Error(`JIT_URL host "${t.host}" looks like production; refusing to run`);
  if (!TEST_WORDS.test(t.host)) throw new Error(`JIT_URL host "${t.host}" does not look like staging, preview, sandbox or local; refusing to run`);
  const local = t.host === 'localhost' || t.host === '127.0.0.1';
  if (t.scheme !== 'https' && !local) throw new Error('JIT_URL must be https outside localhost; refusing to run');
  if (t.path.replace(/\/+$/, '') !== JIT_PATH) throw new Error(`JIT_URL path must be ${JIT_PATH}; refusing to run`);
  return t;
}

/** The headers a request carries. `signature` is the processor's signing value for the target; for PROVIDER_CARD=sim it is the literal `sim`. */
export function signHeaders(signature) {
  if (!signature) throw new Error('JIT_SIGNATURE is required (for PROVIDER_CARD=sim on staging it is the simulator constant "sim")');
  return { 'content-type': 'application/json', [SIGNATURE_HEADER]: String(signature) };
}

/** Two decline recipes: a card the service has never seen, and an amount no wallet holds. */
export const DECLINE_KINDS = ['unknown_card', 'insufficient_funds'];
export const DECLINE_SHARE = 0.1;
const HUGE_MINOR = '99999999999999';

/** `r` is a number in [0, 1) (Math.random() in k6, a fixed value in tests). Below `share` the request is a decline, alternating kinds. */
export function pickKind(r, share = DECLINE_SHARE) {
  if (r >= share) return 'approve';
  return DECLINE_KINDS[Math.floor((r / share) * DECLINE_KINDS.length) % DECLINE_KINDS.length];
}

/**
 * One signed authorisation, byte-for-byte the shape `CardIssuingSimulator.authorize()` makes: JSON with the amount as a
 * wire Money (`minor` a string). `kind` is approve, unknown_card or insufficient_funds.
 */
export function buildRequest({ kind, cardId, authId, receivedAt, signature, amountMinor = '1200', currency = 'ILS' }) {
  const declined = kind === 'unknown_card' ? { cardId: `card_unknown_${authId}` } : {};
  const minor = kind === 'insufficient_funds' ? HUGE_MINOR : String(amountMinor);
  const body = {
    authId,
    cardId,
    amount: { minor, currency },
    merchant: { name: 'Load Test Cafe', mcc: '5814', country: 'IL' },
    channel: 'pos',
    receivedAt,
    ...declined,
  };
  return { headers: signHeaders(signature), rawBody: JSON.stringify(body) };
}
