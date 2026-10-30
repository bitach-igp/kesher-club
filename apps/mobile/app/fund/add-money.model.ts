// P07 add money, one-time (T-0524; REQ-WAL-002, REQ-WAL-003, REQ-WAL-006): who, how much, into which purse,
// and how to pay. When the purse is not the amount's currency the screen shows the club-rate quote (what
// lands, at which rate version) and asks again once it expires. ACH appears only while `funding.ach` is
// on, and says the money is held until a date. One Idempotency-Key per attempt, kept through the passkey
// step-up and a retry after a network error, so a double tap or a flaky link is one load.
import { format, fromWire, money, toWire, type Currency, type Money } from '@kesher/domain';
import { errorIs, type FundApi, type FundMember, type FxApi, type Load } from '../../src/api.ts';
import { intlLocale, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import { hold, secondsLeft, type HeldQuote } from '../../src/quote-lock.ts';

export type Method = 'card' | 'apple_pay' | 'google_pay' | 'ach';
export const METHODS: readonly Method[] = ['card', 'apple_pay', 'google_pay', 'ach'];

export interface Problem {
  key: CopyKey;
  vars?: Record<string, string | number>;
}

/** The payment provider's sheet for a load that needs the payer (3-D Secure, wallet confirmation). */
export interface PaymentSheet {
  present(clientSecret: string): Promise<'completed' | 'cancelled'>;
}

export interface Receipt {
  state: Load['state'];
  method: Method;
  paid: Money;
  credited: Money;
  rateVersion?: number | undefined;
  holdUntil?: string | undefined;
}

export interface AddMoneyState {
  mode: 'loading' | 'ready' | 'error';
  members: FundMember[];
  memberPartyId?: string | undefined;
  amountText: string;
  /** The currency the payer pays in. */
  currency: Currency;
  /** The purse credited. */
  purse: Currency;
  method: Method;
  achEnabled: boolean;
  quote?: HeldQuote | undefined;
  secondsLeft: number;
  /** The Idempotency-Key of the attempt in flight or being retried; a changed input starts a new attempt. */
  attemptKey?: string | undefined;
  busy: boolean;
  needsStepUp: boolean;
  receipt?: Receipt | undefined;
  error?: Problem | undefined;
  notice?: Problem | undefined;
}

export interface AddMoneyDeps {
  fund: FundApi;
  fx: Pick<FxApi, 'quote'>;
  capabilities: () => Promise<{ features: Readonly<Record<string, boolean>> }>;
  paymentSheet: PaymentSheet;
  newKey: () => string;
  now: () => Date;
}

export function parseAmount(text: string, currency: Currency): { amount: Money } | { problem: CopyKey } {
  const cleaned = text.replace(/[,\s₪$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { problem: 'fund.amount.invalid' };
  const [whole, frac = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  if (minor <= 0n) return { problem: 'fund.amount.zero' };
  return { amount: money(minor, currency) };
}

export const crossCurrency = (s: Pick<AddMoneyState, 'currency' | 'purse'>): boolean => s.currency !== s.purse;
export const fmt = (m: Money, locale: Locale): string => format(m, intlLocale(locale));
export const methodsFor = (achEnabled: boolean): readonly Method[] => METHODS.filter((m) => m !== 'ach' || achEnabled);

export function problemFor(e: unknown): Problem | 'stepUp' | 'expired' {
  if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return 'stepUp';
  if (errorIs(e, { code: 'QUOTE_EXPIRED' })) return 'expired';
  if (errorIs(e, { code: 'LIMIT_EXCEEDED' })) return { key: 'fund.limit' };
  if (errorIs(e, { code: 'FEATURE_OFF' })) return { key: 'fund.off' };
  if (errorIs(e, { status: 503 }) || errorIs(e, { code: 'PROVIDER_UNAVAILABLE' })) return { key: 'common.error.unavailable' };
  if (errorIs(e, { code: 'VALIDATION_FAILED' })) return { key: 'fund.amount.invalid' };
  return { key: 'common.error.generic' };
}

export interface AddMoneyModel {
  store: Store<AddMoneyState>;
  load(): Promise<void>;
  setMember(partyId: string): void;
  setAmount(text: string): void;
  setCurrency(c: Currency): Promise<void>;
  setPurse(c: Currency): Promise<void>;
  setMethod(m: Method): void;
  /** Fetches the club-rate quote when the purse differs from the amount's currency. */
  requote(): Promise<void>;
  /** Advances the quote countdown; at zero the quote is dropped and the next confirm asks again. */
  tick(): void;
  confirm(): Promise<void>;
  stepUpDone(): void;
  startOver(): void;
}

export function createAddMoneyModel(deps: AddMoneyDeps): AddMoneyModel {
  const store = createStore<AddMoneyState>({ mode: 'loading', members: [], amountText: '', currency: 'USD', purse: 'USD', method: 'card', achEnabled: false, secondsLeft: 0, busy: false, needsStepUp: false });
  /** Any input change is a new attempt: a new key, and no quote or receipt from before. */
  const changed = (patch: Partial<AddMoneyState>) => store.patch({ ...patch, attemptKey: undefined, quote: undefined, secondsLeft: 0, receipt: undefined, error: undefined, notice: undefined, needsStepUp: false });

  const requote = async (): Promise<boolean> => {
    const s = store.get();
    if (!crossCurrency(s)) return true;
    const parsed = parseAmount(s.amountText, s.currency);
    if ('problem' in parsed) {
      store.patch({ error: { key: parsed.problem } });
      return false;
    }
    store.patch({ busy: true, error: undefined });
    try {
      const quote = await deps.fx.quote({ from: toWire(parsed.amount), to: s.purse }, deps.newKey());
      const held = hold(quote, deps.now());
      store.patch({ busy: false, quote: held, secondsLeft: secondsLeft(held, deps.now()) });
      return true;
    } catch (e) {
      const p = problemFor(e);
      store.patch({ busy: false, error: typeof p === 'string' ? { key: 'common.error.generic' } : p });
      return false;
    }
  };

  const settle = async (load: Load, paid: Money, method: Method): Promise<void> => {
    const credited = load.credited ? fromWire(load.credited) : paid;
    const receipt: Receipt = { state: load.state, method, paid, credited, rateVersion: load.rateVersion, holdUntil: load.holdUntil };
    if (load.state === 'failed') return store.patch({ busy: false, attemptKey: undefined, error: { key: 'fund.declined' } });
    if (load.state === 'requires_action') {
      if (!load.clientSecret) return store.patch({ busy: false, error: { key: 'common.error.generic' } });
      const outcome = await deps.paymentSheet.present(load.clientSecret);
      if (outcome === 'cancelled') return store.patch({ busy: false, notice: { key: 'fund.sheet.cancelled' } });
      return store.patch({ busy: false, attemptKey: undefined, receipt: { ...receipt, state: 'processing' } });
    }
    store.patch({ busy: false, attemptKey: undefined, receipt });
  };

  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const [members, caps] = await Promise.all([deps.fund.members(), deps.capabilities()]);
        const s = store.get();
        store.patch({ mode: 'ready', members: [...members], memberPartyId: s.memberPartyId ?? members[0]?.partyId, achEnabled: caps.features['funding.ach'] === true, method: s.method === 'ach' && caps.features['funding.ach'] !== true ? 'card' : s.method });
      } catch (e) {
        const p = problemFor(e);
        store.patch({ mode: 'error', error: typeof p === 'string' ? { key: 'common.error.generic' } : p });
      }
    },

    setMember(partyId) {
      changed({ memberPartyId: partyId });
    },

    setAmount(text) {
      changed({ amountText: text });
    },

    async setCurrency(c) {
      changed({ currency: c });
      if (store.get().amountText.trim()) await requote();
    },

    async setPurse(c) {
      changed({ purse: c });
      if (store.get().amountText.trim()) await requote();
    },

    setMethod(m) {
      if (m === 'ach' && !store.get().achEnabled) return;
      changed({ method: m });
    },

    async requote() {
      await requote();
    },

    tick() {
      const s = store.get();
      if (!s.quote) return;
      const left = secondsLeft(s.quote, deps.now());
      if (left === 0) store.patch({ quote: undefined, secondsLeft: 0, notice: { key: 'fund.quote.expired' } });
      else if (left !== s.secondsLeft) store.patch({ secondsLeft: left });
    },

    async confirm() {
      const s = store.get();
      if (s.busy || s.receipt) return; // a second tap while the first is in flight, or after it landed, is not a second load
      if (!s.memberPartyId) return store.patch({ error: { key: 'fund.member.none' } });
      const parsed = parseAmount(s.amountText, s.currency);
      if ('problem' in parsed) return store.patch({ error: { key: parsed.problem } });
      if (crossCurrency(s) && secondsLeft(s.quote, deps.now()) === 0) {
        store.patch({ notice: s.quote ? { key: 'fund.quote.expired' } : undefined });
        await requote();
        return;
      }
      const key = s.attemptKey ?? deps.newKey();
      store.patch({ busy: true, attemptKey: key, error: undefined, notice: undefined });
      try {
        const load = await deps.fund.createLoad({ memberPartyId: s.memberPartyId, amount: toWire(parsed.amount), method: s.method, purseCurrency: s.purse }, key);
        store.patch({ needsStepUp: false });
        await settle(load, parsed.amount, s.method);
      } catch (e) {
        const p = problemFor(e);
        if (p === 'stepUp') return store.patch({ busy: false, needsStepUp: true });
        if (p === 'expired') {
          store.patch({ busy: false, notice: { key: 'fund.quote.expired' } });
          await requote();
          return;
        }
        // The key stays: retrying this attempt after a network error replays it rather than paying twice.
        store.patch({ busy: false, error: p });
      }
    },

    stepUpDone() {
      store.patch({ needsStepUp: false });
    },

    startOver() {
      changed({ amountText: '' });
    },
  };
}
