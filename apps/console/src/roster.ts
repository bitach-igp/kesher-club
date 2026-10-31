// I04 roster (T-0639, REQ-INS-019): the institution's members in a table with status and cohort filters and
// paging; selected rows can be placed in a cohort in one call (all or none). Each row opens I06. The selection
// survives paging, so staff can pick students across pages. Names are roster text, shown as written; balances
// render from bigint per locale; there is no spend in a row.
import type { Schemas } from '@kesher/sdk';
import { fmt } from './allowances.ts';
import type { CopyKey, Locale } from './i18n.ts';

export type RosterMember = Schemas['RosterMember'];
export type Status = RosterMember['status'];
export const STATUSES: readonly Status[] = ['invited', 'verified', 'active', 'declined', 'removed'];

export interface Filter {
  status?: Status | undefined;
  cohort?: string | undefined;
  cursor?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page's search params as a filter; anything the API would refuse is dropped, not sent. */
export function filterFrom(params: Record<string, string | string[] | undefined>): Filter {
  const one = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined);
  const status = one('status');
  const cohort = one('cohort');
  const cursor = one('cursor');
  return {
    ...(status && (STATUSES as readonly string[]).includes(status) ? { status: status as Status } : {}),
    ...(cohort && UUID.test(cohort) ? { cohort } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** The filter as the API's query: only what is set. */
export const toQuery = (f: Filter): Record<string, string> => ({ ...(f.status ? { status: f.status } : {}), ...(f.cohort ? { cohort: f.cohort } : {}), ...(f.cursor ? { cursor: f.cursor } : {}) });

/** The next page's link keeps the filters. */
export function nextHref(f: Filter, nextCursor: string | undefined): string | undefined {
  if (!nextCursor) return undefined;
  return `/roster?${new URLSearchParams(toQuery({ ...f, cursor: nextCursor })).toString()}`;
}

/** Selection across pages: the ids picked so far, toggled one row at a time. */
export const toggle = (selected: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** A row's balances as text, from bigint; a member who has not joined has none. */
export const balanceText = (m: RosterMember, locale: Locale): string => m.balances.map((b) => fmt(b, locale)).join(' · ');

export const cardKey = (m: RosterMember): CopyKey => `roster.card.${m.card}` as CopyKey;

/** What placing reports: placed now, and those already in the cohort from an earlier call. */
export function placedText(selected: number, placed: number): { key: CopyKey; vars: Record<string, number> } {
  return placed === selected ? { key: 'roster.place.done', vars: { count: placed } } : { key: 'roster.place.partly', vars: { placed, already: selected - placed } };
}

/** The key a placement goes with: the last attempt's for the same cohort and the same students, else new. */
export interface Attempt {
  change: string;
  key: string;
}
export const attemptFor = (last: Attempt | undefined, cohortId: string, ids: ReadonlySet<string>, newKey: () => string): Attempt => {
  const change = JSON.stringify([cohortId, [...ids].sort()]);
  return last && last.change === change ? last : { change, key: newKey() };
};

export const errorKey = (code: string): CopyKey => (code === 'NOT_FOUND' ? 'roster.place.notOurs' : code === 'VALIDATION_FAILED' ? 'roster.place.invalid' : code === 'FORBIDDEN' ? 'error.forbidden' : 'error.generic');
