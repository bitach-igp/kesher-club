// An institution's KYB review in the console (T-0926, REQ-INS-010, REQ-INS-011, ADR-017): what the screens decide,
// apart from rendering. Every reason the API would refuse an approval for is put in words, naming the person
// it is about, before anything is sent; compliance disposes of hits and decides, and a high-risk approval is
// approved by a second compliance member, never its proposer; support reads the page and has no buttons.
import type { AdminActor, KybCheckView, KybDecisionInput, KybStatus, KybView, Risk } from '../data/types.ts';

export type Capability = 'deposits' | 'allowances' | 'credit' | 'payouts';
export const CAPABILITIES: readonly Capability[] = ['deposits', 'allowances', 'credit', 'payouts'];

/** ADR-017's table, as the API's gate holds it (apps/api/src/institutions/kyb-gate.ts). */
export const OPEN: Readonly<Record<KybStatus, readonly Capability[]>> = {
  needs_more_info: [],
  approved_with_limits: ['deposits', 'allowances', 'payouts'],
  approved: ['deposits', 'allowances', 'credit', 'payouts'],
  rejected: [],
};
/** What an open sanctions match suspends on top of the status (T-0624). */
const SUSPENDED_BY_MATCH: readonly Capability[] = ['credit', 'payouts'];

