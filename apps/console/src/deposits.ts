// Deposits for a US institution (T-0630, REQ-INS-009): finance pull dollars from the institution's bank by ACH
// (T-0617). The bank holds a pull for a few business days: the screen shows what is on hold and until when,
// apart from what the institution can spend, and says plainly when the bank returned a pull. A retry of the same
// amount keeps its Idempotency-Key, so a pull whose answer was lost is never made twice; a new amount is a new
// pull. IL institutions fund by recorded transfer (T-0614) and have no Deposits screen.
import type { Schemas } from '@kesher/sdk';
import type { Result } from './api.ts';
import type { CopyKey } from './i18n.ts';
import type { Landing } from './session.ts';
import { withStepUp } from './step-up.ts';

export type AchPull = Schemas['InstitutionAchPull'];
export type AchPullRequest = Schemas['InstitutionAchPullRequest'];

/** Only a US institution's finance staff pull by ACH. */
export const showsDeposits = (l: Landing): boolean => l.kind === 'dashboard' && l.institution.market === 'US' && l.role === 'finance';

/** "10,000.50" → 1000050 cents; undefined when it is not an amount above zero. */
export function parseDollars(text: string): bigint | undefined {
  const cleaned = text.replace(/[,\s$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [whole, frac = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return minor > 0n ? minor : undefined;
}

/** Where a pull stands, as a line of copy. */
export function stateLine(p: AchPull): { key: CopyKey; vars?: Record<string, string> } {
  switch (p.state) {
    case 'on_hold':
      return { key: 'deposits.state.on_hold', vars: { date: p.holdUntil ?? '' } };
    case 'settled':
      return { key: 'deposits.state.settled' };
    case 'failed':
      return { key: 'deposits.state.failed', vars: { code: p.failureCode ?? '' } };
    default:
      return { key: 'deposits.state.processing' };
  }
}

/** The Idempotency-Key a submission goes with: the last attempt's for the same amount that did not land, else new. */
export interface Attempt {
  amountText: string;
  key: string;
}
export const attemptFor = (last: Attempt | undefined, amountText: string, newKey: () => string): Attempt => (last && last.amountText.trim() === amountText.trim() ? last : { amountText, key: newKey() });

export type Outcome = { kind: 'done'; pull: AchPull } | { kind: 'invalid' } | { kind: 'cancelled' } | { kind: 'error'; code: string };

export interface PullDeps {
  create(body: AchPullRequest, idempotencyKey: string): Promise<Result<AchPull>>;
  stepUp(): Promise<boolean>;
  newKey(): string;
}

/**
 * Checks the amount, then pulls once per attempt, with one step-up when asked. The attempt comes back for the
 * caller to keep until the pull lands: a retry after a lost answer is the same pull, not a second one.
 */
export async function submitPull(d: PullDeps, amountText: string, last: Attempt | undefined): Promise<{ outcome: Outcome; attempt: Attempt | undefined }> {
  const minor = parseDollars(amountText);
  if (minor === undefined) return { outcome: { kind: 'invalid' }, attempt: last };
  const attempt = attemptFor(last, amountText, d.newKey);
  const r = await withStepUp(() => d.create({ amount: { minor: minor.toString(), currency: 'USD' } }, attempt.key), d.stepUp);
  if (r.ok) return { outcome: { kind: 'done', pull: r.value }, attempt: undefined };
  return { outcome: r.code === 'STEP_UP_CANCELLED' ? { kind: 'cancelled' } : { kind: 'error', code: r.code }, attempt };
}

/** A refusal as a plain sentence. */
export const errorKey = (code: string): CopyKey => (code === 'FEATURE_OFF' ? 'deposits.off' : code === 'FORBIDDEN' || code === 'NOT_FOUND' ? 'error.forbidden' : 'error.generic');
