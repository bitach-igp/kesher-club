// REQ-UX-003 (T-1021): System, Light or Dark, stored on the account (T-1020) and applied at once. The stored
// choice must reach every screen from one place, so it lives in one shared store that the root layout owns
// (seeded after sign-in, reset on sign-out, read to mount the theme override); this model writes through it.
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { PreferencesApi, Theme } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { ThemeMode } from '../../src/theme.ts';

export const APPEARANCE_OPTIONS: readonly { value: Theme; label: CopyKey; helper?: CopyKey }[] = [
  { value: 'system', label: 'appearance.system', helper: 'appearance.systemHelper' },
  { value: 'light', label: 'appearance.light' },
  { value: 'dark', label: 'appearance.dark' },
];

/** `system` is no override, so the context falls through to the phone's own setting. */
export function overrideOf(theme: Theme): ThemeMode | undefined {
  return theme === 'system' ? undefined : theme;
}

export interface SharedAppearanceState {
  theme: Theme;
}

/** The one stored choice the whole app reads; `system` until a signed-in member's preference is known. */
export interface SharedAppearance {
  store: Store<SharedAppearanceState>;
}

export function createSharedAppearance(): SharedAppearance {
  return { store: createStore<SharedAppearanceState>({ theme: 'system' }) };
}

const SharedAppearanceContext = createContext<SharedAppearance | undefined>(undefined);

export function SharedAppearanceProvider({ value, children }: { value: SharedAppearance; children?: ReactNode }) {
  return createElement(SharedAppearanceContext.Provider, { value }, children);
}

export function useSharedAppearance(): SharedAppearance {
  const shared = useContext(SharedAppearanceContext);
  if (!shared) throw new Error('SharedAppearanceProvider is missing');
  return shared;
}

export interface AppearanceState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  theme: Theme;
  saving: boolean;
  notice?: CopyKey | undefined;
  error?: CopyKey | undefined;
}

export interface AppearanceModel {
  store: Store<AppearanceState>;
  load(): Promise<void>;
  choose(value: Theme): Promise<void>;
}

export function createAppearanceModel(deps: { preferences: PreferencesApi; shared: SharedAppearance }): AppearanceModel {
  const { shared } = deps;
  const store = createStore<AppearanceState>({ status: 'idle', theme: shared.store.get().theme, saving: false });
  return {
    store,
    async load() {
      store.patch({ status: 'loading', error: undefined });
      try {
        const p = await deps.preferences.get();
        store.patch({ status: 'ready', theme: p.theme });
        shared.store.patch({ theme: p.theme });
      } catch {
        store.patch({ status: 'error', error: 'common.error.generic' });
      }
    },
    async choose(value) {
      const s = store.get();
      if (s.saving || value === s.theme) return;
      const previous = s.theme;
      store.patch({ theme: value, saving: true, notice: undefined, error: undefined });
      shared.store.patch({ theme: value });
      try {
        const p = await deps.preferences.set({ theme: value });
        store.patch({ theme: p.theme, saving: false, notice: 'appearance.saved' });
        shared.store.patch({ theme: p.theme });
      } catch {
        store.patch({ theme: previous, saving: false, error: 'appearance.saveFailed' });
        shared.store.patch({ theme: previous });
      }
    },
  };
}
