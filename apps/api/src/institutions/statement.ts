// The master account statement (T-0645, REQ-INS-021): one month of the institution's own account in one currency,
// for its finance staff and admins. The opening balance is everything posted before the month; each row is one
// journal that posted to the account, with the running balance after it; the closing balance is the opening plus
// every row, so a statement reconciles by construction and the next month opens where this one closed. The same rows
// download as CSV or XLSX in the base64 envelope the collections export uses. Descriptions are text people typed:
// data in a cell, neutralised against spreadsheet formulas in the CSV, inline strings in the XLSX.
import { DomainError, format, money, toWire, type Currency, type Money } from '@kesher/domain';
import type { Database } from '../db.ts';
import { ok, requireRole, route, type Handler } from '../http.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { StaffOf } from './ach.ts';
import { MONTH, monthBounds, neutralise, xlsx } from './export.ts';

export interface StatementRow {
  date: string;
  journalId: string;
  kind: string;
  description: string;
  /** From the institution's side: money in is positive, money out negative. */
  amount: Money;
  /** The balance after this row. */
  balance: Money;
}

export interface Statement {
  institutionId: string;
  month: string;
  currency: Currency;
  opening: Money;
  rows: StatementRow[];
  closing: Money;
}

const WORDS: Record<string, string> = { deposit: 'Deposit', allowance: 'Allowance', fee: 'Fee collected', payout: 'Payout', reversal: 'Reversal', ach_pull: 'Bank pull', credit_draw: 'Credit draw' };

export async function statement(db: Database, accounts: Pick<AccountService, 'institutionAccount'>, institutionId: string, month: string, currency: Currency): Promise<Statement> {
  const { start, end } = monthBounds(month);
  const account = await accounts.institutionAccount(institutionId, currency);
  // The account is credit-normal: a credit (a negative posting) is money arriving, so every amount is negated.
  const before = await db.query<{ total: string }>(
    `select coalesce(-sum(p.amount_minor), 0)::text as total from ledger.posting p join ledger.journal j on j.id = p.journal_id where p.account_id = $1 and j.effective_at < $2`,
    [account, start],
  );
  const r = await db.query<{ journal_id: string; kind: string; effective_at: string | Date; metadata: Record<string, unknown>; amount: string }>(
    `select j.id as journal_id, j.kind, j.effective_at, j.metadata, (-sum(p.amount_minor))::text as amount
       from ledger.posting p join ledger.journal j on j.id = p.journal_id
      where p.account_id = $1 and j.effective_at >= $2 and j.effective_at < $3
      group by j.id, j.kind, j.effective_at, j.metadata
      order by j.effective_at, j.id`,
    [account, start, end],
  );
  const opening = BigInt(before.rows[0]?.total ?? '0');
  let balance = opening;
  const rows = r.rows.map((x): StatementRow => {
    const amount = BigInt(x.amount);
    balance += amount;
    const description = typeof x.metadata['description'] === 'string' ? x.metadata['description'] : (WORDS[x.kind] ?? x.kind.replace(/_/g, ' '));
    return { date: new Date(x.effective_at).toISOString().slice(0, 10), journalId: x.journal_id, kind: x.kind, description, amount: money(amount, currency), balance: money(balance, currency) };
  });
  return { institutionId, month, currency, opening: money(opening, currency), rows, closing: money(balance, currency) };
}

export const STATEMENT_HEADERS = ['date', 'journal_id', 'kind', 'description', 'amount_minor', 'balance_minor', 'currency', 'amount', 'balance'] as const;

/** The same cells feed the CSV and the XLSX: the opening line, the rows, then the closing line. */
export function statementCells(s: Statement): string[][] {
  const line = (date: string, kind: string, amount: Money, balance: Money) => [date, '', kind, '', amount.minor.toString(), balance.minor.toString(), s.currency, format(amount), format(balance)];
  const { start, end } = monthBounds(s.month);
  const last = new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10);
  return [
    [...STATEMENT_HEADERS],
    line(start.toISOString().slice(0, 10), 'opening', s.opening, s.opening),
    ...s.rows.map((x) => [x.date, x.journalId, x.kind, x.description, x.amount.minor.toString(), x.balance.minor.toString(), s.currency, format(x.amount), format(x.balance)]),
    line(last, 'closing', money(s.closing.minor - s.opening.minor, s.currency), s.closing),
  ];
}

const DESCRIPTION = STATEMENT_HEADERS.indexOf('description');

export function statementCsv(s: Statement): string {
  const esc = (v: string, ci: number) => {
    const t = ci === DESCRIPTION ? neutralise(v) : v;
    return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
  };
  return `\uFEFF${statementCells(s)
    .map((row) => row.map(esc).join(','))
    .join('\r\n')}\r\n`;
}

export function statementFile(s: Statement, fmt: 'csv' | 'xlsx') {
  const bytes = fmt === 'csv' ? new TextEncoder().encode(statementCsv(s)) : xlsx(s.month, statementCells(s));
  return {
    filename: `kesher-statement-${s.institutionId.slice(0, 8)}-${s.month}-${s.currency}.${fmt}`,
    contentType: fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: Buffer.from(bytes).toString('base64'),
    rows: s.rows.length,
    opening: toWire(s.opening),
    closing: toWire(s.closing),
  };
}

const wire = (s: Statement) => ({
  month: s.month,
  currency: s.currency,
  opening: toWire(s.opening),
  rows: s.rows.map((x) => ({ ...x, amount: toWire(x.amount), balance: toWire(x.balance) })),
  closing: toWire(s.closing),
});

export function statementHandlers(db: Database, accounts: Pick<AccountService, 'institutionAccount'>, staffOf: StaffOf): Record<string, Handler> {
  /** Finance staff and admins of this institution; other staff 403, another institution 404. */
  const read = async (req: Parameters<Handler>[0]): Promise<Statement> => {
    const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
    const institutionId = req.params['id'] ?? '';
    const staff = await staffOf(p.partyId);
    if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
    if (staff.role !== 'finance' && staff.role !== 'admin') throw new DomainError('FORBIDDEN', 'The statement is for finance staff and admins');
    const month = req.query['month'] ?? '';
    if (!MONTH.test(month)) throw new DomainError('VALIDATION_FAILED', 'month must be YYYY-MM');
    const currency = req.query['currency'] ?? 'ILS';
    if (currency !== 'ILS' && currency !== 'USD') throw new DomainError('VALIDATION_FAILED', 'currency must be ILS or USD');
    return statement(db, accounts, institutionId, month, currency);
  };
  return {
    getInstitutionStatement: route(async (req) => ok(wire(await read(req)))),
    exportInstitutionStatement: route(async (req) => {
      const fmt = req.query['format'];
      if (fmt !== 'csv' && fmt !== 'xlsx') throw new DomainError('VALIDATION_FAILED', 'format must be csv or xlsx');
      return ok(statementFile(await read(req), fmt));
    }),
  };
}
