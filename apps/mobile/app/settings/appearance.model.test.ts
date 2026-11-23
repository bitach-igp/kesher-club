// REQ-UX-003 (T-1021, TST-UX-003): the member's appearance is System, Light or Dark. A choice shows at
// once, saves through /me/preferences and rolls back with a message when the server refuses it; `system`
// maps to no override so the phone decides, and the stored choice is written through one shared store
// that the root layout reads.
import { describe, expect, it } from 'vitest';
import type { Preferences, PreferencesApi, ReceiveCurrency, Theme } from '../../src/api.ts';
import { APPEARANCE_OPTIONS, createAppearanceModel, createSharedAppearance, overrideOf } from './appearance.model.ts';

function fakePreferences(opts: { failSet?: boolean; failGet?: boolean; initial?: Preferences } = {}) {
  let current: Preferences = opts.initial ?? { receiveCurrency: 'as_sent', theme: 'system' };
  const sets: { receiveCurrency?: ReceiveCurrency; theme?: Theme }[] = [];
  const gate: { release?: () => void } = {};
  const api: PreferencesApi = {
    get: async () => {
      if (opts.failGet) throw new Error('down');
      return current;
    },
    async set(patch) {
      sets.push(patch);
      await new Promise<void>((r) => (gate.release = r));
      if (opts.failSet) throw Object.assign(new Error('boom'), { status: 500 });
      current = { ...current, ...patch, updatedAt: '2026-11-23T09:00:00.000Z' };
      return current;
    },
  };
  return { api, sets, gate };
}

describe('Appearance (TST-UX-003)', () => {
  it('offers system, light and dark with their copy keys, and system explains itself', () => {
    expect(APPEARANCE_OPTIONS.map((o) => [o.value, o.label, o.helper])).toEqual([
      ['system', 'appearance.system', 'appearance.systemHelper'],
      ['light', 'appearance.light', undefined],
      ['dark', 'appearance.dark', undefined],
    ]);
  });

  it('overrideOf maps system to no override and light and dark to themselves', () => {
    expect(overrideOf('system')).toBeUndefined();
    expect(overrideOf('light')).toBe('light');
    expect(overrideOf('dark')).toBe('dark');
  });

  it('load shows the stored theme and writes it to the shared store', async () => {
    const shared = createSharedAppearance();
    const m = createAppearanceModel({ preferences: fakePreferences({ initial: { receiveCurrency: 'ILS', theme: 'dark' } }).api, shared });
    expect(m.store.get()).toMatchObject({ status: 'idle', theme: 'system' });
    await m.load();
    expect(m.store.get()).toMatchObject({ status: 'ready', theme: 'dark' });
    expect(shared.store.get().theme).toBe('dark');
  });

  it('a failed load sets the generic error and leaves the shared mode alone', async () => {
    const shared = createSharedAppearance();
    shared.store.set({ theme: 'light' });
    const m = createAppearanceModel({ preferences: fakePreferences({ failGet: true }).api, shared });
    await m.load();
    expect(m.store.get()).toMatchObject({ status: 'error', error: 'common.error.generic' });
    expect(shared.store.get().theme).toBe('light');
  });

  it('choose applies at once, before the API answers, saves only the theme, and keeps the server answer', async () => {
    const shared = createSharedAppearance();
    const { api, sets, gate } = fakePreferences();
    const m = createAppearanceModel({ preferences: api, shared });
    await m.load();
    const pending = m.choose('dark');
    expect(m.store.get()).toMatchObject({ theme: 'dark', saving: true });
    expect(shared.store.get().theme).toBe('dark'); // the whole app is dark before the call returns
    expect(sets).toEqual([{ theme: 'dark' }]);
    gate.release!();
    await pending;
    expect(m.store.get()).toMatchObject({ theme: 'dark', saving: false, notice: 'appearance.saved' });
    expect(m.store.get().error).toBeUndefined();
    expect(shared.store.get().theme).toBe('dark');
  });

  it('a refused save rolls back to the previous value, in the model and the shared store, and says so', async () => {
    const shared = createSharedAppearance();
    const { api, gate } = fakePreferences({ failSet: true, initial: { receiveCurrency: 'as_sent', theme: 'light' } });
    const m = createAppearanceModel({ preferences: api, shared });
    await m.load();
    const pending = m.choose('dark');
    expect(shared.store.get().theme).toBe('dark');
    gate.release!();
    await pending;
    expect(m.store.get()).toMatchObject({ theme: 'light', saving: false, error: 'appearance.saveFailed' });
    expect(m.store.get().notice).toBeUndefined();
    expect(shared.store.get().theme).toBe('light');
  });

  it('choosing the current value, or choosing while saving, makes no call', async () => {
    const shared = createSharedAppearance();
    const { api, sets, gate } = fakePreferences();
    const m = createAppearanceModel({ preferences: api, shared });
    await m.load();
    await m.choose('system');
    expect(sets).toEqual([]);
    const pending = m.choose('light');
    await m.choose('dark');
    expect(sets).toEqual([{ theme: 'light' }]);
    expect(m.store.get().theme).toBe('light');
    gate.release!();
    await pending;
  });

  it('keeps the server\'s answer, not the request, in the model and the shared store', async () => {
    const shared = createSharedAppearance();
    const answered: Preferences = { receiveCurrency: 'as_sent', theme: 'light' };
    const m = createAppearanceModel({ preferences: { get: async () => answered, set: async () => answered }, shared });
    await m.load();
    await m.choose('dark');
    expect(m.store.get()).toMatchObject({ theme: 'light', saving: false });
    expect(shared.store.get().theme).toBe('light');
  });

  it('a second choice after a refusal starts clean', async () => {
    const shared = createSharedAppearance();
    const refusing = fakePreferences({ failSet: true });
    const m = createAppearanceModel({ preferences: refusing.api, shared });
    await m.load();
    const p1 = m.choose('dark');
    refusing.gate.release!();
    await p1;
    expect(m.store.get().error).toBe('appearance.saveFailed');
    const p2 = m.choose('light');
    expect(m.store.get().error).toBeUndefined();
    refusing.gate.release!();
    await p2;
  });
});
