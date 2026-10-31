// I02 dashboard (T-0635, REQ-INS-017): the console's landing for any staff role. Tiles: the onboarding funnel
// (invited → verified → active) with each step's share of the roster in whole percents; the master balance per
// currency (the market's own currency always, the other only when it holds money); the next allowance runs with
// their dates; fees still due. An institution with nobody on its roster reads as a sentence that points at the
// roster import. Amounts are bigint all the way to the formatter.
import { fromWire, type Money } from '@kesher/domain';
import type { Schemas } from '@kesher/sdk';
import { fmt } from './allowances.ts';
import type { CopyKey, Locale } from './i18n.ts';

export type Dashboard = Schemas['InstitutionDashboard'];
export type Market = 'IL' | 'US';

export interface Funnel {
  invited: number;
  verified: number;
  active: number;
  total: number;
  /** Each step's share of the roster, in whole percents that add up to 100 (or all 0 for an empty roster). */
  percent: { invited: number; verified: number; active: number };
}

/** Largest-remainder rounding, so the three shares always add up to exactly 100. */
export function funnel(d: Dashboard): Funnel {
  const { invited, verified, active } = d.roster;
  const total = invited + verified + active;
  if (total === 0) return { invited, verified, active, total, percent: { invited: 0, verified: 0, active: 0 } };
  const raw = { invited: (invited * 100) / total, verified: (verified * 100) / total, active: (active * 100) / total };
  const floor = { invited: Math.floor(raw.invited), verified: Math.floor(raw.verified), active: Math.floor(raw.active) };
  let left = 100 - floor.invited - floor.verified - floor.active;
  const order = (['invited', 'verified', 'active'] as const).slice().sort((a, b) => raw[b] - floor[b] - (raw[a] - floor[a]));
  for (const k of order) if (left-- > 0) floor[k] += 1;
  return { invited, verified, active, total, percent: floor };
}

const MARKET_CURRENCY: Record<Market, 'ILS' | 'USD'> = { IL: 'ILS', US: 'USD' };

/** The balances to show: the market's currency always, first; any other only when it is not zero. */
export function balances(d: Dashboard, market: Market): Money[] {
  const all = d.balances.map(fromWire);
  const own = MARKET_CURRENCY[market];
  return [...all.filter((m) => m.currency === own), ...all.filter((m) => m.currency !== own && m.minor !== 0n)];
}

export const isEmpty = (d: Dashboard): boolean => funnel(d).total === 0;

/** The next runs as lines: name, date and amount. The name is staff text, shown as written. */
export const runLines = (d: Dashboard, locale: Locale): { name: string; date: string; amount: string; members: number }[] =>
  d.upcomingRuns.map((r) => ({ name: r.name, date: r.date, amount: fmt(r.amount, locale), members: r.memberCount }));

/** Fees still due, one line per currency; none reads as a sentence. */
export const feeLines = (d: Dashboard, locale: Locale): string[] => d.feesDue.map((m) => fmt(m, locale));

/** The pages a tile opens. Every staff role reads these pages; who may act on them is each page's business. */
export const TILES: readonly { href: string; label: CopyKey }[] = [
  { href: '/allowances', label: 'nav.allowances' },
  { href: '/collections', label: 'nav.collections' },
  { href: '/payouts', label: 'nav.payouts' },
];
