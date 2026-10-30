// A12 Ops queue (T-0931, REQ-ADM-005, REQ-INS-015): what the screens decide, apart from rendering. Each case kind
// in plain words; which actions a case offers by its kind, status and the admin's role; the decision note's
// bounds; and, for a suspense credit, the deposit form's prefill, so finance record it against an institution
// without retyping a figure (the API takes the same fields from the case and refuses any that differ).
// A payload may quote a remitter's text: the screens show it as text, never as a link or markup.
import { money, type Money } from '@kesher/domain';
import type { AdminActor, DepositRail, OpsCase, OpsCaseFilter, OpsCaseKind, OpsCaseStatus } from '../data/types.ts';

/** The queue's order: money with no owner first, then what the bank statement disagrees with, then the proofs. */
export const KINDS: readonly OpsCaseKind[] = ['suspense', 'deposit_not_on_statement', 'payout_account_mismatch', 'balance_break', 'system_total_break', 'unbalanced_journal'];
export const STATUSES: readonly OpsCaseStatus[] = ['open', 'investigating', 'resolved', 'dismissed'];

export const KIND_WORDS: Record<OpsCaseKind, { label: string; hint: string }> = {
  suspense: { label: 'Money in, owner unknown', hint: 'A bank credit no institution could be matched to. Record it against the right institution, or dismiss it once the money went back to the sender.' },
  deposit_not_on_statement: { label: 'Deposit not on the statement', hint: 'Finance recorded a deposit the bank statement does not show: a typo, or money that never came.' },
  payout_account_mismatch: { label: 'Payout account changed', hint: 'The bank account a payout went to is not the one on file.' },
  balance_break: { label: 'Balance does not add up', hint: "An account's balance differs from the sum of its postings." },
  system_total_break: { label: 'Books do not balance', hint: 'The ledger as a whole does not sum to zero in a currency.' },
  unbalanced_journal: { label: 'Unbalanced journal', hint: 'A journal whose postings do not sum to zero.' },
};

export const STATUS_WORDS: Record<OpsCaseStatus, string> = { open: 'Open', investigating: 'Being worked', resolved: 'Resolved', dismissed: 'Dismissed' };

/** Why the bank feed could not place a credit (T-0618), in words. */
const REASON_WORDS: Record<string, string> = {
  no_reference: 'The transfer quotes no payment reference.',
  ambiguous_reference: 'The transfer quotes more than one payment reference.',
  unknown_reference: 'The payment reference matches no institution.',
  rail_currency: 'The currency is not one this rail carries.',
  amount_differs: 'A deposit recorded by hand for this line has a different amount.',
  kyb_blocked: "The institution's KYB does not allow deposits yet.",
};
export const reasonWords = (reason: unknown): string | undefined => (typeof reason === 'string' ? REASON_WORDS[reason] : undefined);

const isWorker = (actor: AdminActor): boolean => actor.roles.includes('ops') || actor.roles.includes('finance');
const isOpen = (c: OpsCase): boolean => c.status === 'open' || c.status === 'investigating';

export interface CaseActions {
  assign: boolean;
  resolve: boolean;
  dismiss: boolean;
  /** Record the suspense credit as a deposit: Kesher finance only, as T-0614. */
  record: boolean;
}

/** Support reads and acts on nothing; a decided case offers nothing; a suspense credit resolves only through its deposit. */
export function actionsFor(c: OpsCase, actor: AdminActor): CaseActions {
  if (!isOpen(c) || !isWorker(actor)) return { assign: false, resolve: false, dismiss: false, record: false };
  return { assign: c.assignedTo !== actor.subject, resolve: c.kind !== 'suspense', dismiss: true, record: c.kind === 'suspense' && actor.roles.includes('finance') && depositPrefill(c) !== undefined };
}

export const NOTE_MAX = 500;
/** The decision's note: required, up to 500 characters once trimmed. */
export function parseNote(text: string | undefined): { ok: true; note: string } | { ok: false; problem: 'note_missing' | 'note_too_long' } {
  const note = (text ?? '').trim();
  if (!note) return { ok: false, problem: 'note_missing' };
  if (note.length > NOTE_MAX) return { ok: false, problem: 'note_too_long' };
  return { ok: true, note };
}

