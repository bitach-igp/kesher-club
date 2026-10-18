// M33 receiving currency (T-0516, TST-PAY-007): as sent by default; the choice reads and saves through
// /me/preferences, shows at once, and rolls back with a message when the server refuses it.
import { describe, expect, it } from 'vitest';
import type { Preferences, PreferencesApi, ReceiveCurrency } from '../../src/api.ts';
import { createCurrencyModel, RECEIVE_OPTIONS } from './currency.model.ts';

function fakePreferences(opts: { failSet?: boolean; initial?: Preferences } = {}) {
  let current: Preferences = opts.initial ?? { receiveCurrency: 'as_sent' };
  const sets: ReceiveCurrency[] = [];
  const api: PreferencesApi = {
    get: async () => current,
    async set(receiveCurrency) {
      sets.push(receiveCurrency);
      if (opts.failSet) throw Object.assign(new Error('boom'), { status: 500 });
      current = { receiveCurrency, updatedAt: '2026-11-10T09:00:00.000Z' };
      return current;
    },
  };
  return { api, sets };
}

describe('M33 receiving currency (TST-PAY-007)', () => {
  it('is as sent by default and offers as sent, shekels and dollars', async () => {
    const m = createCurrencyModel({ preferences: fakePreferences().api });
    expect(m.store.get().receiveCurrency).toBe('as_sent');
    await m.load();
    expect(m.store.get()).toMatchObject({ status: 'ready', receiveCurrency: 'as_sent' });
    expect(RECEIVE_OPTIONS.map((o) => o.value)).toEqual(['as_sent', 'ILS', 'USD']);
  });

  it('reads a saved choice and saves a new one once, with the notice', async () => {
    const { api, sets } = fakePreferences({ initial: { receiveCurrency: 'USD' } });
    const m = createCurrencyModel({ preferences: api });
    await m.load();
    expect(m.store.get().receiveCurrency).toBe('USD');
    await m.choose('USD');
    expect(sets).toEqual([]);
    await m.choose('ILS');
    expect(sets).toEqual(['ILS']);
    expect(m.store.get()).toMatchObject({ receiveCurrency: 'ILS', saving: false, notice: 'currency.saved' });
    await m.load();
    expect(m.store.get().receiveCurrency).toBe('ILS');
  });

  it('a refused save rolls back to the previous choice and says so', async () => {
    const m = createCurrencyModel({ preferences: fakePreferences({ failSet: true }).api });
    await m.load();
    await m.choose('ILS');
    expect(m.store.get()).toMatchObject({ receiveCurrency: 'as_sent', saving: false, error: 'currency.saveFailed' });
  });

  it('a failed read shows the error', async () => {
    const m = createCurrencyModel({ preferences: { get: async () => Promise.reject(new Error('down')), set: async () => Promise.reject(new Error('down')) } });
    await m.load();
    expect(m.store.get()).toMatchObject({ status: 'error', error: 'common.error.generic' });
  });
});
