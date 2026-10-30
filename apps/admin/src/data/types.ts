// What the admin screens read and write, as a port. The day-one binding is the seeded in-memory
// store (src/data/memory.ts); the API-backed binding lands with the admin endpoints (ADR pending).
// Everything that came from members, merchants or partners is text: rendered, never interpreted.
import type { Market } from '@kesher/ports';
import type { Money } from '@kesher/domain';

export interface CustomerSummary {
  partyId: string;
  displayName: string;
  /** E.164; screens mask it. */
  phone: string;
  email?: string | undefined;
  locale: 'en' | 'he';
  mode: 'member' | 'funder' | 'both';
  createdAt: string;
}

export interface CustomerRecord extends CustomerSummary {
  kyc: { status: 'none' | 'pending' | 'verified' | 'rejected'; tier?: 'T1' | 'T2' | undefined; provider?: string | undefined; checkedAt?: string | undefined };
  memberships: { id: string; planCode: string; status: 'incomplete' | 'active' | 'past_due' | 'paused' | 'cancelled'; funderName?: string | undefined; institutionName?: string | undefined; currentPeriodEnd?: string | undefined }[];
  /** `available` is what the member can spend now, as their Home shows it; `holds` are not in it (ACH, P2P holds). */
  accounts: { id: string; currency: 'USD' | 'ILS'; available: Money; holds: Money }[];
  cards: { id: string; last4: string; type: 'virtual' | 'physical'; status: 'inactive' | 'active' | 'frozen' | 'closed'; tokens: number }[];
  cases: { id: string; kind: string; severity: 'low' | 'medium' | 'high' | 'critical'; status: 'open' | 'investigating' | 'resolved' | 'dismissed'; openedAt: string }[];
  consents: { document: string; version: string; acceptedAt: string }[];
  grants: { id: string; clientName: string; scopes: string[]; lastUsedAt?: string | undefined; revokedAt?: string | undefined }[];
  audit: { at: string; actor: string; action: string; detail?: string | undefined }[];
  restrictedUntil?: string | undefined;
}

export type AlertKind = 'structuring' | 'sanctions_hit' | 'kyc_manual_review' | 'velocity' | 'recon_break';
export type AlertStatus = 'open' | 'in_review' | 'cleared' | 'escalated';
export interface Alert {
  id: string;
  kind: AlertKind;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: AlertStatus;
  partyId?: string | undefined;
  summary: string;
  openedAt: string;
  decidedBy?: string | undefined;
  decidedAt?: string | undefined;
  note?: string | undefined;
}

export type ComplaintChannel = 'app' | 'email' | 'phone' | 'bank' | 'regulator';
export type ComplaintStatus = 'open' | 'acknowledged' | 'resolved' | 'withdrawn';
export interface Complaint {
  id: string;
  partyId: string;
  channel: ComplaintChannel;
  category: string;
  /** Member text: untrusted. */
  summary: string;
  openedAt: string;
  acknowledgedAt?: string | undefined;
  resolvedAt?: string | undefined;
  status: ComplaintStatus;
  owner?: string | undefined;
  escalatedToBank?: boolean | undefined;
}

export interface ProviderBinding {
  capability: string;
  /** Bindings are per market: each market's API serves its own providers (T-0913). */
  market: Market;
  /** Which adapter serves the port right now. */
  binding: 'simulator' | string;
  degraded: boolean;
  lastContractRunAt?: string | undefined;
  contractGreenNights: number;
}

export interface FlagState {
  key: string;
  on: boolean;
  /** Gate ids ticked (src/providers/release-gates.ts). */
  gatesTicked: string[];
  pendingFlip?: { requestId: string; to: boolean; requestedBy: string; approvals: string[]; requestedAt: string } | undefined;
  lastChangedAt?: string | undefined;
  lastChangedBy?: string | undefined;
}

export type DepositRail = 'masav' | 'wire' | 'ach';

/** An institution as the console lists it (T-0924, T-0615). */
export interface InstitutionRow {
  id: string;
  name: string;
  market: Market;
  activeStaff: number;
  createdAt: string;
}

/** A recorded bank transfer in (T-0614): pending until a second finance member approves it. */
export interface Deposit {
  id: string;
  amount: Money;
  rail: DepositRail;
  bankReference: string;
  valueDate: string;
  /** Staff text. */
  note?: string | undefined;
  status: 'pending' | 'posted' | 'rejected';
  approvals: number;
  /** True for the finance member who recorded it: they cannot be its second approver. */
  recordedByMe: boolean;
  createdAt: string;
  decidedAt?: string | undefined;
}

