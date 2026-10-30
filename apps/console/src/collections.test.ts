// T-0611 I08 Collections (screen rows of TST-INS-006): the owed and paid totals equal their rows (bigint);
// the export round-trips its bytes exactly (a CSV keeps its byte-order mark, an XLSX its zip magic number);
// a student who has not consented shows fees owed and nothing of their spending (REQ-INS-005).
// T-0629: billing checks the amount and the due date before the call, and bills once per attempt key.
import { describe, expect, it } from 'vitest';
import { billMembers, byStudent, checkBill, decodeExport, hasBom, isZip, shiftMonth, totalsMatch, type BillDeps, type BillDraft, type Collections } from './collections.ts';

const ils = (minor: string) => ({ minor, currency: 'ILS' as const });
const receipt = (n: number, memberName: string, minor: string) => ({ receiptNumber: `KC-202611-${n}`, feeItemId: `f${n}`, institutionId: 'i', institutionName: 'Yeshiva', memberPartyId: `p-${memberName}`, description: 'Tuition', amount: ils(minor), paidAt: '2026-11-03T09:00:00Z', journalId: `j${n}`, memberName });
const owed = (id: string, memberName: string, minor: string) => ({ feeItemId: id, memberName, description: 'Lab fee', amount: ils(minor), dueAt: '2026-11-30' });

const month: Collections = {
  month: '2026-11',
  items: [receipt(1, 'Noa Example', '12000'), receipt(2, 'Noa Example', '9007199254740993'), receipt(3, 'Eli Example', '3000')],
  total: [ils('9007199254755993')],
  owed: [owed('o1', 'Maya Example', '4500'), owed('o2', 'Noa Example', '500000')],
  owedTotal: [ils('504500')],
};

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const utf8 = (s: string) => [...new TextEncoder().encode(s)];

describe('I08 collections (T-0611)', () => {
  it('owed and paid totals equal their rows in bigint, past 2^53; a total that does not is caught', () => {
    expect(totalsMatch(month)).toBe(true);
    expect(totalsMatch({ ...month, total: [ils('9007199254755992')] })).toBe(false);
    expect(totalsMatch({ ...month, owedTotal: [] })).toBe(false);
  });

  it('one row per student: what they owe and what they paid this month, with the receipts, owing first', () => {
    expect(byStudent(month)).toEqual([
      { memberName: 'Noa Example', currency: 'ILS', owed: 500_000n, paid: 9_007_199_254_752_993n, receipts: ['KC-202611-1', 'KC-202611-2'] },
      { memberName: 'Maya Example', currency: 'ILS', owed: 4_500n, paid: 0n, receipts: [] },
      { memberName: 'Eli Example', currency: 'ILS', owed: 0n, paid: 3_000n, receipts: ['KC-202611-3'] },
    ]);
  });

  it('a student who has not consented shows fees owed, and the row carries no spending at all (REQ-INS-005)', () => {
    const maya = byStudent(month).find((r) => r.memberName === 'Maya Example')!;
    expect(Object.keys(maya).sort()).toEqual(['currency', 'memberName', 'owed', 'paid', 'receipts']);
    expect(maya.owed).toBe(4_500n);
  });

  it('the export round-trips its bytes exactly: the CSV keeps its BOM and Hebrew, the XLSX its zip magic', () => {
    const csv = [0xef, 0xbb, 0xbf, ...utf8('member,amount\r\nנועה,120.00\r\n')];
    const out = decodeExport({ filename: 'collections-2026-11.csv', contentType: 'text/csv; charset=utf-8', base64: b64(csv), rows: 1, totals: { allowancesOut: ils('0'), feesIn: ils('12000'), payoutsOut: ils('0'), depositsIn: ils('0'), net: ils('12000') } });
    expect([...out]).toEqual(csv);
    expect(hasBom(out)).toBe(true);
    expect(new TextDecoder().decode(out.slice(3))).toContain('נועה');
    const xlsx = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xff, 0x00, 0x80];
    const back = decodeExport({ filename: 'collections-2026-11.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: b64(xlsx), rows: 1, totals: { allowancesOut: ils('0'), feesIn: ils('0'), payoutsOut: ils('0'), depositsIn: ils('0'), net: ils('0') } });
    expect([...back]).toEqual(xlsx);
    expect([isZip(back), hasBom(back)]).toEqual([true, false]);
  });

  it('months step across the year', () => {
    expect([shiftMonth('2026-01', -1), shiftMonth('2026-12', 1), shiftMonth('2026-11', 0)]).toEqual(['2025-12', '2027-01', '2026-11']);
  });
});

describe('billing members (T-0629)', () => {
  const draft = (over: Partial<BillDraft> = {}): BillDraft => ({ description: 'Tuition, term 2', amountText: '120', dueDate: '2026-12-01', ...over });

  it('checks the amount and the due date before the call, in the market\'s currency', () => {
    expect(checkBill(draft(), 'IL', '2026-11-10')).toEqual({ ok: true, body: { description: 'Tuition, term 2', amount: { minor: '12000', currency: 'ILS' }, dueDate: '2026-12-01', members: { kind: 'all' } } });
    expect(checkBill(draft({ amountText: '10,000.00' }), 'US', '2026-11-10')).toMatchObject({ ok: true, body: { amount: { minor: '1000000', currency: 'USD' } } });
    expect(checkBill(draft({ amountText: '10,000.01' }), 'IL', '2026-11-10')).toEqual({ ok: false, problems: ['over_max'] });
    expect(checkBill(draft({ amountText: '0', dueDate: '2026-11-09', description: ' ' }), 'IL', '2026-11-10')).toEqual({ ok: false, problems: ['description', 'amount', 'due'] });
    expect(checkBill(draft({ dueDate: '2027-11-12' }), 'IL', '2026-11-10')).toEqual({ ok: false, problems: ['due'] });
  });

  it('bills once per attempt with a fresh key; an invalid draft never calls; FEATURE_OFF is the off state', async () => {
    const keys: string[] = [];
    const batch = { id: 'b1', description: 'Tuition, term 2', amount: { minor: '12000', currency: 'ILS' as const }, dueDate: '2026-12-01', memberCount: 3, total: { minor: '36000', currency: 'ILS' as const } };
    let n = 0;
    const deps: BillDeps = { create: async (_body, key) => (keys.push(key), { ok: true, value: batch }), newKey: () => `key-${++n}` };
    expect(await billMembers(deps, draft(), 'IL', '2026-11-10')).toEqual({ kind: 'done', batch });
    expect(await billMembers(deps, draft({ amountText: '' }), 'IL', '2026-11-10')).toEqual({ kind: 'invalid', problems: ['amount'] });
    expect(keys).toEqual(['key-1']);
    expect(await billMembers({ create: async () => ({ ok: false, code: 'FEATURE_OFF' }), newKey: () => 'k' }, draft(), 'IL', '2026-11-10')).toEqual({ kind: 'off' });
  });
});
