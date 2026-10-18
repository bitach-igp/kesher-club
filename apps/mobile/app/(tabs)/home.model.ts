// Home, balance detail and transaction detail view model for M08–M10 (T-0511). Balances per currency
// with an on-hold row when money is reserved; the identity card while verification is unfinished; the
// frozen-card banner; transactions grouped by day with a kind filter and a text search; a declined card
// purchase explained from the server's reason code. Merchant and member text (`counterparty`,
// `untrusted.*`) is data: searched and shown as written, never parsed for meaning.
import { format, fromWire, money, type Currency, type Money } from '@kesher/domain';
import { errorIs, type Account, type Card, type CardsApi, type KycApi, type KycStatus, type Transaction, type WalletApi } from '../../src/api.ts';
import { intlLocale, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type HomeMode = 'loading' | 'ready' | 'error';
export type TxFilter = 'all' | 'load' | 'p2p' | 'card' | 'fx' | 'payout' | 'other';
export const FILTERS: readonly TxFilter[] = ['all', 'load', 'p2p', 'card', 'fx', 'payout', 'other'];

export interface PurseRow {
  accountId: string;
  currency: Currency;
  available: Money;
  holds: Money;
  /** True when something is reserved: the screen shows the on-hold row. */
  hasHolds: boolean;
}

export interface DayGroup {
  /** ISO date (UTC) the group is keyed by. */
  day: string;
  label: { key: CopyKey } | { date: string };
  items: Transaction[];
}

export interface HomeState {
  mode: HomeMode;
  accounts: Account[];
  kyc?: KycStatus | undefined;
  cards: Card[];
  /** Transactions per account id, newest first, as far as loaded. */
  transactions: Record<string, Transaction[]>;
  cursors: Record<string, string | undefined>;
  /** True when the activity endpoint is behind a flag or down; balances still show. */
  activityUnavailable: boolean;
  selectedAccountId?: string | undefined;
  filter: TxFilter;
  query: string;
  busy: boolean;
  error?: CopyKey | undefined;
}

export interface HomeDeps {
  wallet: WalletApi;
  kyc: KycApi;
  cards: CardsApi;
  router: Router;
  now: () => Date;
  locale?: Locale;
  kycHref?: string;
  cardHref?: string;
  walletHref?: string;
}

// ---- pure views -------------------------------------------------------------------------------

export function purseRows(accounts: readonly Account[]): PurseRow[] {
  const order: Record<string, number> = { ILS: 0, USD: 1 };
  return [...accounts]
    .sort((a, b) => (order[a.currency] ?? 9) - (order[b.currency] ?? 9))
    .map((a) => {
      const holds = fromWire(a.holds);
      return { accountId: a.id, currency: a.currency, available: fromWire(a.available), holds, hasHolds: holds.minor !== 0n };
    });
}

/** The identity card: which message, if any, while T2 is not approved. */
export function kycCard(status: KycStatus | undefined): { body: CopyKey; action: boolean; tone: 'info' | 'warning' | 'danger' } | undefined {
  if (!status || status.approvedTier === 'T2') return status ? undefined : { body: 'home.kyc.none', action: true, tone: 'info' };
  switch (status.status) {
    case 'pending':
      return { body: 'home.kyc.pending', action: false, tone: 'info' };
    case 'review':
      return { body: 'home.kyc.review', action: false, tone: 'warning' };
    case 'rejected':
      return { body: 'home.kyc.rejected', action: true, tone: 'danger' };
    default:
      return { body: 'home.kyc.none', action: true, tone: 'info' };
  }
}

export const frozenCard = (cards: readonly Card[]): Card | undefined => cards.find((c) => c.status === 'frozen');

export function matchesFilter(tx: Transaction, filter: TxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'other') return !['load', 'p2p', 'card', 'fx', 'payout'].includes(tx.kind);
  return tx.kind === filter;
}

/** Case-insensitive match on the counterparty and the merchant's free text, treated as plain strings. */
export function matchesQuery(tx: Transaction, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  const hay = [tx.counterparty ?? '', ...Object.values(tx.untrusted ?? {})].join('\n').toLocaleLowerCase();
  return hay.includes(q);
}

export const filterTransactions = (items: readonly Transaction[], filter: TxFilter, query: string): Transaction[] => items.filter((t) => matchesFilter(t, filter) && matchesQuery(t, query));

/** Newest day first; today and yesterday get words, the rest a date. */
export function groupByDay(items: readonly Transaction[], now: Date, locale: Locale): DayGroup[] {
  const dayOf = (iso: string) => iso.slice(0, 10);
  const today = dayOf(now.toISOString());
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000).toISOString());
  const groups = new Map<string, Transaction[]>();
  for (const t of [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
    const d = dayOf(t.at);
    const g = groups.get(d);
    if (g) g.push(t);
    else groups.set(d, [t]);
  }
  return [...groups.entries()].map(([day, list]) => ({
    day,
    label: day === today ? { key: 'wallet.day.today' as CopyKey } : day === yesterday ? { key: 'wallet.day.yesterday' as CopyKey } : { date: new Date(`${day}T00:00:00Z`).toLocaleDateString(intlLocale(locale), { timeZone: 'UTC', day: 'numeric', month: 'long' }) },
    items: list,
  }));
}

