// I09 Payouts (T-0612, REQ-PO-001/002, REQ-INS-004): the institution withdraws from its account to its own
// verified bank account (T-0625, REQ-INS-012), so the form asks only for an amount and a reference; the API
// fills the payee. A new account over ₪2,000 cools off for 24 hours and says until when; over ₪5,000 a second
// finance member approves; the requester is never offered Approve; a reject needs a reason; a payout the
// bank returned shows as reversed, with the money back in the account.
import type { Schemas } from '@kesher/sdk';
import type { Result } from './api.ts';
import { withStepUp } from './step-up.ts';

export type InstitutionPayout = Schemas['InstitutionPayout'];
export type PayoutRequest = Schemas['InstitutionPayoutRequest'];
export type OwnAccount = Schemas['InstitutionPayoutAccount'];
export type Role = Schemas['MyInstitution']['role'];

export interface Draft {
  /** Shekels as typed: "1,250.50". */
  amountText: string;
  reference: string;
}

export type DraftProblem = 'amount' | 'reference' | 'over_balance';

const REFERENCE_MAX = 64;

/** "1,250.50" → 125050 agorot; undefined when it is not an amount above zero. */
export function parseShekels(text: string): bigint | undefined {
  const cleaned = text.replace(/[,\s₪]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [whole, frac = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return minor > 0n ? minor : undefined;
}

/** Everything the console can know before the call: an amount the account holds, a reference. */
export function checkDraft(d: Draft, available: bigint): { ok: true; body: PayoutRequest } | { ok: false; problems: DraftProblem[] } {
  const problems: DraftProblem[] = [];
  const minor = parseShekels(d.amountText);
  if (minor === undefined) problems.push('amount');
  else if (minor > available) problems.push('over_balance');
  const reference = d.reference.trim();
  if (!reference || reference.length > REFERENCE_MAX) problems.push('reference');
  if (problems.length || minor === undefined) return { ok: false, problems };
  return { ok: true, body: { amount: { minor: minor.toString(), currency: 'ILS' }, reference } };
}

/** Where a withdrawal goes, or why none can: no verified account yet, or a change waiting for Kesher compliance. */
export type Destination = { kind: 'own'; holderName: string; last4: string } | { kind: 'none' } | { kind: 'pending' };
export const destination = (a: OwnAccount): Destination =>
  a.changePending ? { kind: 'pending' } : a.account ? { kind: 'own', holderName: a.account.holderName, last4: a.account.ibanMasked.slice(-4) } : { kind: 'none' };

/** Approve and reject are for a different finance member, on a payout waiting for one. */
export const canDecide = (p: InstitutionPayout, role: Role): boolean => p.state === 'awaiting_second_approval' && !p.requestedByMe && role === 'finance';

export type Outcome = { kind: 'done'; payout: InstitutionPayout } | { kind: 'invalid'; problems: DraftProblem[] } | { kind: 'cancelled' } | { kind: 'error'; code: string };

export interface PayoutDeps {
  create(body: PayoutRequest, idempotencyKey: string): Promise<Result<InstitutionPayout>>;
  approve(id: string, idempotencyKey: string): Promise<Result<InstitutionPayout>>;
  reject(id: string, reason: string, idempotencyKey: string): Promise<Result<InstitutionPayout>>;
  stepUp(): Promise<boolean>;
  newKey(): string;
}

const outcome = (r: Result<InstitutionPayout>): Outcome => (r.ok ? { kind: 'done', payout: r.value } : r.code === 'STEP_UP_CANCELLED' ? { kind: 'cancelled' } : { kind: 'error', code: r.code });

/** Checks the draft, then creates the payout once per attempt key, with one step-up when asked. */
export async function submitPayout(d: PayoutDeps, draft: Draft, available: bigint): Promise<Outcome> {
  const checked = checkDraft(draft, available);
  if (!checked.ok) return { kind: 'invalid', problems: checked.problems };
  const key = d.newKey();
  return outcome(await withStepUp(() => d.create(checked.body, key), d.stepUp));
}

export async function approvePayout(d: PayoutDeps, id: string): Promise<Outcome> {
  const key = d.newKey();
  return outcome(await withStepUp(() => d.approve(id, key), d.stepUp));
}

/** A reject says why, or it is not sent. */
export async function rejectPayout(d: PayoutDeps, id: string, reason: string): Promise<Outcome> {
  const why = reason.trim();
  if (!why) return { kind: 'invalid', problems: ['reference'] };
  const key = d.newKey();
  return outcome(await withStepUp(() => d.reject(id, why, key), d.stepUp));
}
