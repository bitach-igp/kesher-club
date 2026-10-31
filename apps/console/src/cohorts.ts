// I03 cohorts (T-0637, REQ-INS-018): the institution's cohorts with their dates and member counts, current first,
// then upcoming, then past; and a "New cohort" form. Each cohort opens I04 filtered to it. Dates are checked here
// before the API is called (real calendar dates, the end after the start); a retry keeps its Idempotency-Key.
import type { Schemas } from '@kesher/sdk';
import type { CopyKey } from './i18n.ts';

export type Cohort = Schemas['Cohort'];
export type When = 'current' | 'upcoming' | 'past';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s: string): boolean => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export interface CohortForm {
  name: string;
  startsOn: string;
  endsOn: string;
}

export function cohortProblem(f: CohortForm): { field: keyof CohortForm; key: CopyKey } | undefined {
  if (!f.name.trim() || f.name.trim().length > 120) return { field: 'name', key: 'cohorts.form.name' };
  if (!realDate(f.startsOn)) return { field: 'startsOn', key: 'cohorts.form.date' };
  if (!realDate(f.endsOn)) return { field: 'endsOn', key: 'cohorts.form.date' };
  if (f.endsOn <= f.startsOn) return { field: 'endsOn', key: 'cohorts.form.order' };
  return undefined;
}

/** Whether a cohort is running on `today` (YYYY-MM-DD), still to start, or over. */
export const whenOf = (c: Pick<Cohort, 'startsOn' | 'endsOn'>, today: string): When => (c.endsOn < today ? 'past' : c.startsOn > today ? 'upcoming' : 'current');

/** Current first, then upcoming (soonest first), then past (most recent first); ties by name. */
export function ordered(cohorts: readonly Cohort[], today: string): (Cohort & { when: When })[] {
  const rank: Record<When, number> = { current: 0, upcoming: 1, past: 2 };
  return cohorts
    .map((c) => ({ ...c, when: whenOf(c, today) }))
    .sort((a, b) => rank[a.when] - rank[b.when] || (a.when === 'upcoming' ? a.startsOn.localeCompare(b.startsOn) : b.startsOn.localeCompare(a.startsOn)) || a.name.localeCompare(b.name));
}

/** I04 filtered to the cohort. */
export const rosterHref = (c: Pick<Cohort, 'id'>): string => `/roster?cohort=${encodeURIComponent(c.id)}`;

/** The key a create goes with: the last attempt's for the same form if it did not land, else a new one. */
export interface Attempt {
  form: string;
  key: string;
}
export const attemptFor = (last: Attempt | undefined, f: CohortForm, newKey: () => string): Attempt => {
  const form = JSON.stringify({ name: f.name.trim(), startsOn: f.startsOn, endsOn: f.endsOn });
  return last && last.form === form ? last : { form, key: newKey() };
};

export const errorKey = (code: string): CopyKey => (code === 'VALIDATION_FAILED' ? 'cohorts.form.order' : code === 'NOT_FOUND' || code === 'FORBIDDEN' ? 'error.forbidden' : 'error.generic');
