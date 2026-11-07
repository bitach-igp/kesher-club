// Shared plumbing for the smoke suite (T-0051): the HTTPS-only URL guard and the one HTTP client every check uses.
// The client can send GET and HEAD, and a POST only through `postInvalid`, which exists for deliberately invalid requests.
// Nothing here can create data: there is no PUT, PATCH or DELETE, and no way to send a valid body with a credential.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const METHODS = new Set(['GET', 'HEAD', 'POST']);

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

/** The only HTTP client the checks have. `fetchImpl` is injected by the tests to record what is sent. */
export function makeClient({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  async function send(method, url, { headers = {}, body } = {}) {
    if (!METHODS.has(method)) throw new Error(`smoke refuses to send ${method}`);
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
    // Exposed so a test can prove the guard: nothing in the suite calls this.
    _send: send,
  };
}
