// Release gates (Tab 3 §11, T-0902): the Providers & Flags screen tracks these; all must be ticked
// before a flag goes to 100%, and two admins must approve the flip. Money flags carry two extra
// requirements: the external pentest closed and bank-approved disclosures.
import { isMoneyFlag } from './money-flags.ts';

export interface ReleaseGate {
  id: string;
  label: string;
  /** How the gate is proven; the screen shows this next to the checkbox. */
  evidence: string;
}

const COMMON: readonly ReleaseGate[] = [
  { id: 'tests', label: 'All REQs behind the flag have passing primary tests', evidence: 'trace-check green on main' },
  { id: 'contract7', label: 'Contract suite green against the live/sandbox adapter for 7 consecutive nights', evidence: 'nightly contract job' },
  { id: 'security', label: 'Security: Semgrep and ZAP clean', evidence: 'CI security job' },
  { id: 'disclosures', label: 'Disclosures for the feature are approved', evidence: 'CMS entry approved' },
  { id: 'runbook', label: 'Runbook exists, is linked from its alerts, and an on-call dry run is done', evidence: 'docs/runbooks + dry-run note' },
  { id: 'analytics', label: 'Analytics events verified in staging', evidence: 'staging event check' },
  { id: 'staff7', label: 'Internal cohort (staff) live for 7 days with no Sev-2 or worse', evidence: 'incident log' },
  { id: 'pilot14', label: 'Pilot institution live for 14 days; support tickets reviewed', evidence: 'pilot review note' },
];

const MONEY_EXTRA: readonly ReleaseGate[] = [
  { id: 'pentest', label: 'External pentest findings closed', evidence: 'pentest report sign-off' },
  { id: 'bankDisclosures', label: 'Disclosures bank-approved (anything that mentions money)', evidence: 'bank approval on the CMS entry' },
];

export const APPROVALS_REQUIRED = 2;

/** Gates that apply to a flag. The last gate (two admins approve) is enforced by the approval flow, not a tick. */
export function gatesFor(flagKey: string): readonly ReleaseGate[] {
  return isMoneyFlag(flagKey) ? [...COMMON, ...MONEY_EXTRA] : COMMON;
}

export interface FlipEvaluation {
  gatesComplete: boolean;
  missing: string[];
  approvals: number;
  approvalsRequired: number;
  ready: boolean;
}

/** Turning a flag ON needs every gate ticked and two distinct approvers. Turning OFF never waits on gates. */
export function evaluateFlip(flagKey: string, ticked: readonly string[], approvers: readonly string[], to = true): FlipEvaluation {
  const distinct = new Set(approvers).size;
  if (!to) return { gatesComplete: true, missing: [], approvals: distinct, approvalsRequired: APPROVALS_REQUIRED, ready: distinct >= APPROVALS_REQUIRED };
  const missing = gatesFor(flagKey).filter((g) => !ticked.includes(g.id)).map((g) => g.id);
  return { gatesComplete: missing.length === 0, missing, approvals: distinct, approvalsRequired: APPROVALS_REQUIRED, ready: missing.length === 0 && distinct >= APPROVALS_REQUIRED };
}
