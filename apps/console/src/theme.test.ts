// T-1022 TST-UX-003: the console renders the member's appearance on the server. `light` is an explicit attribute (omitting it
// would let a dark system apply); `system`, signed out, an unknown value and any failure render no attribute.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { memberApi } from './api.ts';
import { COPY } from './i18n.ts';
import { asTheme, htmlThemeAttr, resolveTheme, saveTheme, THEME_OPTIONS, THEME_TIMEOUT_MS } from './theme.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, rel), 'utf8');
const prefs = (theme: unknown) => async () => ({ receiveCurrency: 'as_sent', theme, updatedAt: '2026-11-23T10:00:00.000Z' });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

describe('TST-UX-003 htmlThemeAttr', () => {
  it('dark is data-theme dark, light is an explicit data-theme light (not empty), system is nothing', () => {
    expect(htmlThemeAttr('dark')).toEqual({ 'data-theme': 'dark' });
    expect(htmlThemeAttr('light')).toEqual({ 'data-theme': 'light' });
    expect(htmlThemeAttr('system')).toEqual({});
  });

  it('undefined, null, an unknown string and a non-string all render system: the server never throws on a bad preference', () => {
    for (const bad of [undefined, null, '', 'Dark', 'LIGHT', 'sepia', 'dark ', 0, {}, ['dark']]) expect(htmlThemeAttr(bad), String(bad)).toEqual({});
    expect(Object.keys(htmlThemeAttr('system'))).toEqual([]);
  });

  it('asTheme keeps the three values and sends everything else to system', () => {
    expect(['system', 'light', 'dark'].map(asTheme)).toEqual(['system', 'light', 'dark']);
    expect(asTheme('x')).toBe('system');
  });
});

describe('TST-UX-003 resolveTheme', () => {
  it('signed out: no lookup at all', async () => {
    const fetchPrefs = vi.fn(prefs('dark'));
    expect(await resolveTheme(fetchPrefs, false)).toBe('system');
    expect(fetchPrefs).not.toHaveBeenCalled();
  });

  it('signed in: the stored theme, each of the three', async () => {
    for (const theme of ['system', 'light', 'dark'] as const) expect(await resolveTheme(prefs(theme), true)).toBe(theme);
  });

  it('an unknown or missing stored value is system', async () => {
    expect(await resolveTheme(prefs('sepia'), true)).toBe('system');
    expect(await resolveTheme(prefs(undefined), true)).toBe('system');
    expect(await resolveTheme((async () => null) as never, true)).toBe('system');
  });

  it('a refused lookup (an error, an expired token, a 5xx) is system and never throws', async () => {
    expect(await resolveTheme(async () => { throw new Error('boom'); }, true)).toBe('system');
    const api = memberApi('http://api.test', 'expired', { fetch: async () => json(401, { type: 'x', title: 'Unauthorized', status: 401, code: 'UNAUTHENTICATED' }) });
    expect(await resolveTheme((signal) => api.preferences(signal), true)).toBe('system');
    const down = memberApi('http://api.test', 'tok', { fetch: async () => json(503, { type: 'x', title: 'Unavailable', status: 503, code: 'PROVIDER_UNAVAILABLE' }) });
    expect(await resolveTheme((signal) => down.preferences(signal), true)).toBe('system');
  });

  it('a slow lookup gives up at the timeout and aborts the request, even when the fetch ignores the abort', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const slow = (signal: AbortSignal) => {
        signal.addEventListener('abort', () => { aborted = true; });
        return new Promise<never>(() => {});
      };
      const p = resolveTheme(slow, true);
      let done = false;
      void p.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(THEME_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe('system');
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fast lookup does not wait for the timeout and leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      expect(await resolveTheme(prefs('light'), true)).toBe('light');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the timeout is short: a theme must never hold the page for long', () => {
    expect(THEME_TIMEOUT_MS).toBeGreaterThan(0);
    expect(THEME_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });
});

describe('TST-UX-003 memberApi.preferences and setTheme', () => {
  it('preferences reads GET /me/preferences with the member bearer and the signal', async () => {
    const seen: { url: string; method: string; auth: string | null; signal: boolean }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      seen.push({ url: req.url, method: req.method, auth: req.headers.get('authorization'), signal: init?.signal !== undefined });
      return json(200, { receiveCurrency: 'as_sent', theme: 'dark', updatedAt: '2026-11-23T10:00:00.000Z' });
    };
    const ac = new AbortController();
    const got = await memberApi('http://api.test', 'tok-1', { fetch: fetchStub }).preferences(ac.signal);
    expect(got.theme).toBe('dark');
    expect(seen).toEqual([{ url: 'http://api.test/me/preferences', method: 'GET', auth: 'Bearer tok-1', signal: true }]);
  });

  it('setTheme round trip: PATCH /me/preferences with exactly { theme } and the member bearer', async () => {
    const seen: { method: string; url: string; auth: string | null; body: string }[] = [];
    let stored = 'system';
    const fetchStub: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      const body = await req.text();
      seen.push({ method: req.method, url: req.url, auth: req.headers.get('authorization'), body });
      if (req.method === 'PATCH') stored = (JSON.parse(body) as { theme: string }).theme;
      return json(200, { receiveCurrency: 'as_sent', theme: stored, updatedAt: '2026-11-23T10:00:00.000Z' });
    };
    const api = memberApi('http://api.test', 'tok-2', { fetch: fetchStub });
    const after = await api.setTheme('dark');
    expect(after.theme).toBe('dark');
    expect(seen).toEqual([{ method: 'PATCH', url: 'http://api.test/me/preferences', auth: 'Bearer tok-2', body: '{"theme":"dark"}' }]);
    expect(await resolveTheme((s) => api.preferences(s), true)).toBe('dark');
  });
});

