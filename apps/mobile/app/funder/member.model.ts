// P06 child detail in funder mode (T-0538, REQ-WAL-009): one member the funder pays for. This month's card spend by
// category as bars (in the currency shown, dollars first with shekels one tap away: the spec's "insights in ₪ and $"),
// their recent transactions in plain words, and their cards, each opening P09 (T-0412). A P2P reads "Sent to a friend"
// or "Received from a friend": the API carries no names or notes, and the screen invents none.
import { fromWire, type Currency, type Money } from '@kesher/domain';
import { errorIs, type FunderApi, type MemberActivity } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type Category = MemberActivity['spendByCategory'][number]['category'];
type Tx = MemberActivity['transactions'][number];

export interface Bar {
  category: Category;
  amount: Money;
  /** Of the largest bar in this currency, 0 to 100. */
  percent: number;
}

export interface Row {
  id: string;
  title: CopyKey;
  /** Signed from this member's side: money out is negative. */
  amount: Money;
  out: boolean;
  state: Tx['state'];
  at: string;
}

export interface MemberState {
  mode: 'loading' | 'ready' | 'error';
  name: string;
  shown: Currency;
  bars: Bar[];
  rows: Row[];
  cards: MemberActivity['cards'];
  error?: CopyKey | undefined;
}

export interface MemberDeps {
  funder: Pick<FunderApi, 'member'>;
  router: Router;
}

/** The month's spend in one currency as bars, largest first, each a share of the largest. */
export function barsFor(spend: MemberActivity['spendByCategory'], currency: Currency): Bar[] {
  const rows = spend.map((s) => ({ category: s.category, amount: fromWire(s.amount) })).filter((s) => s.amount.currency === currency && s.amount.minor > 0n);
  const top = rows.reduce((m, r) => (r.amount.minor > m ? r.amount.minor : m), 0n);
  return rows.sort((a, b) => (b.amount.minor > a.amount.minor ? 1 : b.amount.minor < a.amount.minor ? -1 : 0)).map((r) => ({ ...r, percent: top === 0n ? 0 : Number((r.amount.minor * 100n) / top) }));
}

/** A transaction in words; a P2P says which way, never who. */
export function rowFor(t: Tx): Row {
  const out = t.direction === 'out';
  const title: CopyKey = t.kind === 'p2p' ? (out ? 'member.tx.p2p.out' : 'member.tx.p2p.in') : (`member.tx.${t.kind}` as CopyKey);
  const amount = fromWire(t.amount);
  return { id: t.id, title, amount: out ? { ...amount, minor: -amount.minor } : amount, out, state: t.state, at: t.at };
}

export interface MemberModel {
  store: Store<MemberState>;
  load(): Promise<void>;
  toggleCurrency(): void;
  openControls(cardId: string): void;
}

export function createMemberModel(deps: MemberDeps, partyId: string): MemberModel {
  const store = createStore<MemberState>({ mode: 'loading', name: '', shown: 'USD', bars: [], rows: [], cards: [] });
  let spend: MemberActivity['spendByCategory'] = [];
  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const a = await deps.funder.member(partyId);
        spend = a.spendByCategory;
        store.patch({ mode: 'ready', name: a.displayName, bars: barsFor(spend, store.get().shown), rows: a.transactions.map(rowFor), cards: a.cards });
      } catch (e) {
        store.patch({ mode: 'error', error: errorIs(e, { code: 'NOT_FOUND' }) ? 'member.notFound' : errorIs(e, { code: 'FEATURE_OFF' }) ? 'family.off' : 'common.error.generic' });
      }
    },

    toggleCurrency() {
      const shown = store.get().shown === 'USD' ? 'ILS' : 'USD';
      store.patch({ shown, bars: barsFor(spend, shown) });
    },

    openControls(cardId) {
      deps.router.push(`/funder/controls?card=${encodeURIComponent(cardId)}`);
    },
  };
}
