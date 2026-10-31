// T-0635 I02 dashboard (TST-INS-017 at the screen): the funnel's three numbers and their whole-percent shares, which
// always add up to 100; balances formatted per locale from bigint, the market's currency first and the other only
// when it holds money; an empty roster reads as a sentence; the next runs and fees due as lines.
import { describe, expect, it } from 'vitest';
import { balances, feeLines, funnel, isEmpty, runLines, TILES, type Dashboard } from './dashboard.ts';
import { COPY } from './i18n.ts';

const OHR: Dashboard = {
  roster: { invited: 3, verified: 2, active: 5 },
  balances: [{ minor: '1200000', currency: 'ILS' }, { minor: '0', currency: 'USD' }],
  upcomingRuns: [{ scheduleId: '0190a0a0-0000-7000-8000-000000000001', name: 'Weekly ₪200', date: '2026-11-06', amount: { minor: '20000', currency: 'ILS' }, memberCount: 5 }],
  feesDue: [{ minor: '45000', currency: 'ILS' }],
};

describe('T-0635 I02 dashboard', () => {
  it('the funnel: 3 / 2 / 5 is 30% / 20% / 50%', () => {
    expect(funnel(OHR)).toEqual({ invited: 3, verified: 2, active: 5, total: 10, percent: { invited: 30, verified: 20, active: 50 } });
  });

  it('whole percents always add up to 100, by largest remainder', () => {
    const thirds = funnel({ ...OHR, roster: { invited: 1, verified: 1, active: 1 } });
    expect(thirds.percent.invited + thirds.percent.verified + thirds.percent.active).toBe(100);
    const skewed = funnel({ ...OHR, roster: { invited: 1, verified: 0, active: 6 } });
    expect(skewed.percent).toEqual({ invited: 14, verified: 0, active: 86 });
    for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) for (let c = 1; c < 12; c++) {
      const p = funnel({ ...OHR, roster: { invited: a, verified: b, active: c } }).percent;
      expect(p.invited + p.verified + p.active).toBe(100);
    }
  });

  it("balances: the market's currency first, the other only when it holds money; formatted from bigint", () => {
    expect(balances(OHR, 'IL')).toEqual([{ minor: 1_200_000n, currency: 'ILS' }]);
    expect(balances({ ...OHR, balances: [{ minor: '1200000', currency: 'ILS' }, { minor: '9007199254740993', currency: 'USD' }] }, 'US')).toEqual([
      { minor: 9_007_199_254_740_993n, currency: 'USD' },
      { minor: 1_200_000n, currency: 'ILS' },
    ]);
    expect(feeLines(OHR, 'en')).toEqual(['₪450.00']);
    expect(runLines(OHR, 'en')).toEqual([{ name: 'Weekly ₪200', date: '2026-11-06', amount: '₪200.00', members: 5 }]);
  });

  it('an empty roster reads as a sentence pointing at the import; tiles open the pages every role reads', () => {
    const empty = { ...OHR, roster: { invited: 0, verified: 0, active: 0 } };
    expect(isEmpty(empty)).toBe(true);
    expect(funnel(empty).percent).toEqual({ invited: 0, verified: 0, active: 0 });
    for (const locale of ['en', 'he'] as const) expect(COPY[locale]['dash.empty']).toMatch(/\.$/);
    expect(TILES.map((x) => x.href)).toEqual(['/allowances', '/collections', '/payouts']);
  });
});
