// M33 receiving currency (T-0516, REQ-PAY-007): which purse money sent to the member lands in. As sent
// (the default) keeps the sender's currency; shekels or dollars convert a payment in the other currency
// at the club rate. The choice shows at once and rolls back if the server refuses it.
import type { PreferencesApi, ReceiveCurrency } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';

export const RECEIVE_OPTIONS: readonly { value: ReceiveCurrency; label: CopyKey; helper?: CopyKey }[] = [
  { value: 'as_sent', label: 'currency.asSent', helper: 'currency.asSentHelper' },
  { value: 'ILS', label: 'currency.ils' },
  { value: 'USD', label: 'currency.usd' },
];

export interface CurrencyState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  receiveCurrency: ReceiveCurrency;
  saving: boolean;
  notice?: CopyKey | undefined;
  error?: CopyKey | undefined;
}

export interface CurrencyModel {
  store: Store<CurrencyState>;
  load(): Promise<void>;
  choose(value: ReceiveCurrency): Promise<void>;
}

export function createCurrencyModel(deps: { preferences: PreferencesApi }): CurrencyModel {
  const store = createStore<CurrencyState>({ status: 'idle', receiveCurrency: 'as_sent', saving: false });
  return {
    store,
    async load() {
      store.patch({ status: 'loading', error: undefined });
      try {
        const p = await deps.preferences.get();
        store.patch({ status: 'ready', receiveCurrency: p.receiveCurrency });
      } catch {
        store.patch({ status: 'error', error: 'common.error.generic' });
      }
    },
    async choose(value) {
      const s = store.get();
      if (s.saving || value === s.receiveCurrency) return;
      const previous = s.receiveCurrency;
      store.patch({ receiveCurrency: value, saving: true, notice: undefined, error: undefined });
      try {
        const p = await deps.preferences.set(value);
        store.patch({ receiveCurrency: p.receiveCurrency, saving: false, notice: 'currency.saved' });
      } catch {
        store.patch({ receiveCurrency: previous, saving: false, error: 'currency.saveFailed' });
      }
    },
  };
}
