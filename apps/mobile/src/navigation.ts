// Navigation seam. Screens get a `Router` through `useRouter()`; the real app binds expo-router
// (see README.md: a one-line adapter maps `useRouter` from expo-router onto this interface).
// Keeping the seam lets the view models and tests run without the Expo SDK.
import { createContext, useContext } from 'react';

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
