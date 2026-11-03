// The US bank account screen (T-0651, REQ-INS-022, REQ-INS-024), behind institutions.usBanking. The institution's own US account at Kesher's
// banking partner: where the application stands, the account once approved, and funding the master account from it. Funding is two people:
// one finance user or admin asks (with a quote that shows the fee and the date), a second approves; the screen never offers a person their
// own request to approve (the API refuses it too). Amounts are bigint minor units from the first keystroke to the wire: nothing here is a float.
// The console has no flag read of its own: a switched-off flag is the API's 404 FEATURE_OFF, and the page then sends the person home.
import type { Schemas } from '@kesher/sdk';
import type { Result } from './api.ts';
import { parseDollars } from './deposits.ts';
import type { CopyKey } from './i18n.ts';
import type { Landing } from './session.ts';
import { withStepUp } from './step-up.ts';

export type UsBanking = Schemas['InstitutionUsBanking'];
export type UsBankingLink = Schemas['InstitutionUsBankingLink'];
export type UsFunding = Schemas['UsFunding'];
export type UsFundingQuote = Schemas['UsFundingQuote'];
export type Money = Schemas['Money'];
export type StartInput = { holder: 'platform' | 'institution'; usEntity?: { legalName: string; ein: string } };

const EIN = /^\d{2}-?\d{7}$/;

/** Finance staff and admins see the screen; the API decides the rest (including a switched-off flag). */
export const showsUsBanking = (l: Landing): boolean => l.kind === 'dashboard' && (l.role === 'finance' || l.role === 'admin');

/** Where the bank's decision stands, as copy. An approved account whose KYB does not yet allow money says so. */
export function bankingState(b: UsBanking): CopyKey {
  switch (b.status) {
    case 'pending':
      return 'usbank.state.pending';
    case 'needs_info':
      return 'usbank.state.needs_info';
    case 'rejected':
      return 'usbank.state.rejected';
    case 'approved':
      return b.moneyOpen ? 'usbank.state.approved' : 'usbank.state.approved_kyb';
    default:
      return 'usbank.state.not_linked';
  }
}

/** Only an institution admin starts or continues the application (the API says so too), and not once the bank decided. */
export const canStart = (l: Landing, b: UsBanking): boolean => l.kind === 'dashboard' && l.role === 'admin' && (b.status === 'not_linked' || b.status === 'pending' || b.status === 'needs_info');

/** Funding needs both approvals: the bank's (approved) and Kesher's review of the institution (money open). */
export const canFund = (b: UsBanking): boolean => b.status === 'approved' && b.moneyOpen;

/** The person who asked cannot approve; only finance staff and admins can. */
export const canApprove = (r: UsFunding, me: string | undefined, role: 'staff' | 'finance' | 'admin'): boolean => r.status === 'awaiting_approval' && (role === 'finance' || role === 'admin') && me !== undefined && r.requestedBy !== me;

/** Cancel until the bank sends: waiting, approved, or an ACH the bank still holds as pending. */
export const canCancel = (r: UsFunding): boolean => r.status === 'awaiting_approval' || r.status === 'approved' || (r.status === 'in_transit' && r.achStatus === 'pending');

export const fundingLine = (r: UsFunding): CopyKey => `usbank.fund.status.${r.status}`;

