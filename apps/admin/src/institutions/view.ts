// The console's institutions area (T-0615, REQ-INS-007, REQ-ADM-004): what the screens decide, apart from
// rendering. Finance types an amount in major units and it leaves as minor units (bigint); Masav carries
// shekels and ACH dollars; the recorder of a deposit is never offered Approve or Reject; support sees the
// area but records nothing; an API refusal reaches the screen as words, not as a problem body.
import { format, money, type Currency, type Money } from '@kesher/domain';
import type { AdminActor, DepositInput, DepositRail, Deposit } from '../data/types.ts';

export const RAILS: readonly { rail: DepositRail; label: string; currencies: readonly Currency[] }[] = [
  { rail: 'masav', label: 'Masav', currencies: ['ILS'] },
  { rail: 'wire', label: 'Wire', currencies: ['ILS', 'USD'] },
  { rail: 'ach', label: 'ACH', currencies: ['USD'] },
];

export type FormProblem = 'amount' | 'currency' | 'rail' | 'reference' | 'date';

/** "20,000.50" → 2000050n; undefined unless it is an amount above zero with at most two decimals. */
export function majorToMinor(text: string): bigint | undefined {
  const cleaned = text.replace(/[,\s₪$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [whole, frac = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return minor > 0n ? minor : undefined;
}

/** The record form, checked before any call: everything the API would refuse for shape is refused here first. */
export function parseDepositForm(f: { amount?: string | undefined; currency?: string | undefined; rail?: string | undefined; bankReference?: string | undefined; valueDate?: string | undefined; note?: string | undefined; key?: string | undefined }, now: Date): { ok: true; input: DepositInput } | { ok: false; problems: FormProblem[] } {
  const problems: FormProblem[] = [];
  const rail = RAILS.find((r) => r.rail === f.rail);
  if (!rail) problems.push('rail');
  const currency = f.currency === 'ILS' || f.currency === 'USD' ? f.currency : undefined;
  if (!currency || (rail && !rail.currencies.includes(currency))) problems.push('currency');
  const minor = majorToMinor(f.amount ?? '');
  if (minor === undefined) problems.push('amount');
  const bankReference = (f.bankReference ?? '').replace(/\s+/g, '').toUpperCase();
  if (!bankReference || bankReference.length > 64) problems.push('reference');
  const valueDate = f.valueDate ?? '';
  const real = /^\d{4}-\d{2}-\d{2}$/.test(valueDate) && new Date(`${valueDate}T00:00:00Z`).toISOString().slice(0, 10) === valueDate;
  if (!real || valueDate > now.toISOString().slice(0, 10)) problems.push('date');
  if (problems.length || !rail || !currency || minor === undefined || !f.key) return { ok: false, problems: problems.length ? problems : ['amount'] };
  return { ok: true, input: { amount: money(minor, currency), rail: rail.rail, bankReference, valueDate, ...(f.note ? { note: f.note.slice(0, 500) } : {}), key: f.key } };
}

export const isFinance = (actor: AdminActor): boolean => actor.roles.includes('finance');

/** Approve and Reject are for a different finance member, on a deposit still pending. */
export const canDecide = (d: Deposit, actor: AdminActor): boolean => d.status === 'pending' && !d.recordedByMe && isFinance(actor);

const PROBLEM_WORDS: Record<FormProblem, string> = {
  amount: 'Enter the amount from the statement, above zero, like 20,000.00.',
  currency: 'Masav carries shekels and ACH dollars; a wire can carry either.',
  rail: 'Choose how the money arrived: Masav, wire or ACH.',
  reference: 'Enter the bank reference from the statement line, up to 64 characters.',
  date: 'Enter the value date from the statement; it cannot be in the future.',
};
export const problemWords = (p: FormProblem): string => PROBLEM_WORDS[p];

/** An API refusal, carried back on the redirect, in words. */
export function errorWords(code: string | undefined): string | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case 'CONFLICT':
      return 'That bank reference is already recorded on this rail, or the deposit was already decided. Check the list below before recording it again.';
    case 'SAME_APPROVER':
      return 'You recorded this deposit, so a different finance member approves or rejects it.';
    case 'FORBIDDEN':
      return 'Only Kesher finance can record, approve or reject deposits.';
    case 'NOT_FOUND':
      return 'That institution or deposit no longer exists.';
    case 'INVALID':
      return 'The API refused the entry: check the amount, the currency for the rail, the reference and the date.';
    case 'UNAVAILABLE':
      return 'Deposits are not switched on, or the API is unavailable. Nothing was recorded.';
    default:
      return 'Something went wrong. Nothing was recorded; try again.';
  }
}

export const money$ = (m: Money): string => format(m);
export const formProblem = (v: string | undefined): FormProblem | undefined => (v && v in PROBLEM_WORDS ? (v as FormProblem) : undefined);
