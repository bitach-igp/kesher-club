// Monthly export (T-0606, TST-INS-006): the export's totals equal the ledger postings for the institution;
// CSV and XLSX carry the same rows; member names are data (a name shaped like a formula stays text).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { AccountService } from '../ledger/accounts.ts';
import { PostgresLedger } from '../ledger/post.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { cells, crc32, exportFile, monthBounds, monthlyExport, neutralise, sheetCells, toCsv, toXlsx, unzipStored, zipStored } from './export.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
let accounts: AccountService;
const INST = uuidv7(new Date('2026-11-01T00:00:00Z'));
const OTHER = uuidv7(new Date('2026-11-01T00:00:00Z'));
const noa = uuidv7(new Date('2026-11-01T00:00:00Z'));
const evil = uuidv7(new Date('2026-11-01T00:00:00Z'));

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL'), ($2, 'Other', 'IL')`, [INST, OTHER]);
  await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, 'Noa Example', $3, 'active'), ($4, $2, '=HYPERLINK("https://evil.example","pay")', $5, 'active')`, [uuidv7(), INST, noa, uuidv7(), evil]);
  const master = await accounts.systemAccount('institution_master', 'ILS');
  const post = async (key: string, kind: string, party: string, minor: bigint, at: string, inst = INST, description?: string) => {
    const wallet = await accounts.memberAccount(party, 'wallet', 'ILS');
    // allowance: master pays the member; fee: the member pays the master.
    const postings = kind === 'allowance' ? [{ accountId: master, currency: 'ILS' as const, amountMinor: minor }, { accountId: wallet, currency: 'ILS' as const, amountMinor: -minor }] : [{ accountId: wallet, currency: 'ILS' as const, amountMinor: minor }, { accountId: master, currency: 'ILS' as const, amountMinor: -minor }];
    return ledger.post({ idempotencyKey: key, kind, effectiveAt: new Date(at), postings, metadata: { institutionId: inst, memberPartyId: party, ...(description ? { description } : {}) } });
  };
  await post('x-allow-1', 'allowance', noa, 50_000n, '2026-11-03T08:00:00Z');
  await post('x-allow-2', 'allowance', evil, 50_000n, '2026-11-10T08:00:00Z');
  await post('x-fee-1', 'fee', noa, 12_000n, '2026-11-15T08:00:00Z', INST, 'Tuition, term 1');
  await post('x-fee-2', 'fee', evil, 8_000n, '2026-11-20T08:00:00Z', INST, 'Books "and" more');
  await post('x-fee-other', 'fee', noa, 99_900n, '2026-11-21T08:00:00Z', OTHER);
  await post('x-fee-oct', 'fee', noa, 77_700n, '2026-10-31T23:59:59Z');
  await post('x-fee-dec', 'fee', noa, 66_600n, '2026-12-01T00:00:00Z');
}, 60_000);
afterAll(async () => db.close());

describe('TST-INS-006: the monthly export', () => {
  it('reads the institution\'s month from the ledger and its totals equal the postings; other institutions and other months stay out', async () => {
    const e = await monthlyExport(db, INST, '2026-11', 'ILS');
    expect(e.rows.map((r) => [r.date, r.kind, r.memberName, r.amount.minor])).toEqual([
      ['2026-11-03', 'allowance', 'Noa Example', -50_000n],
      ['2026-11-10', 'allowance', '=HYPERLINK("https://evil.example","pay")', -50_000n],
      ['2026-11-15', 'fee', 'Noa Example', 12_000n],
      ['2026-11-20', 'fee', '=HYPERLINK("https://evil.example","pay")', 8_000n],
    ]);
    expect(e.totals).toEqual({ allowancesOut: money(-100_000n, 'ILS'), feesIn: money(20_000n, 'ILS'), net: money(-80_000n, 'ILS') });
    const ledgerSum = (await db.query<{ s: string }>(`select coalesce(sum(p.amount_minor), 0)::text as s from ledger.posting p join ledger.account a on a.id = p.account_id join ledger.journal j on j.id = p.journal_id where a.type = 'institution_master' and a.currency = 'ILS' and j.metadata->>'institutionId' = $1 and j.effective_at >= '2026-11-01' and j.effective_at < '2026-12-01'`, [INST])).rows[0]!.s;
    expect(-BigInt(ledgerSum)).toBe(e.totals.net.minor);
    expect(e.rows[2]!.description).toBe('Tuition, term 1');
    expect((await monthlyExport(db, INST, '2026-10', 'ILS')).rows.map((r) => r.amount.minor)).toEqual([77_700n]);
    expect((await monthlyExport(db, INST, '2026-09', 'ILS')).rows).toEqual([]);
    expect((await monthlyExport(db, INST, '2026-11', 'USD')).rows).toEqual([]);
    expect(() => monthBounds('2026-13')).toThrow(RangeError);
    expect(monthBounds('2026-02')).toEqual({ start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') });
  });

  it('CSV and XLSX carry the same rows, with the header and the three totals; a formula-shaped name is neutralised in both', async () => {
    const e = await monthlyExport(db, INST, '2026-11', 'ILS');
    const grid = cells(e);
    expect(grid).toHaveLength(1 + 4 + 3);
    expect(grid[0]).toEqual(['date', 'journal_id', 'kind', 'member_name', 'member_party_id', 'description', 'amount_minor', 'currency', 'amount']);
    expect(grid[7]).toEqual(['', '', 'total', 'net', '', '', '-80000', 'ILS', '−₪800.00']);

    const csv = toCsv(e);
    expect(csv.startsWith('﻿date,journal_id,kind')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(8);
    expect(lines[2]).toContain(`"'=HYPERLINK(""https://evil.example"",""pay"")"`); // quoted, doubled quotes, and defused
    expect(lines[4]).toContain(`"Books ""and"" more"`);
    expect(neutralise('=1+1')).toBe("'=1+1");
    expect(neutralise('+972')).toBe("'+972");
    expect(neutralise('Noa')).toBe('Noa');

    const xlsx = toXlsx(e);
    const parts = unzipStored(xlsx);
    expect([...parts.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']);
    const sheet = sheetCells(parts.get('xl/worksheets/sheet1.xml')!);
    expect(sheet).toEqual(grid.map((row) => row.map(neutralise)));
    expect(parts.get('xl/workbook.xml')).toContain('name="2026-11"');
    // The zip's own integrity: CRC of a known string, and every entry's recorded CRC matches its data.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const z = zipStored([['a.txt', 'hello']]);
    expect(unzipStored(z).get('a.txt')).toBe('hello');

    const file = exportFile(e, 'xlsx');
    expect(file).toMatchObject({ filename: `kesher-${INST.slice(0, 8)}-2026-11-ILS.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', rows: 4, totals: { net: { minor: '-80000', currency: 'ILS' } } });
    expect(Buffer.from(file.base64, 'base64')).toEqual(Buffer.from(xlsx));
    expect(Buffer.from(exportFile(e, 'csv').base64, 'base64').toString('utf8')).toBe(csv);
  });
});
