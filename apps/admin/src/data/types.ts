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
