// M34 close account (T-0526, REQ-WAL-005): what is left in each purse goes back where it came from before
// the account closes. With money left the screen offers "Refund … and close", never a bare close; the
// account then shows the refunds on their way and closes when they arrive. An empty account closes at
// once. Holds, an overdrawn purse or a failed refund block the close and say why. The close takes a
// passkey step-up and runs once per attempt key; "already closing" is progress, not an error.
import { format, fromWire, type Money } from '@kesher/domain';
import { errorIs, type Closure, type ClosureApi } from '../../src/api.ts';
import { intlLocale, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';

export interface Problem {
  key: CopyKey;
  vars?: Record<string, string | number>;
}

/** What the screen offers, from where the closure stands. */
export type Phase = 'refund_first' | 'empty' | 'refunding' | 'blocked' | 'closed';

export interface CloseState {
  mode: 'loading' | 'ready' | 'error';
  closure?: Closure | undefined;
  busy: boolean;
  needsStepUp: boolean;
  attemptKey?: string | undefined;
  error?: Problem | undefined;
  notice?: Problem | undefined;
}

export const fmt = (m: Money, locale: Locale): string => format(m, intlLocale(locale));

/** Each purse with money in it, and the amount that goes back to its source. */
export const refundPlan = (c: Closure): Money[] => c.balances.map((b) => fromWire(b.available)).filter((m) => m.minor > 0n);

export function phaseOf(c: Closure): Phase {
  if (c.state === 'closed') return 'closed';
  if (c.state === 'blocked') return 'blocked';
  if (c.state === 'refunding') return 'refunding';
  return refundPlan(c).length > 0 ? 'refund_first' : 'empty';
}

/** "$30.00 and ₪120.00": the plan, in the member's words. */
export const amountsText = (amounts: readonly Money[], locale: Locale): string => amounts.map((m) => fmt(m, locale)).join(locale === 'he' ? ' ו־' : ' and ');

export interface CloseModel {
  store: Store<CloseState>;
  load(): Promise<void>;
  close(): Promise<void>;
}

export function createCloseModel(deps: { closure: ClosureApi; newKey: () => string }): CloseModel {
  const store = createStore<CloseState>({ mode: 'loading', busy: false, needsStepUp: false });

  const load = async (notice?: Problem) => {
    try {
      store.patch({ mode: 'ready', closure: await deps.closure.get(), ...(notice ? { notice } : {}) });
    } catch {
      store.patch({ mode: 'error', error: { key: 'common.error.generic' } });
    }
  };

  return {
    store,
    async load() {
      store.patch({ error: undefined });
      await load();
    },

    async close() {
      const s = store.get();
      if (s.busy || !s.closure) return;
      const phase = phaseOf(s.closure);
      if (phase !== 'refund_first' && phase !== 'empty') return;
      const key = s.attemptKey ?? deps.newKey();
      store.patch({ busy: true, attemptKey: key, error: undefined, notice: undefined });
      try {
        const closure = await deps.closure.close(key);
        store.patch({ busy: false, needsStepUp: false, attemptKey: undefined, closure });
      } catch (e) {
        if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return store.patch({ busy: false, needsStepUp: true });
        store.patch({ busy: false });
        // Another attempt (another device, a double tap) is already closing the account: show where it stands.
        if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' })) return load({ key: 'close.inProgress' });
        store.patch({ error: { key: errorIs(e, { code: 'FEATURE_OFF' }) || errorIs(e, { status: 503 }) ? 'common.error.unavailable' : 'common.error.generic' } });
      }
    },
  };
}
