// Institution console session (T-0608, REQ-INS-004 "who may act"). Staff sign in with the member passkey
// they already have; the console's server keeps the access and refresh tokens in httpOnly cookies. Every
// page request resolves the session here, in the proxy, before any page renders:
// - no tokens: signed out;
// - the API answers 401: refresh once with the device's refresh token, then try again; a second 401 or a
//   failed refresh signs out and clears the cookies;
// - the API answers 403 (no org role on the token, or no active staff row): "no institution access",
//   never institution data; the person's own token still reaches the page, for I01's application (T-0633);
// - otherwise the institution and role the API names, and only that institution.
import { statusOf, type ConsoleApi, type MyInstitution, type TokenPair } from './api.ts';

export const ACCESS_COOKIE = 'kesher_console_access';
export const REFRESH_COOKIE = 'kesher_console_refresh';
export const DEVICE_COOKIE = 'kesher_console_device';
/** The landing the proxy resolved, passed to the pages on a request header only the proxy writes. */
export const LANDING_HEADER = 'x-kesher-console-landing';
/**
 * The access token the proxy resolved (refreshed when it had to), for the pages and server actions of the
 * same request: a cookie the proxy just rotated is not yet on the request. Server side only; the proxy
 * overwrites whatever a client sent.
 */
export const ACCESS_HEADER = 'x-kesher-console-access';
/** A step-up token (5 minutes, REQ-AUTH-006) for the next money action; httpOnly like the pair. */
export const STEP_UP_COOKIE = 'kesher_console_stepup';

export interface SessionCookies {
  access?: string | undefined;
  refresh?: string | undefined;
  device?: string | undefined;
}

export type Landing = { kind: 'signed_out' } | { kind: 'no_access' } | ({ kind: 'dashboard' } & MyInstitution);

export interface Resolved {
  landing: Landing;
  /** Cookies to write: the rotated pair after a refresh, or 'clear' when the session ended. */
  write?: TokenPair | 'clear';
  /** The access token that resolved the landing, for the rest of this request. */
  access?: string;
}

const signedOut: Resolved = { landing: { kind: 'signed_out' }, write: 'clear' };

export async function resolveSession(api: ConsoleApi, cookies: SessionCookies, requestedInstitutionId?: string): Promise<Resolved> {
  if (!cookies.access && !cookies.refresh) return { landing: { kind: 'signed_out' } };
  const land = (m: MyInstitution): Landing => (requestedInstitutionId && requestedInstitutionId !== m.institution.id ? { kind: 'no_access' } : { kind: 'dashboard', ...m });

  const first = cookies.access ? await attempt(api, cookies.access) : 401;
  if (typeof first === 'object') return { landing: land(first), access: cookies.access! };
  // No institution: the person may still be applying for one (I01, T-0633), as themselves.
  if (first === 403) return { landing: { kind: 'no_access' }, access: cookies.access! };
  if (first !== 401 || !cookies.refresh || !cookies.device) return signedOut;

  let pair: TokenPair;
  try {
    pair = await api.refresh(cookies.refresh, cookies.device);
  } catch (e) {
    if (statusOf(e) === undefined) throw e;
    return signedOut;
  }
  const second = await attempt(api, pair.accessToken);
  if (typeof second === 'object') return { landing: land(second), write: pair, access: pair.accessToken };
  if (second === 403) return { landing: { kind: 'no_access' }, write: pair, access: pair.accessToken };
  return signedOut;
}

/** The institution, or the API's status: 401 and 403 decide the landing; anything else is a failure to surface. */
async function attempt(api: ConsoleApi, accessToken: string): Promise<MyInstitution | number> {
  try {
    return await api.myInstitution(accessToken);
  } catch (e) {
    const status = statusOf(e);
    if (status === 401 || status === 403) return status;
    throw e;
  }
}

/** The cookie attributes every session cookie carries: httpOnly, same-site strict, Secure except on a local http console. */
export function cookieOptions(environment: string, maxAgeSeconds: number) {
  return { httpOnly: true, sameSite: 'strict' as const, secure: environment !== 'local', path: '/', maxAge: maxAgeSeconds };
}

/** Seconds until an ISO instant, never negative. */
export const secondsUntil = (iso: string, now: Date): number => Math.max(0, Math.floor((Date.parse(iso) - now.getTime()) / 1000));

/** The API's refresh lifetime (apps/api auth/tokens.ts REFRESH_TTL_MS); the API, not the cookie, enforces it. */
const REFRESH_COOKIE_SECONDS = 30 * 24 * 3600;
/** The console's install id outlives any one session, like the app's. */
export const DEVICE_COOKIE_SECONDS = 400 * 24 * 3600;

export interface CookieWrite {
  name: string;
  value: string;
  options: ReturnType<typeof cookieOptions>;
}

/**
 * The cookie writes for a resolved session or a fresh sign-in: the access cookie lives as long as the
 * access token, so a browser that dropped it refreshes from the refresh cookie; 'clear' expires both.
 */
export function cookieWrites(write: TokenPair | 'clear' | undefined, environment: string, now: Date): CookieWrite[] {
  if (!write) return [];
  if (write === 'clear') return [ACCESS_COOKIE, REFRESH_COOKIE].map((name) => ({ name, value: '', options: cookieOptions(environment, 0) }));
  return [
    { name: ACCESS_COOKIE, value: write.accessToken, options: cookieOptions(environment, secondsUntil(write.accessExpiresAt, now)) },
    { name: REFRESH_COOKIE, value: write.refreshToken, options: cookieOptions(environment, REFRESH_COOKIE_SECONDS) },
  ];
}

/** The landing travels to the pages URI-encoded: institution names are not ASCII, header values must be. */
export const encodeLanding = (l: Landing): string => encodeURIComponent(JSON.stringify(l));
export function decodeLanding(raw: string | null | undefined): Landing {
  if (!raw) return { kind: 'signed_out' };
  try {
    return JSON.parse(decodeURIComponent(raw)) as Landing;
  } catch {
    return { kind: 'signed_out' };
  }
}