describe('TST-UX-003 saveTheme (the server action body)', () => {
  it.each(['system', 'light', 'dark'] as const)('sends { theme: %s } and answers the new theme', async (theme) => {
    const setTheme = vi.fn(async (t: string) => ({ receiveCurrency: 'as_sent', theme: t, updatedAt: 'x' }));
    expect(await saveTheme({ setTheme } as never, theme)).toEqual({ ok: true, value: theme });
    expect(setTheme).toHaveBeenCalledExactlyOnceWith(theme);
  });

  it('an unknown value is refused before any call', async () => {
    const setTheme = vi.fn();
    for (const bad of ['sepia', '', 'Dark', undefined, null, 1]) expect(await saveTheme({ setTheme } as never, bad), String(bad)).toEqual({ ok: false, code: 'VALIDATION_FAILED' });
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('a refused PATCH answers the API code and no theme', async () => {
    const api = memberApi('http://api.test', 'tok', { fetch: async () => json(422, { type: 'x', title: 'Invalid', status: 422, code: 'VALIDATION_FAILED' }) });
    expect(await saveTheme(api, 'dark')).toEqual({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('a non-API failure (the network) is thrown, not hidden as a saved theme', async () => {
    await expect(saveTheme({ setTheme: async () => { throw new TypeError('fetch failed'); } } as never, 'dark')).rejects.toThrow('fetch failed');
  });
});

describe('TST-UX-003 the control', () => {
  it('offers exactly System, Light, Dark in that order, each with copy in both languages', () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(['system', 'light', 'dark']);
    expect(THEME_OPTIONS.map((o) => o.key)).toEqual(['appearance.system', 'appearance.light', 'appearance.dark']);
    for (const o of THEME_OPTIONS) {
      expect(COPY.en[o.key]).toBeTruthy();
      expect(COPY.he[o.key]).not.toBe(COPY.en[o.key]);
    }
  });

  it('the page posts each option value as the form field "theme" to the server action, and the action reads that field', () => {
    const page = read('../app/appearance/page.tsx');
    const actions = read('../app/appearance/actions.ts');
    expect(page).toMatch(/name="theme"/);
    expect(page).toMatch(/value=\{o\.value\}/);
    expect(page).toMatch(/THEME_OPTIONS\.map/);
    expect(page).toMatch(/action=\{setTheme\}/);
    expect(page).not.toMatch(/<script|localStorage|dangerouslySetInnerHTML/);
    expect(actions).toMatch(/^'use server';/);
    expect(actions).toMatch(/formData\.get\('theme'\)/);
    expect(actions).toMatch(/saveTheme\(/);
    expect(actions).toMatch(/revalidatePath\('\/', 'layout'\)/);
    expect(actions).toMatch(/redirect\('\/appearance\?saved=1'\)/);
    expect(actions).toMatch(/redirect\('\/appearance\?error=1'\)/);
  });

  it('the nav links to /appearance for signed-in staff', () => {
    expect(read('../app/layout.tsx')).toMatch(/<a href="\/appearance">\{t\('nav\.appearance', locale\)\}<\/a>/);
  });
});

describe('TST-UX-003 the layout never leaks the token and never touches apps/web or apps/admin', () => {
  it('the layout hands the client a theme name only: the access token is read for the lookup and never rendered', () => {
    const layout = read('../app/layout.tsx');
    expect(layout).toMatch(/const access = h\.get\(ACCESS_HEADER\) \?\? undefined;/);
    expect(layout).toMatch(/memberApi\(cfg\.CONSOLE_API_URL, access\)\.preferences\(signal\)/);
    expect(layout).toMatch(/, access !== undefined\);/); // signed out (no token) makes no call
    expect(read('../app/appearance/actions.ts')).toMatch(/memberApi\(getConfig\(\)\.CONSOLE_API_URL, access\)/);
    expect(layout).not.toMatch(/accessToken|\{access\}|data-access|\$\{access/);
    // `access` appears only where the lookup is made: the guard, the call, and the signed-in flag.
    const uses = layout.split('\n').filter((l) => /\baccess\b/.test(l) && !/ACCESS_HEADER/.test(l) && !/^\s*\/\//.test(l));
    expect(uses).toHaveLength(1);
  });
});
