// T-0637 I03 cohorts (TST-INS-018 at the screen): dates are checked before the call (real calendar dates, the end
// after the start); the list orders current, then upcoming, then past, by date; a retry keeps its key and a changed
// form takes a new one; 422 and 404 read as sentences; each cohort opens I04 filtered to it.
import { describe, expect, it } from 'vitest';
import { attemptFor, cohortProblem, errorKey, ordered, rosterHref, whenOf, type Cohort } from './cohorts.ts';
import { COPY } from './i18n.ts';

const c = (name: string, startsOn: string, endsOn: string): Cohort => ({ id: `0190a0a0-0000-7000-8000-${name.padStart(12, '0').slice(-12)}`, name, startsOn, endsOn, memberCount: 0 });
const TODAY = '2026-11-03';

describe('T-0637 I03 cohorts', () => {
  it('checks the dates before the call', () => {
    expect(cohortProblem({ name: 'Shiur Aleph', startsOn: '2026-09-01', endsOn: '2027-06-30' })).toBeUndefined();
    expect(cohortProblem({ name: ' ', startsOn: '2026-09-01', endsOn: '2027-06-30' })?.field).toBe('name');
    expect(cohortProblem({ name: 'A', startsOn: '2026-02-30', endsOn: '2027-06-30' })).toEqual({ field: 'startsOn', key: 'cohorts.form.date' });
    expect(cohortProblem({ name: 'A', startsOn: '2026-09-01', endsOn: '2026-09-01' })).toEqual({ field: 'endsOn', key: 'cohorts.form.order' });
  });

  it('orders current, then upcoming soonest first, then past most recent first', () => {
    const list = [c('past1', '2025-09-01', '2026-06-30'), c('soon2', '2027-03-01', '2027-08-01'), c('now', '2026-09-01', '2027-06-30'), c('soon1', '2026-12-01', '2027-06-30'), c('past2', '2024-09-01', '2025-06-30')];
    expect(ordered(list, TODAY).map((x) => [x.name, x.when])).toEqual([['now', 'current'], ['soon1', 'upcoming'], ['soon2', 'upcoming'], ['past1', 'past'], ['past2', 'past']]);
    expect(whenOf({ startsOn: TODAY, endsOn: '2027-01-01' }, TODAY)).toBe('current');
    expect(whenOf({ startsOn: '2026-01-01', endsOn: TODAY }, TODAY)).toBe('current');
  });

  it('a retry keeps its key; a changed form takes a new one', () => {
    let n = 0;
    const next = () => `key-${++n}-00000`;
    const form = { name: 'Shiur Aleph', startsOn: '2026-09-01', endsOn: '2027-06-30' };
    const first = attemptFor(undefined, form, next);
    expect(attemptFor(first, { ...form, name: ' Shiur Aleph ' }, next).key).toBe(first.key);
    expect(attemptFor(first, { ...form, endsOn: '2027-07-31' }, next).key).toBe('key-2-00000');
  });

  it('refusals read as sentences; each cohort opens I04 filtered to it', () => {
    for (const code of ['VALIDATION_FAILED', 'NOT_FOUND', 'INTERNAL']) for (const locale of ['en', 'he'] as const) expect(COPY[locale][errorKey(code)]).toMatch(/\.$/);
    expect(rosterHref({ id: '0190a0a0-0000-7000-8000-000000000001' })).toBe('/roster?cohort=0190a0a0-0000-7000-8000-000000000001');
  });
});
