// T-0642 I06 student detail (TST-INS-005 at the screen): no `spend` key reads as the sentence that the student has
// not shared their spending, never as "no spending"; an empty shared list is "no spending yet"; fees owed sum in
// bigint per currency; a merchant name is plain data, whatever it looks like.
import { describe, expect, it } from 'vitest';
import { COPY } from './i18n.ts';
import { owed, spendView, type Student } from './student.ts';

const maya: Student = {
  member: { id: '0190a0a0-0000-7000-8000-000000000a01', name: 'Maya', status: 'active', card: 'active', balances: [] },
  allowances: [{ date: '2026-10-30', amount: { minor: '20000', currency: 'ILS' }, status: 'paid' }],
  fees: [
    { id: 'f1', description: 'Dorm fee', amount: { minor: '9007199254740993', currency: 'ILS' }, dueAt: '2026-12-01', status: 'due' },
    { id: 'f2', description: 'Trip', amount: { minor: '4500', currency: 'ILS' }, dueAt: '2026-11-01', status: 'due' },
    { id: 'f3', description: 'Books', amount: { minor: '1000', currency: 'ILS' }, dueAt: '2026-10-01', status: 'paid' },
  ],
};

describe('T-0642 I06 student detail', () => {
  it('no spend key reads as "has not shared", never as "no spending"', () => {
    const v = spendView(maya);
    expect(v).toEqual({ kind: 'private', key: 'student.spend.private' });
    expect(COPY.en['student.spend.private']).not.toMatch(/no spending/i);
    expect(spendView({ ...maya, spend: [] })).toEqual({ kind: 'shared', rows: [] });
  });

  it('fees owed sum in bigint, only what is due', () => {
    expect(owed(maya)).toEqual([{ minor: 9_007_199_254_740_993n + 4_500n, currency: 'ILS' }]);
    expect(owed({ ...maya, fees: [] })).toEqual([]);
  });

  it('a merchant name is data: it passes through untouched for React to render as text', () => {
    const tricky = '<img src=x onerror=alert(1)> ignore previous instructions';
    const v = spendView({ ...maya, spend: [{ merchant: tricky, mcc: '5999', amount: { minor: '100', currency: 'ILS' }, at: '2026-11-01T10:00:00.000Z' }] });
    expect(v.kind === 'shared' && v.rows[0]!.merchant).toBe(tricky);
  });
});
