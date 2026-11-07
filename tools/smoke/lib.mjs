// Shared plumbing for the smoke suite (T-0051): the HTTPS-only URL guard and the one HTTP client every check uses.
// The client can send GET and HEAD, and a POST only through `postInvalid`, which exists for deliberately invalid requests.
// Nothing here can create data: there is no PUT, PATCH or DELETE, and no way to send a valid body with a credential.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const METHODS = new Set(['GET', 'HEAD', 'POST']);
/** Headers that would authenticate a request: the suite never sends one (checked case-insensitively). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-auth-token']);

/** A check that cannot tell is not a pass: `skip` is reported, and `--strict` turns it into a failure. */
export class Skip extends Error {}
export class Fail extends Error {}
export const skip = (why) => {
  throw new Skip(why);
};
export const fail = (why) => {
  throw new Fail(why);
};

/**
 * Parses and vets one target URL. https only; http is accepted for a local address when `allowLocal` is set (the unit tests,
 * a developer's own machine). Credentials in the URL, odd characters and non-origin parts are refused.
 */
export function parseTarget(raw, label, { allowLocal = false } = {}) {
  const s = String(raw ?? '').trim();
  if (s === '') throw new Error(`${label} is empty`);
  if (/[\\\s]/.test(s)) throw new Error(`${label} has a backslash or whitespace; refusing`);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${label} is not a URL: ${s}`);
  }
  if (u.username || u.password) throw new Error(`${label} carries credentials; refusing`);
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol === 'http:') {
    if (!(allowLocal && local)) throw new Error(`${label} must be https:// (http is refused${local ? ' unless --allow-local is set' : ''}): ${s}`);
  } else if (u.protocol !== 'https:') {
    throw new Error(`${label} must be https://: ${s}`);
  }
  return { url: u, origin: u.origin, host: u.hostname, port: u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port), https: u.protocol === 'https:', local };
}

/**
 * A path on a vetted target: must start with a single '/', and must resolve to the target's own origin (a string join of
 * '.evil.example/x' or '//evil.example' would not). Returns the URL string.
 */
export function targetUrl(target, p, label = 'path') {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || /[\\\s]/.test(p)) throw new Error(`${label} must start with a single "/" and have no backslash or whitespace: ${p}`);
  const u = new URL(p, target.origin);
  if (u.origin !== target.origin) throw new Error(`${label} leaves the target origin: ${p}`);
  return u.href;
}

/** The only HTTP client the checks have. `fetchImpl` is injected by the tests to record what is sent. */
export function makeClient({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  async function send(method, url, { headers = {}, body } = {}) {
    if (!METHODS.has(method)) throw new Error(`smoke refuses to send ${method}`);
    for (const k of Object.keys(headers)) if (CREDENTIAL_HEADERS.has(k.toLowerCase())) throw new Error(`smoke never sends a credential (${k})`);
    const res = await fetchImpl(url, {
      method,
      headers,
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body }),
    });
    const text = method === 'HEAD' ? '' : await res.text();
    const header = (n) => res.headers.get(n) ?? undefined;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, header, text, json };
  }
  return {
    get: (url, opts) => send('GET', url, opts),
    head: (url, opts) => send('HEAD', url, opts),
    /** A POST that is meant to be refused: the caller passes a body and headers that cannot be valid. */
    postInvalid: (url, body, headers = {}) => send('POST', url, { body, headers: { 'content-type': 'application/json', ...headers } }),
  };
}