export interface InstitutionDetail extends InstitutionRow {
  /** What the institution quotes on its transfers; absent while deposits are switched off. */
  paymentReference?: string | undefined;
  balances: Money[];
  deposits: Deposit[];
  /** `institutions.deposits` is off: there is nothing to record yet. */
  depositsOff: boolean;
  staff: { partyId: string; role: 'staff' | 'finance' | 'admin'; active: boolean; phoneMasked?: string | undefined }[];
  /** Finance or admin grants waiting for a second admin (T-0924). */
  pendingGrants: number;
}

export interface DepositInput {
  amount: Money;
  rail: DepositRail;
  bankReference: string;
  valueDate: string;
  note?: string | undefined;
  /** The form's attempt key: a double submit records once. */
  key: string;
  /** Recorded from this suspense case (T-0631): the fields are the case's credit, and the case closes when it posts. */
  caseId?: string | undefined;
}

/** The ops queue (A12, T-0930/T-0931): every ops case that is not a compliance alert. */
export type OpsCaseKind = 'suspense' | 'deposit_not_on_statement' | 'payout_account_mismatch' | 'balance_break' | 'system_total_break' | 'unbalanced_journal';
export type OpsCaseStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';
export interface OpsCase {
  id: string;
  kind: OpsCaseKind;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: OpsCaseStatus;
  /** Built from the payload's own fields by the API. */
  summary: string;
  /** What opened the case, as the job wrote it; may quote a remitter's text, which is data. */
  payload: Record<string, unknown>;
  openedAt: string;
  assignedTo?: string | undefined;
  assignedAt?: string | undefined;
  decidedBy?: string | undefined;
  decidedAt?: string | undefined;
  note?: string | undefined;
}
export interface OpsCaseFilter {
  kind?: OpsCaseKind | undefined;
  status?: OpsCaseStatus | undefined;
  /** Only the cases assigned to the acting admin. */
  mine?: boolean | undefined;
}

export type KybStatus = 'needs_more_info' | 'approved_with_limits' | 'approved' | 'rejected';
export type Risk = 'low' | 'medium' | 'high';

/** One check in an institution's KYB record (T-0619): the latest of each kind for the institution and each person. */
export interface KybCheckView {
  id: string;
  kind: 'registry' | 'identifier' | 'exempt_status' | 'sanctions' | 'pep';
  /** Absent for a check on the institution itself. */
  personId?: string | undefined;
  result: 'clear' | 'hit' | 'missing' | 'excepted';
  provider: string;
  /** Where the evidence is kept; never the evidence itself. */
  evidenceRef?: string | undefined;
  checkedAt: string;
  disposition?: { outcome: 'false_positive' | 'true_match'; note: string; decidedBy: string; decidedAt: string } | undefined;
}

/** An institution's KYB record as compliance reviews it (T-0926). */
export interface KybView {
  decision: { status: KybStatus; risk?: Risk | undefined; reasons: string[]; decidedAt?: string | undefined };
  /** Staff-entered names: shown as text. */
  people: { id: string; fullName: string; roles: ('board' | 'control' | 'signatory')[]; kycTier?: 'T1' | 'T2' | undefined }[];
  checks: KybCheckView[];
  /** The API's codes for what an approval would be refused for today; the screen puts them in words. */
  blocking: string[];
  /** A high-risk approval waiting for a second compliance member. */
  pendingApproval?: { id: string; status: string; outcome: KybStatus; risk?: Risk | undefined; proposedByMe: boolean } | undefined;
}

export interface KybDecisionInput {
  status: KybStatus;
  risk?: Risk | undefined;
  reasons: string[];
  /** The form's attempt key: a double submit decides once. */
  key: string;
}

/** An add-on price rule (A05, T-0929): price = max(floor, cost × (1 + margin)), rounded up to .99 when asked. */
export type PriceRuleKind = 'esim' | 'insurance' | 'concierge';
export interface PriceRuleRow {
  id: string;
  kind: PriceRuleKind;
  provider: string;
  skuPattern: string;
  marginBps: number;
  floor: Money;
  roundTo99: boolean;
  priority: number;
  state: 'proposed' | 'active' | 'rejected';
  /** The proposer's staff subject: they are never offered Approve or Reject on their own rule. */
  proposedBy?: string | undefined;
  /** Staff-entered text. */
  reason?: string | undefined;
  createdAt: string;
  activatedAt?: string | undefined;
}

export interface PriceRuleInput {
  kind: PriceRuleKind;
  provider: string;
  skuPattern: string;
  marginBps: number;
  floor: Money;
  roundTo99: boolean;
  priority: number;
  reason: string;
}

