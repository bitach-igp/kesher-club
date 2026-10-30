// I08 Collections (T-0611, REQ-INS-006): who has paid this month (with receipts) and who still owes, per
// student, and the month's export. Fees only: the console shows no spend detail for any student, consented
// or not, because no API serves it yet (REQ-INS-005 lets staff see it only with consent; that screen comes
// with its own API). The export arrives as a base64 envelope and leaves as the exact bytes the API wrote.
// Billing (T-0629): finance bills a fee to every active member; the amount and the due date are checked first.
import type { Schemas } from '@kesher/sdk';
import type { Result } from './api.ts';
import { parseShekels } from './payouts.ts';

export type Collections = Schemas['Collections'];
export type ExportFile = Schemas['ExportFile'];
export type FeeBillRequest = Schemas['FeeBillRequest'];
export type FeeBatch = Schemas['FeeBatch'];
type Money = Schemas['Money'];

export interface StudentFees {
  memberName: string;
  currency: Money['currency'];
  /** Minor units still due. */
  owed: bigint;
  /** Minor units paid this month. */
  paid: bigint;
  receipts: string[];
}

const add = (totals: Map<string, bigint>, m: Money) => totals.set(m.currency, (totals.get(m.currency) ?? 0n) + BigInt(m.minor));
const asMap = (list: readonly Money[]) => new Map(list.map((m) => [m.currency, BigInt(m.minor)]));
const same = (a: Map<string, bigint>, b: Map<string, bigint>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** True when the paid and owed totals the API sent equal the sums of their rows, per currency, in bigint. */
export function totalsMatch(c: Collections): boolean {
  const paid = new Map<string, bigint>();
  const owed = new Map<string, bigint>();
  for (const i of c.items) add(paid, i.amount);
  for (const o of c.owed) add(owed, o.amount);
  return same(paid, asMap(c.total)) && same(owed, asMap(c.owedTotal));
}

/** One row per student and currency: what they owe, what they paid this month, and the receipts. */
export function byStudent(c: Collections): StudentFees[] {
  const rows = new Map<string, StudentFees>();
  const row = (memberName: string, currency: Money['currency']) => {
    const k = `${currency}\u0000${memberName}`;
    const r = rows.get(k) ?? { memberName, currency, owed: 0n, paid: 0n, receipts: [] };
    rows.set(k, r);
    return r;
  };
  for (const o of c.owed) row(o.memberName, o.amount.currency).owed += BigInt(o.amount.minor);
  for (const i of c.items) {
    const r = row(i.memberName, i.amount.currency);
    r.paid += BigInt(i.amount.minor);
    r.receipts.push(i.receiptNumber);
  }
  return [...rows.values()].sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : a.memberName.localeCompare(b.memberName)));
}

/** The export's exact bytes, from the envelope's base64. */
export function decodeExport(file: ExportFile): Uint8Array {
  const bin = atob(file.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A UTF-8 CSV that Excel opens in Hebrew starts with the byte-order mark; an XLSX is a zip ("PK\x03\x04"). */
export const hasBom = (b: Uint8Array): boolean => b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
export const isZip = (b: Uint8Array): boolean => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** "2026-11" for a Date, in UTC like the API's months. */
export const monthOf = (d: Date): string => d.toISOString().slice(0, 7);
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return monthOf(new Date(Date.UTC(y, m - 1 + by, 1)));
}

/** The API's ceiling, a typo guard: 10,000.00 a member. */
export const MAX_FEE_MINOR = 1_000_000n;
const DESCRIPTION_MAX = 120;

export interface BillDraft {
  description: string;
  /** Major units as typed: "120" or "1,250.50". */
  amountText: string;
  /** YYYY-MM-DD, from the date input. */
  dueDate: string;
}

export type BillProblem = 'description' | 'amount' | 'over_max' | 'due';

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Everything the console can know before the call: a description, an amount, a due date from today to a year on. */
export function checkBill(d: BillDraft, market: 'IL' | 'US', today: string): { ok: true; body: FeeBillRequest } | { ok: false; problems: BillProblem[] } {
  const problems: BillProblem[] = [];
  const description = d.description.trim();
  if (!description || description.length > DESCRIPTION_MAX) problems.push('description');
  const minor = parseShekels(d.amountText);
  if (minor === undefined) problems.push('amount');
  else if (minor > MAX_FEE_MINOR) problems.push('over_max');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate) || d.dueDate < today || d.dueDate > addDays(today, 366)) problems.push('due');
  if (problems.length || minor === undefined) return { ok: false, problems };
  return { ok: true, body: { description, amount: { minor: minor.toString(), currency: market === 'US' ? 'USD' : 'ILS' }, dueDate: d.dueDate, members: { kind: 'all' } } };
}

export type BillOutcome = { kind: 'done'; batch: FeeBatch } | { kind: 'invalid'; problems: BillProblem[] } | { kind: 'off' } | { kind: 'error'; code: string };

export interface BillDeps {
  create(body: FeeBillRequest, idempotencyKey: string): Promise<Result<FeeBatch>>;
  newKey(): string;
}

/** Checks the draft, then bills once per attempt key. */
export async function billMembers(d: BillDeps, draft: BillDraft, market: 'IL' | 'US', today: string): Promise<BillOutcome> {
  const checked = checkBill(draft, market, today);
  if (!checked.ok) return { kind: 'invalid', problems: checked.problems };
  const r = await d.create(checked.body, d.newKey());
  if (r.ok) return { kind: 'done', batch: r.value };
  return r.code === 'FEATURE_OFF' ? { kind: 'off' } : { kind: 'error', code: r.code };
}

