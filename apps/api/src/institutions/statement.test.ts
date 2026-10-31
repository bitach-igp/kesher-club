// TST-INS-021 the master account statement (T-0645, REQ-INS-021): Ohr held ₪2,000.00 before October. In October:
// a ₪10,000.00 deposit, a ₪3,000.00 allowance run and ₪450.00 of fees. October opens at ₪2,000.00, each row carries
// the balance after it, and opening plus the rows equals the closing ₪9,450.00 in agorot (bigint); November opens
// where October closed. The CSV's closing line and the XLSX's equal the statement; a description that starts like a
// formula is neutralised in the CSV. Staff without a finance role get 403; another institution's staff 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type Currency } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { sheetCells, unzipStored } from './export.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-03T09:00:00Z');
const OHR = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const tokens: Record<string, string> = {};
type Wire = { minor: string; currency: Currency };
type Statement = { opening: Wire; closing: Wire; rows: { date: string; kind: string; description: string; amount: Wire; balance: Wire }[] };
const get = (who: string, path: string, inst = OHR) => dispatch(app, { method: 'GET', url: `/v1/institutions/${inst}/${path}`, headers: { authorization: `Bearer ${tokens[who]}` }, rawBody: '', now: NOW });

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Other', 'IL')`, [OHR, OTHER]);
  for (const [who, inst, role, orgRole] of [['finance', OHR, 'finance', 'org_finance'], ['coordinator', OHR, 'staff', 'org_staff'], ['stranger', OTHER, 'finance', 'org_finance']] as const) {
    const partyId = uuidv7(NOW);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)`, [partyId, inst, role]);
    tokens[who] = (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: ['member', orgRole] })).accessToken;
  }
  const { accounts, ledger } = app.services;
  const ohr = await accounts.institutionAccount(OHR, 'ILS');
  const partner = await accounts.systemAccount('partner_settlement', 'ILS');
  const maya = await accounts.memberAccount(uuidv7(NOW), 'wallet', 'ILS');
  const post = (key: string, kind: string, at: string, legs: [string, bigint][], metadata: Record<string, unknown> = {}) =>
    ledger.post({ idempotencyKey: key, kind, effectiveAt: new Date(at), postings: legs.map(([accountId, amountMinor]) => ({ accountId, currency: 'ILS' as const, amountMinor })), metadata: { institutionId: OHR, ...metadata } });
  // The institution's account is credit-normal: money in is a credit (negative), money out a debit (positive).
  await post('sept-deposit', 'deposit', '2026-09-15T10:00:00Z', [[partner, 200_000n], [ohr, -200_000n]]);
  await post('oct-deposit', 'deposit', '2026-10-02T10:00:00Z', [[partner, 1_000_000n], [ohr, -1_000_000n]]);
  await post('oct-allowance', 'allowance', '2026-10-09T10:00:00Z', [[ohr, 300_000n], [maya, -300_000n]]);
  await post('oct-fee', 'fee', '2026-10-20T10:00:00Z', [[maya, 45_000n], [ohr, -45_000n]], { description: '=HYPERLINK("x") Trip' });
}, 60_000);
afterAll(async () => db.close());

describe('the master account statement (TST-INS-021, T-0645)', () => {
  it('October opens at ₪2,000.00, runs a balance per row, and closes at opening plus the rows', async () => {
    const r = await get('finance', 'statement?month=2026-10');
    expect(r.status).toBe(200);
    const s = r.body as Statement;
    expect(s.opening).toEqual({ minor: '200000', currency: 'ILS' });
    expect(s.rows.map((x) => [x.date, x.kind, x.amount.minor, x.balance.minor])).toEqual([
      ['2026-10-02', 'deposit', '1000000', '1200000'],
      ['2026-10-09', 'allowance', '-300000', '900000'],
      ['2026-10-20', 'fee', '45000', '945000'],
    ]);
    expect(BigInt(s.opening.minor) + s.rows.reduce((t, x) => t + BigInt(x.amount.minor), 0n)).toBe(BigInt(s.closing.minor));
    expect(s.closing).toEqual({ minor: '945000', currency: 'ILS' });
    const nov = (await get('finance', 'statement?month=2026-11')).body as Statement;
    expect([nov.opening, nov.rows, nov.closing]).toEqual([s.closing, [], s.closing]);
  });

  it('the CSV and the XLSX carry the same opening and closing; a formula-like description is neutralised in the CSV', async () => {
    const csv = (await get('finance', 'statement/export?month=2026-10&format=csv')).body as { base64: string; opening: Wire; closing: Wire; contentType: string };
    expect(csv).toMatchObject({ opening: { minor: '200000' }, closing: { minor: '945000' }, contentType: 'text/csv; charset=utf-8' });
    const text = Buffer.from(csv.base64, 'base64').toString('utf8');
    const lines = text.trim().split('\r\n');
    expect(lines.at(-1)).toMatch(/^2026-10-31,,closing,,745000,945000,ILS,/);
    expect(text).toContain(`"'=HYPERLINK(""x"") Trip"`);
    const book = (await get('finance', 'statement/export?month=2026-10&format=xlsx')).body as { base64: string };
    const sheet = sheetCells(unzipStored(new Uint8Array(Buffer.from(book.base64, 'base64'))).get('xl/worksheets/sheet1.xml')!);
    expect(sheet.at(-1)?.slice(2, 6)).toEqual(['closing', '', '745000', '945000']);
    expect(sheet[1]?.slice(2, 6)).toEqual(['opening', '', '200000', '200000']);
  });

  it('staff without a finance role get 403; another institution 404; a bad month 422', async () => {
    expect((await get('coordinator', 'statement?month=2026-10')).status).toBe(403);
    expect((await get('stranger', 'statement?month=2026-10')).status).toBe(404);
    expect((await get('finance', 'statement?month=2026-13')).status).toBe(422);
    expect((await get('finance', 'statement/export?month=2026-10&format=pdf')).status).toBe(422);
  });
});
