// P07 auto-reload (T-0525, REQ-WAL-004): the purse's rule (below a threshold, top up to a target with a
// saved payment method, at most once in 24 h) read and set. The worker already runs it; this shows and
// edits it. Saving takes a passkey step-up because it authorises money to move later. A target at or
// below the threshold is refused before any call; turning the rule off keeps its amounts for next time.
import { money, toWire, type Currency, type Money } from '@kesher/domain';
import { errorIs, type Account, type AutoReloadApi, type AutoReloadRule, type SavedPaymentMethod } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';

export type ReloadMethod = AutoReloadRule['method'];
export const RELOAD_METHODS: readonly ReloadMethod[] = ['card', 'apple_pay', 'google_pay'];

export interface Problem {
  key: CopyKey;
  vars?: Record<string, string | number>;
}

export interface AutoReloadState {
  /** `off` while the wallet is off: the tab shows nothing to set. */
  mode: 'loading' | 'ready' | 'off' | 'error';
  accounts: Account[];
  purse: Currency;
  /** The rule as the server holds it; undefined when none was ever set. */
  rule?: AutoReloadRule | undefined;
  thresholdText: string;
  targetText: string;
  method: ReloadMethod;
  paymentMethodId?: string | undefined;
  savedMethods: SavedPaymentMethod[];
  enabled: boolean;
  attemptKey?: string | undefined;
  busy: boolean;
  needsStepUp: boolean;
  error?: Problem | undefined;
  notice?: Problem | undefined;
}

export interface AutoReloadDeps {
  reload: AutoReloadApi;
  accounts: () => Promise<{ items: readonly Account[] }>;
  newKey: () => string;
}

/** Major units as typed ("50", "49.50") to minor units; zero is a valid threshold. */
export function parseMajor(text: string, currency: Currency): Money | undefined {
  const cleaned = text.replace(/[,\s₪$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [whole, frac = ''] = cleaned.split('.');
  return money(BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0')), currency);
}

/** Minor units back to the text a field shows: 5000 → "50.00". */
export const majorText = (minor: string): string => {
  const m = BigInt(minor);
  return `${m / 100n}.${(m % 100n).toString().padStart(2, '0')}`;
};

export function problemFor(e: unknown): Problem | 'stepUp' | 'off' | 'none' {
  if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return 'stepUp';
  if (errorIs(e, { code: 'FEATURE_OFF' })) return 'off';
  if (errorIs(e, { code: 'NOT_FOUND' })) return 'none';
  if (errorIs(e, { code: 'VALIDATION_FAILED' })) return { key: 'reload.invalid' };
  if (errorIs(e, { status: 503 }) || errorIs(e, { code: 'PROVIDER_UNAVAILABLE' })) return { key: 'common.error.unavailable' };
  return { key: 'common.error.generic' };
}

export interface AutoReloadModel {
  store: Store<AutoReloadState>;
  load(): Promise<void>;
  setPurse(c: Currency): Promise<void>;
  setThreshold(text: string): void;
  setTarget(text: string): void;
  setMethod(m: ReloadMethod): void;
  setPaymentMethod(id: string): void;
  /** Saves the rule as on. */
  save(): Promise<void>;
  /** Saves the rule as off, with its amounts kept. */
  turnOff(): Promise<void>;
  stepUpDone(): void;
}

export function createAutoReloadModel(deps: AutoReloadDeps): AutoReloadModel {
  const store = createStore<AutoReloadState>({ mode: 'loading', accounts: [], purse: 'USD', thresholdText: '', targetText: '', method: 'card', savedMethods: [], enabled: false, busy: false, needsStepUp: false });
  const accountFor = (c: Currency): Account | undefined => store.get().accounts.find((a) => a.currency === c);
  /** An edit is a new attempt. */
  const edited = (patch: Partial<AutoReloadState>) => store.patch({ ...patch, attemptKey: undefined, error: undefined, notice: undefined, needsStepUp: false });

  const show = (rule: AutoReloadRule | undefined) => {
    const saved = store.get().savedMethods;
    store.patch({
      mode: 'ready',
      rule,
      thresholdText: rule ? majorText(rule.threshold.minor) : '',
      targetText: rule ? majorText(rule.target.minor) : '',
      method: rule?.method ?? 'card',
      paymentMethodId: rule?.paymentMethodId ?? saved[0]?.id,
      enabled: rule?.enabled ?? false,
    });
  };

  const loadRule = async (): Promise<void> => {
    const account = accountFor(store.get().purse);
    if (!account) return show(undefined);
    try {
      show(await deps.reload.get(account.id));
    } catch (e) {
      const p = problemFor(e);
      if (p === 'none') return show(undefined);
      if (p === 'off') return store.patch({ mode: 'off' });
      store.patch({ mode: 'error', error: typeof p === 'string' ? { key: 'common.error.generic' } : p });
    }
  };

  const submit = async (enabled: boolean): Promise<void> => {
    const s = store.get();
    if (s.busy) return;
    const threshold = parseMajor(s.thresholdText, s.purse);
    const target = parseMajor(s.targetText, s.purse);
    if (!threshold || !target) return store.patch({ error: { key: 'reload.amount.invalid' } });
    if (target.minor <= threshold.minor) return store.patch({ error: { key: 'reload.target.aboveThreshold' } });
    if (!s.paymentMethodId) return store.patch({ error: { key: 'reload.method.none' } });
    const account = accountFor(s.purse);
    if (!account) return store.patch({ error: { key: 'common.error.generic' } });
    const key = s.attemptKey ?? deps.newKey();
    store.patch({ busy: true, attemptKey: key, error: undefined, notice: undefined });
    try {
      const rule = await deps.reload.set(account.id, { enabled, method: s.method, paymentMethodId: s.paymentMethodId, threshold: toWire(threshold), target: toWire(target) }, key);
      show(rule);
      store.patch({ busy: false, needsStepUp: false, attemptKey: undefined, notice: { key: enabled ? 'reload.saved.on' : 'reload.saved.off' } });
    } catch (e) {
      const p = problemFor(e);
      if (p === 'stepUp') return store.patch({ busy: false, needsStepUp: true });
      if (p === 'off') return store.patch({ busy: false, mode: 'off' });
      store.patch({ busy: false, error: typeof p === 'string' ? { key: 'common.error.generic' } : p });
    }
  };

  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const [{ items }, savedMethods] = await Promise.all([deps.accounts(), deps.reload.paymentMethods()]);
        store.patch({ accounts: [...items], savedMethods: [...savedMethods] });
      } catch (e) {
        const p = problemFor(e);
        if (p === 'off') return store.patch({ mode: 'off' });
        return store.patch({ mode: 'error', error: typeof p === 'string' ? { key: 'common.error.generic' } : p });
      }
      await loadRule();
    },

    async setPurse(c) {
      edited({ purse: c, mode: 'loading' });
      await loadRule();
    },

    setThreshold(text) {
      edited({ thresholdText: text });
    },

    setTarget(text) {
      edited({ targetText: text });
    },

    setMethod(m) {
      edited({ method: m });
    },

    setPaymentMethod(id) {
      edited({ paymentMethodId: id });
    },

    save: () => submit(true),
    turnOff: () => submit(false),

    stepUpDone() {
      store.patch({ needsStepUp: false });
    },
  };
}
