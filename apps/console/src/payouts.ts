// I09 Payouts (T-0612, REQ-PO-001/002, REQ-INS-004): the institution pays out of its own account. The form
// checks the payee before any call: an IBAN that fails its mod-97 checksum, or is not Israeli, never
// reaches the API. A new payee over ₪2,000 cools off for 24 hours and says until when; over ₪5,000 a second
// finance member approves; the requester is never offered Approve; a reject needs a reason; a payout the
// bank returned shows as reversed, with the money back in the account.
import { ibanChecksumOk, isIsraeliIban } from '@kesher/ports/payout';
import type { Schemas } from '@kesher/sdk';
import type { Result } from './api.ts';
import { withStepUp } from './step-up.ts';

export type InstitutionPayout = Schemas['InstitutionPayout'];
export type PayoutRequest = Schemas['PayoutRequest'];
export type Role = Schemas['MyInstitution']['role'];

export interface Draft {
  name: string;
  iban: string;
  /** Shekels as typed: "1,250.50". */
  amountText: string;
  reference: string;
}

export type DraftProblem = 'iban' | 'name' | 'amount' | 'reference' | 'over_balance';

const NAME_MAX = 70;
const REFERENCE_MAX = 64;

/** "1,250.50" → 125050 agorot; undefined when it is not an amount above zero. */
export function parseShekels(text: string): bigint | undefined {
  const cleaned = text.replace(/[,\s₪]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [whole, frac = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return minor > 0n ? minor : undefined;
}

export const normalizeIban = (iban: string): string => iban.replace(/[\s-]+/g, '').toUpperCase();

/** Everything the console can know before the call: the IBAN's checksum and country, a name, an amount the account holds, a reference. */
export function checkDraft(d: Draft, available: bigint): { ok: true; body: PayoutRequest } | { ok: false; problems: DraftProblem[] } {
  const problems: DraftProblem[] = [];
  const iban = normalizeIban(d.iban);
  if (!ibanChecksumOk(iban) || !isIsraeliIban(iban)) problems.push('iban');
  const name = d.name.replace(/\s+/g, ' ').trim();
  if (!name || name.length > NAME_MAX) problems.push('name');
  const minor = parseShekels(d.amountText);
  if (minor === undefined) problems.push('amount');
  else if (minor > available) problems.push('over_balance');
  const reference = d.reference.trim();
  if (!reference || reference.length > REFERENCE_MAX) problems.push('reference');
  if (problems.length || minor === undefined) return { ok: false, problems };
  return { ok: true, body: { payee: { iban, name }, amount: { minor: minor.toString(), currency: 'ILS' }, reference } };
}

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