const KNOWN_DECLINES = new Set(['INSUFFICIENT_FUNDS', 'CARD_FROZEN', 'LIMIT_EXCEEDED', 'MCC_BLOCKED', 'COUNTRY_BLOCKED', 'CHANNEL_BLOCKED', 'AGENT_NOT_ALLOWED']);

/** A declined card purchase carries the server's reason code in `untrusted.declineReason`; known codes get copy, the rest the code as data. */
export function declinedCopy(tx: Transaction): { key: CopyKey; vars: Record<string, string> } | undefined {
  if (tx.kind !== 'card' || tx.state !== 'reversed') return undefined;
  const code = tx.untrusted?.['declineReason'];
  if (!code) return undefined;
  return KNOWN_DECLINES.has(code) ? { key: `tx.declined.${code}` as CopyKey, vars: {} } : { key: 'tx.declined.other', vars: { code } };
}

/** Signed for display: money in is positive, money out negative, from the purse's point of view. */
export function signedAmount(tx: Transaction): Money {
  const m = fromWire(tx.amount);
  const out = tx.kind === 'card' || tx.kind === 'payout' || tx.kind === 'fee' || tx.kind === 'addon';
  return out && m.minor > 0n ? money(-m.minor, m.currency) : m;
}

export const fmt = (m: Money, locale: Locale): string => format(m, intlLocale(locale));

// ---- the model --------------------------------------------------------------------------------

export interface HomeModel {
  store: Store<HomeState>;
  load(): Promise<void>;
  selectAccount(id: string): Promise<void>;
  setFilter(f: TxFilter): void;
  setQuery(q: string): void;
  loadMore(): Promise<void>;
  /** The account's transactions after the filter and search, grouped by day. */
  groups(accountId?: string): DayGroup[];
  transaction(id: string): Transaction | undefined;
  goVerify(): void;
  goCard(): void;
  goWallet(accountId: string): void;
}

export function createHomeModel(deps: HomeDeps): HomeModel {
  const locale = deps.locale ?? 'en';
  const store = createStore<HomeState>({ mode: 'loading', accounts: [], cards: [], transactions: {}, cursors: {}, activityUnavailable: false, filter: 'all', query: '', busy: false });
  const page = async (accountId: string, cursor?: string): Promise<void> => {
    try {
      const p = await deps.wallet.listTransactions(accountId, cursor);
      store.set((s) => ({ ...s, activityUnavailable: false, transactions: { ...s.transactions, [accountId]: cursor ? [...(s.transactions[accountId] ?? []), ...p.items] : [...p.items] }, cursors: { ...s.cursors, [accountId]: p.nextCursor } }));
    } catch (e) {
      if (errorIs(e, { code: 'FEATURE_OFF' }) || errorIs(e, { status: 404 }) || errorIs(e, { status: 503 })) return store.patch({ activityUnavailable: true });
      throw e;
    }
  };
  return {
    store,
    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const [accounts, kyc, cards] = await Promise.all([
          deps.wallet.listAccounts(),
          deps.kyc.status().catch(() => undefined),
          deps.cards.listCards().catch(() => ({ items: [] as readonly Card[] })),
        ]);
        const rows = purseRows(accounts.items);
        const selected = store.get().selectedAccountId ?? rows[0]?.accountId;
        store.patch({ mode: 'ready', accounts: [...accounts.items], kyc, cards: [...cards.items], selectedAccountId: selected });
        if (selected) await page(selected);
      } catch (e) {
        store.patch({ mode: 'error', error: errorIs(e, { status: 503 }) ? 'common.error.unavailable' : 'common.error.generic' });
      }
    },
    async selectAccount(id) {
      store.patch({ selectedAccountId: id, error: undefined });
      if (!store.get().transactions[id]) {
        store.patch({ busy: true });
        await page(id).catch(() => store.patch({ error: 'common.error.generic' }));
        store.patch({ busy: false });
      }
    },
    setFilter(f) {
      store.patch({ filter: f });
    },
    setQuery(q) {
      store.patch({ query: q });
    },
    async loadMore() {
      const s = store.get();
      const id = s.selectedAccountId;
      const cursor = id ? s.cursors[id] : undefined;
      if (!id || !cursor || s.busy) return;
      store.patch({ busy: true });
      await page(id, cursor).catch(() => store.patch({ error: 'common.error.generic' }));
      store.patch({ busy: false });
    },
    groups(accountId) {
      const s = store.get();
      const id = accountId ?? s.selectedAccountId;
      return groupByDay(filterTransactions(id ? (s.transactions[id] ?? []) : [], s.filter, s.query), deps.now(), locale);
    },
    transaction(id) {
      for (const list of Object.values(store.get().transactions)) {
        const t = list.find((x) => x.id === id);
        if (t) return t;
      }
      return undefined;
    },
    goVerify() {
      deps.router.push(deps.kycHref ?? '/kyc');
    },
    goCard() {
      deps.router.push(deps.cardHref ?? '/card');
    },
    goWallet(accountId) {
      deps.router.push(`${deps.walletHref ?? '/wallet'}?account=${encodeURIComponent(accountId)}`);
    },
  };
}
