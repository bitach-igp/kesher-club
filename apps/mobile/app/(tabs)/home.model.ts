// Home, balance detail and transaction detail view model for M08–M10 (T-0511). Balances per currency
// with an on-hold row when money is reserved; the identity card while verification is unfinished; the
// frozen-card banner; transactions grouped by day with a kind filter and a text search; a declined card
// purchase explained from the server's reason code. Merchant and member text (`counterparty`,
// `untrusted.*`) is data: searched and shown as written, never parsed for meaning. T-0911: the public
// status names each money capability ok, degraded or off; a degraded one shows the incident banner (plain
// text, never a link) and its quick action is hidden, as are actions for anything not ok. T-0529: Home reaches
// M12 (requests and splits) and M33 (the receiving currency), and the identity card says only what the
// member's tier still lacks: a T1 member is told about the card, never that payments are locked.
import { format, fromWire, money, type Currency, type Money } from '@kesher/domain';
import { errorIs, type Account, type Card, type CardsApi, type KycApi, type KycStatus, type ProposalsApi, type ServiceStatus, type StatusApi, type Transaction, type WalletApi } from '../../src/api.ts';
import { intlLocale, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type HomeMode = 'loading' | 'ready' | 'error';
export type TxFilter = 'all' | 'load' | 'p2p' | 'card' | 'fx' | 'payout' | 'other';
export const FILTERS: readonly TxFilter[] = ['all', 'load', 'p2p', 'card', 'fx', 'payout', 'other'];
/** How far the detail screen pages into a purse's activity looking for one transaction before giving up. */
export const LOCATE_PAGES = 25;

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
  /** GET /status; undefined while unknown, and then no quick action shows (the server gates anyway). */
  service?: ServiceStatus | undefined;
  /** Assistant proposals waiting for this member (T-1012); 0 when none or unknown. */
  proposalsWaiting: number;
}

