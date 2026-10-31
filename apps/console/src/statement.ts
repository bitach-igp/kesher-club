// I10 master account and I12 reports (T-0646, REQ-INS-021, REQ-INS-006): the master balances, how to fund the
// account, a month's statement with its downloads, and the exports that exist (the statement, the collections
// month, the allowance run history). The statement is checked before it renders: opening plus every row must equal
// the closing balance in bigint, and each row's balance must follow from the one before; a statement that does not
// add up shows an error, never numbers. The month picker never offers a month that has not started.
import { fromWire } from '@kesher/domain';
import type { Schemas } from '@kesher/sdk';
import { shiftMonth } from './collections.ts';

export type Statement = Schemas['InstitutionStatement'];

/** Opening + rows = closing, and every running balance follows from the one before, in bigint. */
export function reconciles(s: Statement): boolean {
  let balance = fromWire(s.opening).minor;
  for (const r of s.rows) {
    balance += fromWire(r.amount).minor;
    if (fromWire(r.balance).minor !== balance) return false;
  }
  return balance === fromWire(s.closing).minor;
}

/** The last `count` months, newest first, never one that has not started. */
export function months(current: string, count = 12): string[] {
  return Array.from({ length: count }, (_v, i) => shiftMonth(current, -i));
}

/** A month the picker may ask for: well formed, and not after the current one. */
export const allowedMonth = (month: string | undefined, current: string): string => (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= current ? month : current);

/** Who reads I10: finance staff and admins, as the API decides; other staff never see the entry. */
export const showsAccount = (role: 'staff' | 'finance' | 'admin'): boolean => role === 'finance' || role === 'admin';
