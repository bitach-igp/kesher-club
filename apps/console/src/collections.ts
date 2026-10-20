// I08 Collections (T-0611, REQ-INS-006): who has paid this month (with receipts) and who still owes, per
// student, and the month's export. Fees only: the console shows no spend detail for any student, consented
// or not, because no API serves it yet (REQ-INS-005 lets staff see it only with consent; that screen comes
// with its own API). The export arrives as a base64 envelope and leaves as the exact bytes the API wrote.
import type { Schemas } from '@kesher/sdk';

export type Collections = Schemas['Collections'];
export type ExportFile = Schemas['ExportFile'];
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
