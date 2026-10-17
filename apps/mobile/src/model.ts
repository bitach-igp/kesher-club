// Tiny observable store for view models. Models are plain objects over a Store so tests drive them
// without React; screens subscribe through `useStore` (useSyncExternalStore).
import { useSyncExternalStore } from 'react';

export interface Store<S> {
  get(): S;
  set(next: S | ((prev: S) => S)): void;
  patch(partial: Partial<S>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: S | ((prev: S) => S)) => {
    state = typeof next === 'function' ? (next as (prev: S) => S)(state) : next;
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    set,
    patch: (partial) => set({ ...state, ...partial }),
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Resolves after every currently queued microtask, for tests that await a model's async action. */
export const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
