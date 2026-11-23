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
  /** Bumped when the signed-in member changes (sign-out), so an answer for the previous member cannot land. */
  generation: number;
}

/** A stored value of an unexpected shape (a stub, an older server) is `system`, never `undefined`. */
export function asTheme(value: unknown): Theme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The one stored choice the whole app reads; `system` until a signed-in member's preference is known. */
export interface SharedAppearance {
  store: Store<SharedAppearanceState>;
}

export function createSharedAppearance(): SharedAppearance {
  return { store: createStore<SharedAppearanceState>({ theme: 'system', generation: 0 }) };
}

/** Sign-out: back to `system`, and every save or read still in flight for the previous member is orphaned. */
export function resetSharedAppearance(shared: SharedAppearance): void {
  shared.store.set((s) => ({ theme: 'system', generation: s.generation + 1 }));
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
  /** Writes to the shared store only while the member who started them is still signed in. */
  const writer = () => {
    const generation = shared.store.get().generation;
    return (theme: Theme) => {
      if (shared.store.get().generation === generation) shared.store.patch({ theme });
    };
  };
  const store = createStore<AppearanceState>({ status: 'idle', theme: shared.store.get().theme, saving: false });
  return {
    store,
    async load() {
      store.patch({ status: 'loading', error: undefined });
      const share = writer();
      try {
        const p = await deps.preferences.get();
        store.patch({ status: 'ready', theme: p.theme });
        share(p.theme);
      } catch {
        store.patch({ status: 'error', error: 'common.error.generic' });
      }
    },
    async choose(value) {
      const s = store.get();
      if (s.saving || value === s.theme) return;
      const previous = s.theme;
      store.patch({ theme: value, saving: true, notice: undefined, error: undefined });
      const share = writer();
      share(value);
      try {
        const p = await deps.preferences.set({ theme: value });
        store.patch({ theme: p.theme, saving: false, notice: 'appearance.saved' });
        share(p.theme);
      } catch {
        store.patch({ theme: previous, saving: false, error: 'appearance.saveFailed' });
        share(previous);
      }
    },
  };
}
