// Shared by the k6 script (jit.js), the seed script and the workflow guard (T-0055). Plain ES module with no imports and no
// Node or k6 APIs, so it loads in both runtimes; the node test imports it directly.

/** The header the card simulator's `parseAuthorization` checks (packages/ports/src/card-issuing.simulator.ts). */
export const SIGNATURE_HEADER = 'x-sim-signature';

/** Where the JIT route lives; JIT_URL is the full URL including this path. */
export const JIT_PATH = '/v1/jit/card-authorizations';

/** The staging zone (infra/terraform/envs/staging/variables.tf, `domain`). A host is accepted only inside it, or as a local address. */
export const STAGING_ZONE = 'staging.kesher.example';
const PROD_WORDS = /(^|[.\-_])(prod|production|prd|live)([.\-_]|$)/i;

/** Parses the pieces of a URL the guard needs without the URL global (older k6 builds lack it). */
export function parseTarget(raw) {
  const m = /^(https?):\/\/([^/?#:]+)(?::(\d+))?([^?#]*)/.exec(String(raw ?? ''));
  if (!m) return undefined;
  return { scheme: m[1], host: m[2], port: m[3], path: m[4] || '/' };
}

/**
 * Throws unless `raw` is a JIT URL inside the staging zone (or localhost / 127.0.0.1). Refuses, before any label check:
 * anything but lower-case letters, digits, dots and hyphens in the host, and any backslash, whitespace, control character
 * or `@` anywhere before the path (WHATWG URL reads a backslash as a slash, strips tabs and newlines, and takes userinfo
 * off the host, so the regex could name one host and a client connect to another). Where `URL` exists it must agree.
 */
export function assertNotProd(raw) {
  const s = String(raw ?? '');
  if (s === '') throw new Error('JIT_URL is missing; refusing to run');
  const authority = /^[a-z]+:\/\/([^/?#]*)/i.exec(s)?.[1] ?? '';
  if (/[\\\s]/.test(s) || [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) || authority.includes('@')) {
    throw new Error('JIT_URL has a backslash, whitespace, control character or credentials; refusing to run');
  }
  const t = parseTarget(s);
  if (!t) throw new Error('JIT_URL is not a lower-case http(s) URL; refusing to run');
  if (!/^[a-z0-9.-]+$/.test(t.host) || t.host.startsWith('.') || t.host.endsWith('.') || t.host.includes('..')) throw new Error(`JIT_URL host "${t.host}" is not a plain lower-case host name; refusing to run`);
  if (typeof URL === 'function') {
    let parsed;
    try {
      parsed = new URL(s);
    } catch {
      throw new Error('JIT_URL does not parse as a URL; refusing to run');
    }
    if (parsed.hostname !== t.host) throw new Error('JIT_URL host is read differently by the URL parser; refusing to run');
  }
  const local = t.host === 'localhost' || t.host === '127.0.0.1';
  if (PROD_WORDS.test(t.host)) throw new Error(`JIT_URL host "${t.host}" looks like production; refusing to run`);
  if (!local && t.host !== STAGING_ZONE && !t.host.endsWith(`.${STAGING_ZONE}`)) throw new Error(`JIT_URL host "${t.host}" is not inside ${STAGING_ZONE} or local; refusing to run`);
  if (t.scheme !== 'https' && !local) throw new Error('JIT_URL must be https outside localhost; refusing to run');
  if (t.path.replace(/\/+$/, '') !== JIT_PATH) throw new Error(`JIT_URL path must be ${JIT_PATH}; refusing to run`);
  return t;
}

/**
 * Cards the steady scenario needs so the velocity rule (jit.ts VELOCITY_LIMIT_PER_MINUTE, approvals per card in a sliding
 * 60 s) never declines an approve request: ceil(rps x approve share x 60 / limit).
 */
export const VELOCITY_LIMIT_PER_MINUTE = 10;
export function cardsNeeded(rps, declineShare = DECLINE_SHARE, limit = VELOCITY_LIMIT_PER_MINUTE) {
  return Math.ceil((rps * (1 - declineShare) * 60) / limit);
}

/** Cards the burst scenario rotates through so no one card sees more than the velocity limit: ceil(size x 60 / (every seconds x limit)). */
export function burstCardsNeeded(size, everySeconds, limit = VELOCITY_LIMIT_PER_MINUTE) {
  return Math.ceil((size * 60) / (everySeconds * limit));
}

/** The error rate the gate watches that http_req_failed cannot see: the service failing closed answers 200 DECLINED TIMEOUT. */
export function classify(status, body) {
  if (status !== 200) return 'unexpected';
  if (body && body.result === 'APPROVED') return 'approved';
  if (body && body.result === 'DECLINED') return body.reason === 'TIMEOUT' ? 'timeout' : 'declined';
  return 'unexpected';
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
