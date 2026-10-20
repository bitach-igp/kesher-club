// T-0608 TST-INS-004 (who may act), at the console's door: a member token lands on "no institution access",
// never data; an org_finance token reaches the dashboard for its own institution only; an expired token
// refreshes once, then signs out.
import { describe, expect, it } from 'vitest';
import { ApiError } from '@kesher/sdk';
import type { ConsoleApi, MyInstitution, TokenPair } from './api.ts';
import { cookieOptions, cookieWrites, decodeLanding, encodeLanding, resolveSession } from './session.ts';

const YESHIVA = '0190a0a0-0000-7000-8000-0000000000f1';
const OTHER = '0190a0a0-0000-7000-8000-0000000000f2';
const mine: MyInstitution = { institution: { id: YESHIVA, name: 'Yeshivat Kesher (demo)', market: 'IL' }, role: 'finance', paymentReference: 'KC-7M4QX2HD' };
const pair = (n: number): TokenPair => ({ accessToken: `access-${n}`, refreshToken: `refresh-${n}`, accessExpiresAt: '2026-11-01T09:10:00Z' });
const problem = (status: number, code: string) => new ApiError(status, { type: 'about:blank', title: code, status, code } as never);

/** An API whose /me/institution answers per access token, and whose refresh hands out the next pair. */
function fakeApi(byToken: Record<string, MyInstitution | number>, refreshes: (TokenPair | number)[] = []) {
  const calls = { me: [] as string[], refresh: [] as [string, string][] };
  const api: ConsoleApi = {
    async myInstitution(token) {
      calls.me.push(token);
      const r = byToken[token] ?? 401;
      if (typeof r === 'number') throw problem(r, r === 403 ? 'FORBIDDEN' : 'UNAUTHENTICATED');
      return r;
    },
    async refresh(token, device) {
      calls.refresh.push([token, device]);
      const r = refreshes.shift() ?? 401;
      if (typeof r === 'number') throw problem(r, 'UNAUTHENTICATED');
      return r;
    },
  };
  return { api, calls };
}

describe('console session (T-0608, TST-INS-004)', () => {
  it('without tokens the console is signed out and asks the API nothing', async () => {
    const { api, calls } = fakeApi({});
    expect(await resolveSession(api, {})).toEqual({ landing: { kind: 'signed_out' } });
    expect(calls.me).toEqual([]);
  });

  it('a member token lands on no institution access, never data, and keeps its cookies', async () => {
    const { api } = fakeApi({ 'member-access': 403 });
    expect(await resolveSession(api, { access: 'member-access', refresh: 'r', device: 'd' })).toEqual({ landing: { kind: 'no_access' } });
  });

  it('an org_finance token reaches the dashboard of its own institution only', async () => {
    const { api } = fakeApi({ 'finance-access': mine });
    expect(await resolveSession(api, { access: 'finance-access' })).toEqual({ landing: { kind: 'dashboard', ...mine }, access: 'finance-access' });
    expect((await resolveSession(api, { access: 'finance-access' }, YESHIVA)).landing.kind).toBe('dashboard');
    expect((await resolveSession(api, { access: 'finance-access' }, OTHER)).landing).toEqual({ kind: 'no_access' });
  });

  it('an expired token refreshes once, writes the rotated pair, and lands', async () => {
    const { api, calls } = fakeApi({ 'access-2': mine }, [pair(2)]);
    const r = await resolveSession(api, { access: 'expired', refresh: 'refresh-1', device: 'console-1' });
    expect(r).toEqual({ landing: { kind: 'dashboard', ...mine }, write: pair(2), access: 'access-2' });
    expect(calls.refresh).toEqual([['refresh-1', 'console-1']]);
    expect(calls.me).toEqual(['expired', 'access-2']);
  });

  it('a dropped access cookie refreshes from the refresh cookie alone', async () => {
    const { api } = fakeApi({ 'access-3': mine }, [pair(3)]);
    expect(await resolveSession(api, { refresh: 'refresh-2', device: 'console-1' })).toMatchObject({ landing: { kind: 'dashboard' }, write: pair(3) });
  });

  it('a failed refresh signs out and clears the cookies, without a second refresh', async () => {
    const { api, calls } = fakeApi({}, [401, pair(9)]);
    expect(await resolveSession(api, { access: 'expired', refresh: 'reused', device: 'console-1' })).toEqual({ landing: { kind: 'signed_out' }, write: 'clear' });
    expect(calls.refresh).toHaveLength(1);
  });

  it('a refreshed token the API still refuses signs out: refresh happens once per request', async () => {
    const { api, calls } = fakeApi({ 'access-4': 401 }, [pair(4), pair(5)]);
    expect(await resolveSession(api, { access: 'expired', refresh: 'refresh-3', device: 'console-1' })).toEqual({ landing: { kind: 'signed_out' }, write: 'clear' });
    expect(calls.refresh).toHaveLength(1);
  });

  it('an expired token with no device to refresh for signs out', async () => {
    const { api, calls } = fakeApi({});
    expect(await resolveSession(api, { access: 'expired', refresh: 'refresh-1' })).toEqual({ landing: { kind: 'signed_out' }, write: 'clear' });
    expect(calls.refresh).toEqual([]);
  });

  it('an API outage is an error, not a sign-out', async () => {
    const { api } = fakeApi({ 'finance-access': 503 });
    await expect(resolveSession(api, { access: 'finance-access' })).rejects.toBeInstanceOf(ApiError);
  });

  it('session cookies are httpOnly and same-site strict, and Secure everywhere but a local console', () => {
    expect(cookieOptions('production', 600)).toEqual({ httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: 600 });
    expect(cookieOptions('local', 600).secure).toBe(false);
    const now = new Date('2026-11-01T09:00:00Z');
    expect(cookieWrites(pair(2), 'production', now).map((w) => [w.name, w.value, w.options.maxAge])).toEqual([
      ['kesher_console_access', 'access-2', 600],
      ['kesher_console_refresh', 'refresh-2', 30 * 24 * 3600],
    ]);
    expect(cookieWrites('clear', 'production', now).map((w) => [w.name, w.value, w.options.maxAge])).toEqual([
      ['kesher_console_access', '', 0],
      ['kesher_console_refresh', '', 0],
    ]);
    expect(cookieWrites(undefined, 'production', now)).toEqual([]);
  });

  it('the landing survives the header round trip with a Hebrew name, and garbage reads as signed out', () => {
    const landing = { kind: 'dashboard' as const, ...mine, institution: { ...mine.institution, name: 'ישיבת קשר' } };
    const header = encodeLanding(landing);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeLanding(header)).toEqual(landing);
    expect(decodeLanding('%E0%A4%A')).toEqual({ kind: 'signed_out' });
    expect(decodeLanding(null)).toEqual({ kind: 'signed_out' });
  });
});