export interface AdminActor {
  subject: string;
  roles: readonly string[];
}

export interface AdminData {
  searchCustomers(query: string): Promise<CustomerSummary[]>;
  getCustomer(partyId: string): Promise<CustomerRecord | undefined>;

  listAlerts(): Promise<Alert[]>;
  decideAlert(id: string, decision: 'cleared' | 'escalated' | 'in_review', by: AdminActor, note: string, now: Date): Promise<Alert>;

  listComplaints(): Promise<Complaint[]>;
  acknowledgeComplaint(id: string, by: AdminActor, now: Date): Promise<Complaint>;
  resolveComplaint(id: string, by: AdminActor, now: Date): Promise<Complaint>;

  listBindings(): Promise<ProviderBinding[]>;
  listFlags(): Promise<FlagState[]>;
  getFlag(key: string): Promise<FlagState | undefined>;
  tickGate(key: string, gateId: string, ticked: boolean, by: AdminActor, now: Date): Promise<FlagState>;
  /** First admin proposes; second approves; the flip applies on the second approval (two-person rule). */
  proposeFlip(key: string, to: boolean, by: AdminActor, now: Date): Promise<FlagState>;
  approveFlip(key: string, by: AdminActor, now: Date): Promise<FlagState>;
  /** Kill switch: off now, one person, audited. Turning on always goes through the approval path. */
  killSwitch(key: string, by: AdminActor, now: Date): Promise<FlagState>;

  listInstitutions(): Promise<InstitutionRow[]>;
  /** `by` decides `recordedByMe` on each deposit. */
  getInstitution(id: string, by: AdminActor): Promise<InstitutionDetail | undefined>;
  /** Kesher finance records a statement line; it is the first of two approvals (REQ-INS-007). */
  recordDeposit(institutionId: string, input: DepositInput, by: AdminActor, now: Date): Promise<Deposit>;
  /** A different finance member approves (it posts) or rejects (with a reason). */
  decideDeposit(id: string, decision: 'approve' | 'reject', by: AdminActor, reason: string | undefined, now: Date): Promise<Deposit>;

  /** A12 (T-0931): the ops queue, newest first, as filtered; `by` answers "mine". */
  listOpsCases(filter: OpsCaseFilter, by: AdminActor): Promise<OpsCase[]>;
  getOpsCase(id: string): Promise<OpsCase | undefined>;
  /** Ops or finance take a case; it moves to investigating. */
  assignOpsCase(id: string, by: AdminActor, now: Date): Promise<OpsCase>;
  /** Resolved or dismissed with a note, final. A suspense credit resolves only through its deposit (T-0631). */
  decideOpsCase(id: string, decision: 'resolved' | 'dismissed', note: string, by: AdminActor, now: Date): Promise<OpsCase>;

  /** An institution's KYB record (T-0926); `by` decides whether they proposed the pending high-risk approval. */
  getKyb(institutionId: string, by: AdminActor): Promise<KybView | undefined>;
  /** Compliance disposes of a screening hit once, as a false positive or a true match, with a note. */
  disposeKybCheck(checkId: string, outcome: 'false_positive' | 'true_match', note: string, by: AdminActor, now: Date): Promise<void>;
  /** Compliance decides; a high-risk approval waits for a second compliance member instead. */
  decideKyb(institutionId: string, input: KybDecisionInput, by: AdminActor, now: Date): Promise<'decided' | 'awaiting_second_approval'>;
  /** A different compliance member approves a high-risk approval. */
  approveKybDecision(approvalId: string, by: AdminActor, now: Date): Promise<void>;

  /** A05 (T-0929): the add-on price rules, newest first. */
  listPriceRules(): Promise<PriceRuleRow[]>;
  /** Kesher finance proposes; the proposer is the first of two approvers and the rule waits inactive. */
  proposePriceRule(input: PriceRuleInput, by: AdminActor, now: Date): Promise<PriceRuleRow>;
  /** A different finance member approves (the rule becomes active) or either rejects it with a reason. */
  decidePriceRule(id: string, decision: 'approve' | 'reject', by: AdminActor, reason: string | undefined, now: Date): Promise<PriceRuleRow>;

  auditLog(): Promise<{ at: string; actor: string; action: string; subject: string; detail?: string | undefined }[]>;
}

export class AdminDataError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'GATES_INCOMPLETE' | 'SAME_APPROVER' | 'UNAVAILABLE' | 'INVALID';
  constructor(
    code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'GATES_INCOMPLETE' | 'SAME_APPROVER' | 'UNAVAILABLE' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'AdminDataError';
  }
}