export interface HomeDeps {
  wallet: WalletApi;
  kyc: KycApi;
  cards: CardsApi;
  status?: StatusApi;
  proposals?: Pick<ProposalsApi, 'list'>;
  router: Router;
  now: () => Date;
  locale?: Locale;
  kycHref?: string;
  cardHref?: string;
  walletHref?: string;
  proposalsHref?: string;
  receiveInHref?: string;
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
  // T1 already pays and receives; only the card waits for T2.
  if (status.approvedTier === 'T1' && (status.status === 'approved' || status.status === 'none')) return { body: 'home.kyc.t1', action: true, tone: 'info' };
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

export type QuickAction = 'add' | 'send' | 'requests' | 'convert' | 'card';
export const QUICK_ACTIONS: readonly { action: QuickAction; capability: keyof ServiceStatus['capabilities']; label: CopyKey; href: string }[] = [
  { action: 'add', capability: 'wallet', label: 'home.quick.add', href: '/fund/add-money' },
  { action: 'send', capability: 'p2p', label: 'home.quick.send', href: '/pay/recipient' },
  // M12 pay home: requests, splits and the inbox.
  { action: 'requests', capability: 'p2p', label: 'home.quick.requests', href: '/pay' },
  { action: 'convert', capability: 'fx', label: 'home.quick.convert', href: '/convert' },
  { action: 'card', capability: 'card', label: 'home.quick.card', href: '/card' },
];

/** The quick actions whose capability is ok; none while the status is unknown. */
export const quickActions = (status: ServiceStatus | undefined): typeof QUICK_ACTIONS => (status ? QUICK_ACTIONS.filter((q) => status.capabilities[q.capability] === 'ok') : []);

/**
 * The incident banner while a capability is degraded: the admin's title and body as plain strings,
 * rendered as text. No href and no action: a URL inside the body stays words on the screen.
 */
export function incidentBanner(status: ServiceStatus | undefined): { title: string; body: string } | undefined {
  if (!status?.incident || !Object.values(status.capabilities).includes('degraded')) return undefined;
  return { title: status.incident.title, body: status.incident.body };
}

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

/** The device's calendar day of an instant, YYYY-MM-DD: a purchase at 23:30 in Tel Aviv is today's, not tomorrow's. */
export function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Newest day first, by the device's calendar; today and yesterday get words, the rest a date. */
export function groupByDay(items: readonly Transaction[], now: Date, locale: Locale): DayGroup[] {
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getTime() - 86_400_000));
  const groups = new Map<string, Transaction[]>();
  for (const t of [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
    const d = localDay(new Date(t.at));
    const g = groups.get(d);
    if (g) g.push(t);
    else groups.set(d, [t]);
  }
  return [...groups.entries()].map(([day, list]) => ({
    day,
    label: day === today ? { key: 'wallet.day.today' as CopyKey } : day === yesterday ? { key: 'wallet.day.yesterday' as CopyKey } : { date: new Date(`${day}T00:00:00`).toLocaleDateString(intlLocale(locale), { day: 'numeric', month: 'long' }) },
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

/** Signed for display from the server's `direction`: out is negative, in positive. The kind says nothing about the sign (a p2p is out for one purse and in for another). */
export function signedAmount(tx: Transaction): Money {
  const m = fromWire(tx.amount);
  const abs = m.minor < 0n ? -m.minor : m.minor;
  return money(tx.direction === 'out' ? -abs : abs, m.currency);
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
  /** A transaction already loaded, from any purse. */
  transaction(id: string): Transaction | undefined;
  /** Finds a transaction, paging further into the purse's activity (up to LOCATE_PAGES pages) when it is not loaded yet. */
  locate(id: string, accountId?: string): Promise<Transaction | undefined>;
  goVerify(): void;
  /** M33: which currency money sent to the member lands in. A preference, so it shows whatever the service status. */
  goReceiveIn(): void;
  goCard(): void;
  goWallet(accountId: string): void;
  goProposals(): void;
}

export function createHomeModel(deps: HomeDeps): HomeModel {
  const locale = deps.locale ?? 'en';
  const store = createStore<HomeState>({ mode: 'loading', accounts: [], cards: [], transactions: {}, cursors: {}, activityUnavailable: false, filter: 'all', query: '', busy: false, proposalsWaiting: 0 });
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
        const service = deps.status ? await deps.status.get().catch(() => undefined) : undefined;
        // An outage of the proposals endpoint must not cost the member their balances: none waiting, as far as home knows.
        const waiting = deps.proposals ? await deps.proposals.list('pending').then((r) => r.items.length).catch(() => 0) : 0;
        const rows = purseRows(accounts.items);
        const selected = store.get().selectedAccountId ?? rows[0]?.accountId;
        store.patch({ mode: 'ready', accounts: [...accounts.items], kyc, cards: [...cards.items], selectedAccountId: selected, service, proposalsWaiting: waiting });
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
    async locate(id, accountId) {
      const found = this.transaction(id);
      if (found) return found;
      const account = accountId ?? store.get().selectedAccountId;
      if (!account) return undefined;
      store.patch({ busy: true });
      try {
        if (!store.get().transactions[account]) await page(account);
        for (let n = 0; n < LOCATE_PAGES; n += 1) {
          const hit = store.get().transactions[account]?.find((x) => x.id === id);
          if (hit) return hit;
          const cursor = store.get().cursors[account];
          if (!cursor) return undefined;
          await page(account, cursor);
        }
        return store.get().transactions[account]?.find((x) => x.id === id);
      } catch {
        store.patch({ error: 'common.error.generic' });
        return undefined;
      } finally {
        store.patch({ busy: false });
      }
    },
    goVerify() {
      deps.router.push(deps.kycHref ?? '/kyc');
    },
    goReceiveIn() {
      deps.router.push(deps.receiveInHref ?? '/settings/currency');
    },
    goCard() {
      deps.router.push(deps.cardHref ?? '/card');
    },
    goProposals() {
      deps.router.push(deps.proposalsHref ?? '/settings/assistants/proposal');
    },
    goWallet(accountId) {
      deps.router.push(`${deps.walletHref ?? '/wallet'}?account=${encodeURIComponent(accountId)}`);
    },
  };
}
