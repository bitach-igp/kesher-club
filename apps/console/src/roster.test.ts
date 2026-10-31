// T-0639 I04 roster (TST-INS-019 at the screen): filters map to the query and drop what the API would refuse; the
// next page keeps the filters; the selection survives paging; placing reports "3 placed" or "2 placed; 1 was
// already there"; a retry keeps its key; balances render from bigint per locale; refusals read as sentences.
import { describe, expect, it } from 'vitest';
import { COPY } from './i18n.ts';
import { attemptFor, balanceText, cardKey, errorKey, filterFrom, nextHref, placedText, toggle, toQuery, type RosterMember } from './roster.ts';

const COHORT = '0190a0a0-0000-7000-8000-00000000c0c0';
const avi: RosterMember = { id: '0190a0a0-0000-7000-8000-000000000a01', name: 'Avi', status: 'active', card: 'frozen', balances: [{ minor: '9007199254740993', currency: 'ILS' }, { minor: '0', currency: 'USD' }], planCode: 'ohr-club' };

describe('T-0639 I04 roster', () => {
  it('filters map to the query, and what the API would refuse is dropped', () => {
    expect(toQuery(filterFrom({ status: 'active', cohort: COHORT }))).toEqual({ status: 'active', cohort: COHORT });
    expect(toQuery(filterFrom({ status: 'gone', cohort: 'not-a-cohort', other: 'x' }))).toEqual({});
    expect(toQuery(filterFrom({ status: ['active', 'invited'] }))).toEqual({});
  });

  it('the next page keeps the filters', () => {
    expect(nextHref({ status: 'invited', cohort: COHORT }, 'abc')).toBe(`/roster?status=invited&cohort=${COHORT}&cursor=abc`);
    expect(nextHref({ status: 'invited' }, undefined)).toBeUndefined();
  });

  it('the selection survives paging: it is a set toggled by id, kept apart from the rows on screen', () => {
    let s = toggle(new Set(), 'a');
    s = toggle(s, 'b');
    s = toggle(s, 'a');
    expect([...s]).toEqual(['b']);
    expect([...toggle(s, 'c')].sort()).toEqual(['b', 'c']);
  });

  it('placing reports what happened; a retry keeps its key, another cohort or other students take a new one', () => {
    expect(placedText(3, 3)).toEqual({ key: 'roster.place.done', vars: { count: 3 } });
    expect(placedText(3, 2)).toEqual({ key: 'roster.place.partly', vars: { placed: 2, already: 1 } });
    let n = 0;
    const next = () => `key-${++n}-00000`;
    const first = attemptFor(undefined, COHORT, new Set(['b', 'a']), next);
    expect(attemptFor(first, COHORT, new Set(['a', 'b']), next).key).toBe(first.key);
    expect(attemptFor(first, COHORT, new Set(['a']), next).key).toBe('key-2-00000');
  });

  it('balances render from bigint per locale; a member who has not joined shows none; refusals read as sentences', () => {
    expect(balanceText(avi, 'en')).toBe('₪90,071,992,547,409.93 · $0.00');
    expect(balanceText({ ...avi, balances: [] }, 'en')).toBe('');
    expect(cardKey(avi)).toBe('roster.card.frozen');
    for (const code of ['NOT_FOUND', 'VALIDATION_FAILED', 'FORBIDDEN', 'INTERNAL']) for (const locale of ['en', 'he'] as const) expect(COPY[locale][errorKey(code)]).toMatch(/\.$/);
  });
});