export interface DepositPrefill {
  caseId: string;
  amount: Money;
  rail: DepositRail;
  bankReference: string;
  valueDate: string;
  /** The remitter's own words, for finance to read: data, never instructions. */
  remitterReference?: string | undefined;
  /** The institution the feed matched, when it matched one (a KYB block or an amount that differs). */
  institutionId?: string | undefined;
}

const RAIL_SET = new Set<string>(['masav', 'wire', 'ach']);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A suspense case's credit as the deposit form's fields; undefined for any other case, or a payload that is not a credit. */
export function depositPrefill(c: OpsCase): DepositPrefill | undefined {
  if (c.kind !== 'suspense') return undefined;
  const p = c.payload;
  const amount = p['amount'] as { minor?: unknown; currency?: unknown } | undefined;
  const rail = str(p['rail']);
  const bankReference = str(p['bankReference']);
  const valueDate = str(p['valueDate']);
  if (!rail || !RAIL_SET.has(rail) || !bankReference || !valueDate || !/^\d{4}-\d{2}-\d{2}$/.test(valueDate)) return undefined;
  if (typeof amount?.minor !== 'string' || !/^\d+$/.test(amount.minor) || (amount.currency !== 'ILS' && amount.currency !== 'USD')) return undefined;
  const remitterReference = str(p['remitterReference']);
  const institutionId = str(p['institutionId']);
  return { caseId: c.id, amount: money(BigInt(amount.minor), amount.currency), rail: rail as DepositRail, bankReference, valueDate, ...(remitterReference ? { remitterReference } : {}), ...(institutionId ? { institutionId } : {}) };
}

/** The queue as the screen shows it: one group per kind that has cases, in the queue's order. */
export const groupByKind = (cases: readonly OpsCase[]): { kind: OpsCaseKind; cases: OpsCase[] }[] => KINDS.map((kind) => ({ kind, cases: cases.filter((c) => c.kind === kind) })).filter((g) => g.cases.length > 0);

/** The filter from the page's query; anything unknown is ignored, so a hand-edited URL widens the list rather than failing. */
export function filterFrom(q: { kind?: string | undefined; status?: string | undefined; mine?: string | undefined }): OpsCaseFilter {
  const kind = KINDS.find((k) => k === q.kind);
  const status = STATUSES.find((s) => s === q.status);
  return { ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(q.mine === '1' ? { mine: true } : {}) };
}

/** The case page's outcome banner, carried back on the redirect. */
export function doneWords(done: string | undefined): string | undefined {
  switch (done) {
    case 'assign':
      return 'Assigned to you.';
    case 'resolved':
      return 'Resolved.';
    case 'dismissed':
      return 'Dismissed.';
    case 'recorded':
      return 'Recorded as a deposit. A different finance member approves it; when it posts, this case resolves.';
    default:
      return undefined;
  }
}

/** A refusal, carried back on the redirect, in words. */
export function errorWords(code: string | undefined): string | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case 'note_missing':
      return 'Say why in the note.';
    case 'note_too_long':
      return `Keep the note to ${NOTE_MAX} characters.`;
    case 'institution':
      return 'Choose the institution the money belongs to.';
    case 'CONFLICT':
      return 'This case was decided a moment ago, or this credit is already recorded as a deposit. Reload before acting again.';
    case 'FORBIDDEN':
    case 'SAME_APPROVER':
      return 'Only Kesher ops or finance work cases; only finance record a deposit.';
    case 'INVALID':
      return 'The API refused it: a suspense credit is resolved by recording it against an institution, or dismissed.';
    case 'NOT_FOUND':
      return 'That case or institution no longer exists.';
    case 'UNAVAILABLE':
      return 'Deposits are not switched on, or the API is unavailable. Nothing changed.';
    default:
      return 'Something went wrong. Nothing changed; try again.';
  }
}
