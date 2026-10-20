// T-0611 I08 Collections (screen rows of TST-INS-006): the owed and paid totals equal their rows (bigint);
// the export round-trips its bytes exactly (a CSV keeps its byte-order mark, an XLSX its zip magic number);
// a student who has not consented shows fees owed and nothing of their spending (REQ-INS-005).
import { describe, expect, it } from 'vitest';
import { byStudent, decodeExport, hasBom, isZip, shiftMonth, totalsMatch, type Collections } from './collections.ts';

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
    const out = decodeExport({ filename: 'collections-2026-11.csv', contentType: 'text/csv; charset=utf-8', base64: b64(csv), rows: 1, totals: { allowancesOut: ils('0'), feesIn: ils('12000'), net: ils('12000') } });
    expect([...out]).toEqual(csv);
    expect(hasBom(out)).toBe(true);
    expect(new TextDecoder().decode(out.slice(3))).toContain('נועה');
    const xlsx = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xff, 0x00, 0x80];
    const back = decodeExport({ filename: 'collections-2026-11.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: b64(xlsx), rows: 1, totals: { allowancesOut: ils('0'), feesIn: ils('0'), net: ils('0') } });
    expect([...back]).toEqual(xlsx);
    expect([isZip(back), hasBom(back)]).toEqual([true, false]);
  });

  it('months step across the year', () => {
    expect([shiftMonth('2026-01', -1), shiftMonth('2026-12', 1), shiftMonth('2026-11', 0)]).toEqual(['2025-12', '2027-01', '2026-11']);
  });
});