export const STATUS_WORDS: Record<KybStatus, string> = {
  needs_more_info: 'Needs more information',
  approved_with_limits: 'Approved with limits',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** A subject's latest sanctions check that is a hit not yet disposed of, or a true match. */
export const openSanctionsMatches = (k: Pick<KybView, 'checks'>): KybCheckView[] =>
  k.checks.filter((c) => c.kind === 'sanctions' && c.result === 'hit' && (!c.disposition || c.disposition.outcome === 'true_match'));

/** Each capability, open or not, and why: the status, or an open sanctions match. */
export function capabilities(k: Pick<KybView, 'decision' | 'checks'>): { capability: Capability; open: boolean; why?: string }[] {
  const matched = openSanctionsMatches(k).length > 0;
  return CAPABILITIES.map((capability) => {
    if (!OPEN[k.decision.status].includes(capability)) return { capability, open: false, why: `closed while ${STATUS_WORDS[k.decision.status].toLowerCase()}` };
    if (matched && SUSPENDED_BY_MATCH.includes(capability)) return { capability, open: false, why: 'suspended by an open sanctions match' };
    return { capability, open: true };
  });
}

const KIND_WORDS: Record<KybCheckView['kind'], string> = {
  registry: 'register standing',
  identifier: 'registry number and name',
  exempt_status: 'exempt status',
  sanctions: 'sanctions screening',
  pep: 'PEP screening',
};
export const kindWords = (k: KybCheckView['kind']): string => KIND_WORDS[k];

/** Who a check or a code is about: the institution, or the person by name. */
export function subjectOf(k: Pick<KybView, 'people'>, personId: string | undefined): string {
  if (!personId || personId === 'institution') return 'the institution';
  return k.people.find((p) => p.id === personId)?.fullName ?? 'a person no longer in the record';
}

/** One blocking code from the API in words, naming whom it is about. An unknown code is shown as it came. */
export function blockingWords(k: Pick<KybView, 'people' | 'checks'>, code: string): string {
  const [what, ref] = code.split(':', 2) as [string, string | undefined];
  const checkSubject = () => subjectOf(k, k.checks.find((c) => c.id === ref)?.personId);
  switch (what) {
    case 'registry_not_clear':
      return 'The register does not show the institution active and in good standing.';
    case 'identifier_not_clear':
      return 'The registry number was not found, or the register holds another name.';
    case 'exempt_status_not_shown':
      return 'Exempt status is not shown (ניהול תקין in Israel, the IRS listing in the US), and no exception is recorded.';
    case 'sanctions_not_screened':
      return `${capital(subjectOf(k, ref))} has not been screened against the sanctions lists.`;
    case 'pep_not_screened':
      return `${capital(subjectOf(k, ref))} has not been screened for politically exposed persons.`;
    case 'sanctions_hit_undisposed':
      return `A potential sanctions match on ${checkSubject()} waits for compliance to dispose of it.`;
    case 'pep_hit_undisposed':
      return `A potential PEP match on ${checkSubject()} waits for compliance to dispose of it.`;
    case 'sanctions_true_match':
      return `${capital(checkSubject())} is a true sanctions match: the institution cannot be approved.`;
    case 'no_control_person':
      return 'Name at least one control person.';
    case 'control_person_not_t2':
      return `${capital(subjectOf(k, ref))} is a control person without approved T2 KYC.`;
    case 'pep_requires_high_risk':
      return 'A politically exposed person is a true match, so an approval must be rated high risk.';
    default:
      return code;
  }
}
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const isCompliance = (actor: AdminActor): boolean => actor.roles.includes('compliance');

/** A hit is disposed of once, by compliance. */
export const canDispose = (c: KybCheckView, actor: AdminActor): boolean => isCompliance(actor) && c.result === 'hit' && (c.kind === 'sanctions' || c.kind === 'pep') && !c.disposition;

/** The second reviewer of a high-risk approval is compliance, and never its proposer. */
export const canApprove = (k: Pick<KybView, 'pendingApproval'>, actor: AdminActor): boolean => isCompliance(actor) && !!k.pendingApproval && !k.pendingApproval.proposedByMe;

export type DecisionProblem = 'status' | 'risk' | 'reasons';

/** The decide form, checked before the call: an approval names its risk; the other outcomes say why. */
export function parseDecisionForm(f: { status?: string | undefined; risk?: string | undefined; reasons?: string | undefined; key?: string | undefined }): { ok: true; input: KybDecisionInput } | { ok: false; problems: DecisionProblem[] } {
  const problems: DecisionProblem[] = [];
  const status = (Object.keys(STATUS_WORDS) as KybStatus[]).find((s) => s === f.status);
  if (!status) problems.push('status');
  const risk = (['low', 'medium', 'high'] as const).find((r) => r === f.risk);
  const approval = status === 'approved' || status === 'approved_with_limits';
  if (approval && !risk) problems.push('risk');
  const reasons = (f.reasons ?? '').split('\n').map((r) => r.trim().slice(0, 500)).filter(Boolean);
  if (!approval && status && !reasons.length) problems.push('reasons');
  if (problems.length || !status || !f.key) return { ok: false, problems: problems.length ? problems : ['status'] };
  return { ok: true, input: { status, ...(approval && risk ? { risk: risk as Risk } : {}), reasons, key: f.key } };
}

const PROBLEM_WORDS: Record<DecisionProblem, string> = {
  status: 'Choose an outcome.',
  risk: 'An approval names its risk rating: low, medium or high.',
  reasons: 'Needs more information and Rejected say why: one reason per line.',
};
export const decisionProblemWords = (p: DecisionProblem): string => PROBLEM_WORDS[p];
export const decisionProblem = (v: string): DecisionProblem | undefined => (v in PROBLEM_WORDS ? (v as DecisionProblem) : undefined);

/** An API refusal on the KYB page, carried back on the redirect, in words. */
export function kybErrorWords(code: string | undefined): string | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case 'INVALID':
      return 'The record does not support that decision yet: see what is missing above. Nothing was decided.';
    case 'CONFLICT':
      return 'That hit is already disposed of, or the decision was already made. The page shows where it stands.';
    case 'SAME_APPROVER':
      return 'You proposed this high-risk approval, so a different compliance member approves it.';
    case 'FORBIDDEN':
      return 'Only Kesher compliance disposes of hits and decides KYB.';
    case 'NOT_FOUND':
      return 'That institution, check or approval no longer exists.';
    default:
      return 'Something went wrong. Nothing was recorded; try again.';
  }
}
