// Navigation seam. Screens get a `Router` through `useRouter()`; the real app binds expo-router
// (see README.md: a one-line adapter maps `useRouter` from expo-router onto this interface).
// Keeping the seam lets the view models and tests run without the Expo SDK.
import { createContext, useContext } from 'react';
import type { CopyKey } from './i18n.ts';

export type Href = string;

export interface Router {
  push(href: Href): void;
  replace(href: Href): void;
  back(): void;
}

export const RouterContext = createContext<Router | undefined>(undefined);
export const RouterProvider = RouterContext.Provider;

export function useRouter(): Router {
  const r = useContext(RouterContext);
  if (!r) throw new Error('RouterProvider is missing');
  return r;
}

/** Route params come from the URL on the real app; tests pass them directly. */
export const ParamsContext = createContext<Readonly<Record<string, string | undefined>>>({});
export const ParamsProvider = ParamsContext.Provider;
export const useParams = (): Readonly<Record<string, string | undefined>> => useContext(ParamsContext);

/** In-memory router for tests and previews. */
export function memoryRouter(initial: Href = '/'): Router & { history: Href[]; current: () => Href } {
  const history: Href[] = [initial];
  return {
    history,
    current: () => history[history.length - 1] ?? initial,
    push: (href) => void history.push(href),
    replace: (href) => void history.splice(history.length - 1, 1, href),
    back: () => void (history.length > 1 && history.pop()),
  };
}

/** Builds a route with query params; values are encoded, never trusted as structure. */
export function href(path: string, params: Record<string, string | undefined> = {}): Href {
  const q = Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return q ? `${path}?${q}` : path;
}

/** The five bottom tabs (T-0673): each is the root of a screen group that already exists, so no route moves and every deep link still lands where it did. */
export interface TabDef {
  key: 'home' | 'card' | 'club' | 'pay' | 'help';
  /** The first route segment of every screen the tab owns. */
  root: string;
  href: Href;
  label: CopyKey;
  glyph: string;
}
export const TABS: readonly TabDef[] = [
  { key: 'home', root: '(tabs)', href: '/(tabs)/home', label: 'tabs.home', glyph: '⌂' },
  { key: 'card', root: 'card', href: '/card', label: 'tabs.card', glyph: '▭' },
  { key: 'club', root: 'club', href: '/club', label: 'tabs.club', glyph: '◇' },
  { key: 'pay', root: 'pay', href: '/pay', label: 'tabs.pay', glyph: '↗' },
  { key: 'help', root: 'help', href: '/help', label: 'tabs.help', glyph: '?' },
];

/** The tab a route belongs to, or undefined for a screen outside the tabs (sign-in, add money, wallet detail, settings). */
export const activeTab = (segments: readonly string[]): TabDef['key'] | undefined => TABS.find((t) => t.root === segments[0])?.key;

