// T-1022 (REQ-UX-003): the console renders the signed-in member's appearance on <html> on the server, on the first response.
// `light` and `dark` are explicit attributes (an omitted attribute lets a dark system apply the prefers-color-scheme rule);
// `system`, signed out, an unknown value and any failure render no attribute, so the device decides. Nothing here logs a value.
import { codeOf, type Result } from './api.ts';
import type { CopyKey } from './i18n.ts';

export type Theme = 'system' | 'light' | 'dark';

/** The appearance control's options, in the order the page shows them. */
export const THEME_OPTIONS: readonly { value: Theme; key: CopyKey }[] = [
  { value: 'system', key: 'appearance.system' },
  { value: 'light', key: 'appearance.light' },
  { value: 'dark', key: 'appearance.dark' },
];

/** The console has no request timeout of its own; the extra round trip must never hold a page for long. */
export const THEME_TIMEOUT_MS = 1500;

/** The stored value, or `system` for anything else. */
export const asTheme = (value: unknown): Theme => (value === 'light' || value === 'dark' ? value : 'system');

/** The attributes for <html>: explicit for light and dark, none for system (and for anything unknown). */
export function htmlThemeAttr(theme: unknown): { 'data-theme'?: 'light' | 'dark' } {
  const t = asTheme(theme);
  return t === 'system' ? {} : { 'data-theme': t };
}

/**
 * The member's theme for this request. Signed out: no call. A failure, an unknown value or a lookup slower than
 * `timeoutMs` is `system`; the request is aborted at the timeout and the page renders without it.
 */
export async function resolveTheme(fetchPreferences: (signal: AbortSignal) => Promise<{ theme?: unknown } | null | undefined>, signedIn: boolean, timeoutMs: number = THEME_TIMEOUT_MS): Promise<Theme> {
  if (!signedIn) return 'system';
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    const got = await Promise.race([fetchPreferences(ac.signal), slow]);
    return asTheme(got?.theme);
  } catch {
    return 'system';
  } finally {
    clearTimeout(timer);
  }
}

/** The server action's body: an unknown value is refused before any call; the API's refusal comes back as its code. */
export async function saveTheme(api: { setTheme(theme: Theme): Promise<unknown> }, value: unknown): Promise<Result<Theme>> {
  if (value !== 'system' && value !== 'light' && value !== 'dark') return { ok: false, code: 'VALIDATION_FAILED' };
  try {
    await api.setTheme(value);
    return { ok: true, value };
  } catch (e) {
    const code = codeOf(e);
    if (!code) throw e;
    return { ok: false, code };
  }
}
