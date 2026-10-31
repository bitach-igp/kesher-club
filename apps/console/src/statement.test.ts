// T-0646 I10 master account (TST-INS-021 at the screen): opening plus rows equals closing, checked in bigint before
// rendering, and a running balance that does not follow is a mismatch too; downloads decode the envelope's bytes
// exactly; the month picker never offers a month that has not started; only finance staff and admins see I10.
import { describe, expect, it } from 'vitest';
import { decodeExport, hasBom, isZip } from './collections.ts';
import { allowedMonth, months, reconciles, showsAccount, type Statement } from './statement.ts';

const ils = (minor: string) => ({ minor, currency: 'ILS' as const });
const october: Statement = {
  month: '2026-10',
  currency: 'ILS',
  opening: ils('200000'),
  rows: [
    { date: '2026-10-02', journalId: '0190a0a0-0000-7000-8000-000000000001', kind: 'deposit', description: 'Deposit', amount: ils('1000000'), balance: ils('1200000') },
    { date: '2026-10-09', journalId: '0190a0a0-0000-7000-8000-000000000002', kind: 'allowance', description: 'Allowance', amount: ils('-300000'), balance: ils('900000') },
    { date: '2026-10-20', journalId: '0190a0a0-0000-7000-8000-000000000003', kind: 'fee', description: 'Trip', amount: ils('45000'), balance: ils('945000') },
  ],
  closing: ils('945000'),
};

describe('T-0646 I10 master account', () => {
  it('opening plus the rows equals the closing, in bigint', () => {
    expect(reconciles(october)).toBe(true);
    expect(reconciles({ ...october, opening: ils('9007199254740993'), rows: [], closing: ils('9007199254740993') })).toBe(true);
  });

  it('a statement that does not add up is a mismatch, never numbers', () => {
    expect(reconciles({ ...october, closing: ils('945001') })).toBe(false);
    const broken = { ...october, rows: october.rows.map((r, i) => (i === 1 ? { ...r, balance: ils('900001') } : r)) };
    expect(reconciles(broken)).toBe(false);
  });

  it('downloads decode the bytes exactly: a CSV with its BOM, an XLSX zip', () => {
    const csv = decodeExport({ base64: Buffer.from('\uFEFFdate,kind\r\n2026-10-31,closing\r\n').toString('base64') });
    expect(hasBom(csv)).toBe(true);
    expect(new TextDecoder().decode(csv.slice(3))).toBe('date,kind\r\n2026-10-31,closing\r\n');
    expect(isZip(decodeExport({ base64: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]).toString('base64') }))).toBe(true);
  });

  it('the month picker never offers a future month; a future or malformed ask falls back to the current one', () => {
    expect(months('2026-11', 3)).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(months('2026-01', 2)).toEqual(['2026-01', '2025-12']);
    expect(allowedMonth('2026-12', '2026-11')).toBe('2026-11');
    expect(allowedMonth('2026-10', '2026-11')).toBe('2026-10');
    expect(allowedMonth('2026-13', '2026-11')).toBe('2026-11');
    expect(allowedMonth(undefined, '2026-11')).toBe('2026-11');
  });

  it('finance staff and admins see I10; other staff do not', () => {
    expect([showsAccount('finance'), showsAccount('admin'), showsAccount('staff')]).toEqual([true, true, false]);
  });
});