/** The id a signed access token names (its `sub`), for hiding a person's own request from their approve button. The API enforces it; this is only the screen. */
export function partyIdOf(accessToken: string | undefined): string | undefined {
  try {
    const part = accessToken?.split('.')[1];
    if (!part) return undefined;
    const sub = (JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** The body for the application, or undefined when an own-entity application lacks a legal name or a well-formed EIN. */
export function startBody(holder: 'platform' | 'institution', legalName: string, ein: string): StartInput | undefined {
  if (holder === 'platform') return { holder };
  const name = legalName.trim();
  if (!name || name.length > 200 || !EIN.test(ein.trim())) return undefined;
  return { holder, usEntity: { legalName: name, ein: ein.trim() } };
}

/** The Idempotency-Key a submission goes with: the last attempt's for the same thing that did not land, else new. */
export interface Attempt {
  what: string;
  key: string;
}
export const attemptFor = (last: Attempt | undefined, what: string, newKey: () => string): Attempt => (last && last.what === what ? last : { what, key: newKey() });

export type Problem = { kind: 'invalid' } | { kind: 'cancelled' } | { kind: 'error'; code: string };
export type Step<T> = { outcome: { kind: 'done'; value: T } | Problem; attempt: Attempt | undefined };

export interface UsBankingDeps {
  start(body: StartInput, idempotencyKey: string): Promise<Result<UsBankingLink>>;
  quote(amount: Money): Promise<Result<UsFundingQuote>>;
  request(quoteId: string, idempotencyKey: string): Promise<Result<UsFunding>>;
  approve(requestId: string): Promise<Result<UsFunding>>;
  cancel(requestId: string): Promise<Result<UsFunding>>;
  stepUp(): Promise<boolean>;
  newKey(): string;
}

const failed = <T>(r: { ok: false; code: string }, attempt: Attempt | undefined): Step<T> => ({ outcome: r.code === 'STEP_UP_CANCELLED' ? { kind: 'cancelled' } : { kind: 'error', code: r.code }, attempt });

/** Starts (or resumes) the application with one step-up; the key survives a retry of the same application. */
export async function submitStart(d: UsBankingDeps, input: StartInput | undefined, last: Attempt | undefined): Promise<Step<UsBankingLink>> {
  if (!input) return { outcome: { kind: 'invalid' }, attempt: last };
  const attempt = attemptFor(last, JSON.stringify(input), d.newKey);
  const r = await withStepUp(() => d.start(input, attempt.key), d.stepUp);
  return r.ok ? { outcome: { kind: 'done', value: r.value }, attempt: undefined } : failed(r, attempt);
}

/** A quote for the dollars typed: the amount is parsed to bigint minor units and sent as a string, never a number. */
export async function askQuote(d: UsBankingDeps, amountText: string): Promise<Step<UsFundingQuote>> {
  const minor = parseDollars(amountText);
  if (minor === undefined) return { outcome: { kind: 'invalid' }, attempt: undefined };
  const r = await d.quote({ minor: minor.toString(), currency: 'USD' });
  return r.ok ? { outcome: { kind: 'done', value: r.value }, attempt: undefined } : failed(r, undefined);
}

/** Requests the funding a quote offers, once per quote: a retry after a lost answer is the same request. */
export async function submitRequest(d: UsBankingDeps, quote: UsFundingQuote, last: Attempt | undefined): Promise<Step<UsFunding>> {
  const attempt = attemptFor(last, quote.quoteId, d.newKey);
  const r = await withStepUp(() => d.request(quote.quoteId, attempt.key), d.stepUp);
  return r.ok ? { outcome: { kind: 'done', value: r.value }, attempt: undefined } : failed(r, attempt);
}

export async function submitApprove(d: UsBankingDeps, requestId: string): Promise<Step<UsFunding>> {
  const r = await withStepUp(() => d.approve(requestId), d.stepUp);
  return r.ok ? { outcome: { kind: 'done', value: r.value }, attempt: undefined } : failed(r, undefined);
}

export async function submitCancel(d: UsBankingDeps, requestId: string): Promise<Step<UsFunding>> {
  const r = await withStepUp(() => d.cancel(requestId), d.stepUp);
  return r.ok ? { outcome: { kind: 'done', value: r.value }, attempt: undefined } : failed(r, undefined);
}

/** A refusal as a plain sentence. */
export function errorKey(code: string): CopyKey {
  switch (code) {
    case 'FEATURE_OFF':
      return 'usbank.off';
    case 'QUOTE_EXPIRED':
      return 'usbank.error.quote_expired';
    case 'FORBIDDEN':
    case 'NOT_FOUND':
      return 'error.forbidden';
    case 'VALIDATION_FAILED':
      return 'usbank.error.invalid';
    case 'IDEMPOTENCY_CONFLICT':
      return 'usbank.error.conflict';
    default:
      return 'error.generic';
  }
}
