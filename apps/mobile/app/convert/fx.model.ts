// Convert view model for M11 (T-0509, REQ-FX-001/002): a quote shows the rate, the markup and the total
// and counts down its 30 seconds; confirming an expired quote answers QUOTE_EXPIRED and the screen
// fetches a fresh one on its own. The convert key is minted per quote, so a retry at the same quote is
// one conversion and a fresh quote is a fresh key.
import { format, fromWire, money, toWire, type Currency, type Money } from '@kesher/domain';
import { errorIs, type Account, type FxApi, type FxConversion } from '../../src/api.ts';
import { intlLocale, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import { hold, secondsLeft, type HeldQuote } from '../../src/quote-lock.ts';

export interface Problem {
  key: CopyKey;
  vars?: Record<string, string | number>;
}

export interface FxState {
  mode: 'loading' | 'ready' | 'error';
  accounts: Account[];
  from: Currency;
  amountText: string;
  quote?: HeldQuote | undefined;
  /** The Idempotency-Key for converting at the current quote; new quote, new key. */
  convertKey?: string | undefined;
  secondsLeft: number;
  busy: boolean;
  needsStepUp: boolean;
  result?: FxConversion | undefined;
  error?: Problem | undefined;
  notice?: Problem | undefined;
}

export interface FxDeps {
  fx: FxApi;
  accounts: () => Promise<{ items: readonly Account[] }>;
  newKey: () => string;
  now: () => Date;
  locale?: Locale;
}

export const other = (c: Currency): Currency => (c === 'USD' ? 'ILS' : 'USD');

export function parseAmount(text: string, currency: Currency): { amount: Money } | { problem: CopyKey } {
  const cleaned = text.replace(/[,\s₪$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { problem: 'fx.amount.invalid' };
  const [whole, frac = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  if (minor <= 0n) return { problem: 'fx.amount.zero' };
  return { amount: money(minor, currency) };
}

export function available(accounts: readonly Account[], currency: Currency): Money {
  const a = accounts.find((x) => x.currency === currency);
  return a ? fromWire(a.available) : money(0n, currency);
}

export const fmt = (m: Money | { minor: string; currency: string }, locale: Locale): string => format(typeof m.minor === 'string' ? fromWire(m as { minor: string; currency: string }) : (m as Money), intlLocale(locale));

/** "0.75 %" from basis points. */
export const markupPercent = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

export function problemFor(e: unknown, locale: Locale): Problem | 'stepUp' | 'expired' {
  const err = e as { available?: string; currency?: string };
  if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return 'stepUp';
  if (errorIs(e, { code: 'QUOTE_EXPIRED' })) return 'expired';
  if (errorIs(e, { code: 'INSUFFICIENT_FUNDS' })) return { key: 'fx.insufficient', vars: { available: err.available && (err.currency === 'USD' || err.currency === 'ILS') ? format(money(BigInt(err.available), err.currency), intlLocale(locale)) : '' } };
  if (errorIs(e, { code: 'VALIDATION_FAILED' })) return { key: 'fx.amount.invalid' };
  if (errorIs(e, { code: 'FEATURE_OFF' }) || errorIs(e, { status: 503 })) return { key: 'common.error.unavailable' };
  return { key: 'common.error.generic' };
}

export interface FxModel {
  store: Store<FxState>;
  load(): Promise<void>;
  setFrom(c: Currency): void;
  swap(): void;
  setAmount(v: string): void;
  /** A fresh quote (and a fresh convert key). */
  getQuote(): Promise<void>;
  /** Advances the countdown; at zero the quote is dropped and the screen offers a fresh one. */
  tick(): void;
  /** Converts at the current quote; on QUOTE_EXPIRED fetches a fresh quote and says so. */
  confirm(): Promise<void>;
  reset(): void;
  stepUpDone(): void;
}

export function createFxModel(deps: FxDeps): FxModel {
  const locale = deps.locale ?? 'en';
  const store = createStore<FxState>({ mode: 'loading', accounts: [], from: 'USD', amountText: '', secondsLeft: 0, busy: false, needsStepUp: false });
  const clearQuote = () => store.patch({ quote: undefined, convertKey: undefined, secondsLeft: 0 });
  const fetchQuote = async (): Promise<boolean> => {
    const s = store.get();
    const r = parseAmount(s.amountText, s.from);
    if ('problem' in r) {
      store.patch({ error: { key: r.problem } });
      return false;
    }
    const avail = available(s.accounts, s.from);
    if (s.mode === 'ready' && r.amount.minor > avail.minor) {
      store.patch({ error: { key: 'fx.insufficient', vars: { available: format(avail, intlLocale(locale)) } } });
      return false;
    }
    store.patch({ busy: true, error: undefined });
    try {
      const quote = await deps.fx.quote({ from: toWire(r.amount), to: other(s.from) }, deps.newKey());
      const held = hold(quote, deps.now());
      store.patch({ busy: false, quote: held, convertKey: deps.newKey(), secondsLeft: secondsLeft(held, deps.now()), result: undefined });
      return true;
    } catch (e) {
      const p = problemFor(e, locale);
      store.patch({ busy: false, error: p === 'stepUp' || p === 'expired' ? { key: 'common.error.generic' } : p });
      return false;
    }
  };
  return {
    store,
    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const { items } = await deps.accounts();
        store.patch({ mode: 'ready', accounts: [...items] });
      } catch (e) {
        const p = problemFor(e, locale);
        store.patch({ mode: 'error', error: typeof p === 'string' ? { key: 'common.error.generic' } : p });
      }
    },
    setFrom(c) {
      store.patch({ from: c, error: undefined, notice: undefined });
      clearQuote();
    },
    swap() {
      store.set((s) => ({ ...s, from: other(s.from), error: undefined, notice: undefined, quote: undefined, convertKey: undefined, secondsLeft: 0 }));
    },
    setAmount(v) {
      store.patch({ amountText: v, error: undefined, notice: undefined });
      clearQuote();
    },
    async getQuote() {
      store.patch({ notice: undefined });
      await fetchQuote();
    },
    tick() {
      const s = store.get();
      if (!s.quote) return;
      const left = secondsLeft(s.quote, deps.now());
      if (left === 0) store.patch({ quote: undefined, convertKey: undefined, secondsLeft: 0, notice: { key: 'fx.expired' } });
      else if (left !== s.secondsLeft) store.patch({ secondsLeft: left });
    },
    async confirm() {
      const s = store.get();
      if (!s.quote || !s.convertKey) return;
      if (secondsLeft(s.quote, deps.now()) === 0) {
        store.patch({ notice: { key: 'fx.expired' } });
        await fetchQuote();
        return;
      }
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        const result = await deps.fx.convert(s.quote.quoteId, s.convertKey);
        store.patch({ busy: false, result, needsStepUp: false, quote: undefined, convertKey: undefined, secondsLeft: 0, notice: { key: 'fx.done', vars: { total: fmt(result.total, locale) } } });
        await this.load().catch(() => undefined);
      } catch (e) {
        const p = problemFor(e, locale);
        if (p === 'stepUp') return store.patch({ busy: false, needsStepUp: true });
        if (p === 'expired') {
          store.patch({ busy: false, notice: { key: 'fx.expired' } });
          await fetchQuote();
          return;
        }
        store.patch({ busy: false, error: p });
      }
    },
    reset() {
      store.patch({ amountText: '', result: undefined, error: undefined, notice: undefined });
      clearQuote();
    },
    stepUpDone() {
      store.patch({ needsStepUp: false });
    },
  };
}
