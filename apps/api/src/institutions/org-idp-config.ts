// Boot validation of `AppOptions.orgIdp` (T-1123, REQ-AUTH-008): pure, no I/O. `consoleUrl` is the one place the SSO callback redirects the
// browser to (with `#code=` appended), `callbackUrl` is the redirect URI registered with the IdP. Both are refused unless they are plain
// origin-and-path URLs: https (http only for a literal loopback host and never in production), no userinfo, no query, no fragment (not even
// an empty one: it would give `##code=`), no whitespace, backslash or percent-escape in the authority. Messages name the option and the
// rule and never echo the value, which may hold a secret. Only ASCII is accepted (an IDN host is given in punycode): the value goes into a
// Location header and a registered redirect URI, and a non-Latin-1 character makes node's writeHead throw while a Latin-1 one is sent as a
// raw byte. Input must already be in canonical form (the parsed `origin + pathname`; a bare consoleUrl origin may omit its `/`), and is returned as typed, so what is sent (and registered with the IdP, which compares exactly) is byte for byte what was checked.
// The production "no loopback" rule is literal only: 127.0.0.2, 0.0.0.0, ::ffff:7f00:1, foo.localhost and private or link-local ranges pass.
// The URLs are operator-controlled configuration, not user input, so this is a guard against mistakes, not a network-policy check.

/** The only path the callback route is served at (contracts/openapi.yaml `/sso/callback` under the `/v1` server). */
export const SSO_CALLBACK_PATH = '/v1/sso/callback';
/**
 * `callbackFloorMs` is the least wall time the SSO callback takes, so a refusal before the IdP call costs the same as one after it (timing
 * uniformity). It delays EVERY callback, so it is bounded: an integer from 0 (no padding, for tests) to this many milliseconds.
 */
export const MAX_CALLBACK_FLOOR_MS = 5000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface OrgIdpUrlConfig { consoleUrl?: string | undefined; callbackUrl?: string | undefined; callbackFloorMs?: number | undefined }

function checkUrl(option: string, raw: string, production: boolean, bareOriginOk: boolean): URL {
  const fail = (rule: string): never => { throw new Error(`orgIdp.${option} ${rule}`); };
  if (/[\s\\]|[^\x21-\x7e]/.test(raw)) fail('must be ASCII only (give an IDN host in punycode) with no whitespace, control characters or backslash');
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^]*)$/.exec(raw);
  if (!m) return fail('must be an absolute https URL');
  const [, , authority = '', rest = ''] = m;
  if (!authority) fail('must have a host');
  if (authority.includes('@')) fail('must not contain userinfo');
  if (authority.includes('%')) fail('must not percent-encode its host');
  if (rest.includes('#') || rest.includes('?')) fail('must not contain a query or a fragment');
  let u: URL;
  try { u = new URL(raw); } catch { return fail('is not a valid URL'); }
  const rawHost = authority.replace(/:\d*$/, '').toLowerCase();
  const loopback = LOOPBACK.has(u.hostname) && LOOPBACK.has(rawHost);
  if (u.protocol === 'http:') {
    if (production) fail('must be https in production');
    if (!loopback) fail('may use http only for localhost, 127.0.0.1 or [::1]');
  } else if (u.protocol !== 'https:') fail('must be an https URL');
  if (!u.hostname || u.hostname.endsWith('.')) fail('must have a host without a trailing dot');
  if (LOOPBACK.has(u.hostname) && !loopback) fail('must spell a loopback host plainly');
  if (production && LOOPBACK.has(u.hostname)) fail('must not be a loopback host in production');
  if (u.port === '0') fail('must not use port 0');
  // Canonical form only: the string is sent as typed (Location header, WorkOS redirectUri, compared exactly there), so it must be the parsed one.
  const canon = u.origin + u.pathname;
  if (raw !== canon && !(bareOriginOk && `${raw}/` === canon)) fail('must be written in canonical form, e.g. lower-case host and no default port');
  return u;
}

/** Returns the two URLs when SSO is configured, `undefined` when neither is set; throws (boot refuses) on anything loose. */
export function validateOrgIdpConfig(c: OrgIdpUrlConfig | undefined, production: boolean): { consoleUrl: string; callbackUrl: string } | undefined {
  const ms = c?.callbackFloorMs;
  if (ms !== undefined && (!Number.isInteger(ms) || ms < 0 || ms > MAX_CALLBACK_FLOOR_MS)) {
    throw new Error(`orgIdp.callbackFloorMs must be an integer from 0 to ${MAX_CALLBACK_FLOOR_MS}`);
  }
  const { consoleUrl, callbackUrl } = c ?? {};
  if (!consoleUrl && !callbackUrl) return undefined;
  if (!consoleUrl || !callbackUrl) throw new Error('orgIdp.consoleUrl and orgIdp.callbackUrl must be set together');
  const con = checkUrl('consoleUrl', consoleUrl, production, true);
  const cb = checkUrl('callbackUrl', callbackUrl, production, false);
  if (callbackUrl.replace(/^[^:]*:\/\/[^/]*/, '') !== SSO_CALLBACK_PATH) throw new Error(`orgIdp.callbackUrl path must be exactly ${SSO_CALLBACK_PATH}`);
  if (cb.protocol !== con.protocol) throw new Error('orgIdp.callbackUrl must use the same scheme as orgIdp.consoleUrl');
  return { consoleUrl, callbackUrl };
}
