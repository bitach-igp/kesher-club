// P13 billing in funder mode (T-0311, REQ-BIL-004): each membership the funder pays for, with who, the plan, the price
// and when it renews or ends. Cancel takes two taps: the first asks, and says what happens (the membership runs to the
// end of the paid period, and the member keeps every dollar and shekel already loaded); the second cancels. A retry of
// a cancel keeps its Idempotency-Key. A cancelled membership reads "Ends on {date}".
import { fromWire, type Money } from '@kesher/domain';
import { errorIs, type FunderApi, type MembershipRow } from '../../src/api.ts';
import { intlLocale, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';

export interface BillingRow {
  id: string;
  /** The member's display name, shown as written; absent when the API has none. */
  name?: string | undefined;
  planCode: string;
  price: Money;
  status: MembershipRow['status'];
  /** The line under the price: renews, ends, ended or past due, with its date when it has one. */
  line: { key: CopyKey; date?: string | undefined };
  /** Whether Cancel is offered: running and not already cancelled. */
  cancellable: boolean;
}

export interface BillingState {
  mode: 'loading' | 'ready' | 'empty' | 'error';
  rows: BillingRow[];
  /** The membership whose Cancel was tapped once and now asks to confirm. */
  confirming?: string | undefined;
  busy: boolean;
  notice?: CopyKey | undefined;
  error?: CopyKey | undefined;
}

export interface BillingDeps {
  funder: Pick<FunderApi, 'memberships' | 'cancelMembership'>;
  newKey: () => string;
}

/** A date as the funder reads it: "December 10, 2026" or "10 בדצמבר 2026". */
export const dateText = (iso: string, locale: Locale): string => new Date(iso).toLocaleDateString(intlLocale(locale), { day: 'numeric', month: 'long', year: 'numeric' });

/** The line under a membership's price. */
export function lineOf(m: Pick<MembershipRow, 'status' | 'cancelAt' | 'currentPeriodEnd'>): BillingRow['line'] {
  if (m.status === 'cancelled') return { key: 'billing.ended' };
  if (m.cancelAt) return { key: 'billing.endsOn', date: m.cancelAt };
  if (m.status === 'past_due') return { key: 'billing.pastDue' };
  if (m.status === 'paused') return { key: 'billing.paused' };
  return m.currentPeriodEnd ? { key: 'billing.renewsOn', date: m.currentPeriodEnd } : { key: 'billing.active' };
}

export function billingRow(m: MembershipRow): BillingRow {
  return {
    id: m.id,
    ...(m.memberName ? { name: m.memberName } : {}),
    planCode: m.planCode,
    price: fromWire(m.price),
    status: m.status,
    line: lineOf(m),
    cancellable: m.status !== 'cancelled' && m.status !== 'incomplete' && !m.cancelAt,
  };
}

/** A refused cancel as a sentence. */
export function refusal(e: unknown): CopyKey {
  if (errorIs(e, { status: 409 })) return 'billing.error.ended';
  if (errorIs(e, { status: 403 })) return 'billing.error.notFunder';
  if (errorIs(e, { code: 'NOT_FOUND' })) return 'billing.error.notFound';
  if (errorIs(e, { status: 503 })) return 'common.error.unavailable';
  return 'common.error.generic';
}

export interface BillingModel {
  store: Store<BillingState>;
  load(): Promise<void>;
  /** First tap: ask, and say what happens. */
  askCancel(id: string): void;
  /** Second tap: cancel at the end of the paid period. */
  confirmCancel(): Promise<void>;
  /** Changed their mind: nothing is sent. */
  keep(): void;
}

export function createBillingModel(deps: BillingDeps): BillingModel {
  const store = createStore<BillingState>({ mode: 'loading', rows: [], busy: false });
  // One key per membership's cancel, kept until it succeeds: a retry is the same cancel.
  const keys = new Map<string, string>();
  const keyFor = (id: string) => {
    let k = keys.get(id);
    if (!k) keys.set(id, (k = deps.newKey()));
    return k;
  };
  const load = async () => {
    const { items } = await deps.funder.memberships();
    const rows = items.filter((m) => m.role === 'funder').map(billingRow);
    store.patch({ rows, mode: rows.length ? 'ready' : 'empty' });
  };

  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        await load();
      } catch (e) {
        store.patch({ mode: 'error', error: errorIs(e, { status: 503 }) ? 'common.error.unavailable' : 'common.error.generic' });
      }
    },

    askCancel(id) {
      if (store.get().rows.some((r) => r.id === id && r.cancellable)) store.patch({ confirming: id, error: undefined, notice: undefined });
    },

    async confirmCancel() {
      const s = store.get();
      const row = s.rows.find((r) => r.id === s.confirming);
      if (!row || s.busy) return;
      store.patch({ busy: true, error: undefined });
      try {
        const m = await deps.funder.cancelMembership(row.id, keyFor(row.id));
        keys.delete(row.id);
        store.set((st) => ({ ...st, busy: false, confirming: undefined, notice: 'billing.cancelled', rows: st.rows.map((r) => (r.id === m.id ? { ...r, status: m.status, line: lineOf(m), cancellable: false } : r)) }));
      } catch (e) {
        store.patch({ busy: false, error: refusal(e) });
        // Ended or no longer theirs since the list was read: read it again so the row says which.
        if (errorIs(e, { status: 409 }) || errorIs(e, { status: 403 }) || errorIs(e, { code: 'NOT_FOUND' })) {
          store.patch({ confirming: undefined });
          await load().catch(() => undefined);
        }
      }
    },

    keep() {
      store.patch({ confirming: undefined });
    },
  };
}
