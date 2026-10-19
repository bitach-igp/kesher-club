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
  kyc: { status: 'none' | 'pending' | 'verified' | 'rejected'; provider?: string | undefined; checkedAt?: string | undefined };
  memberships: { id: string; planCode: string; status: 'incomplete' | 'active' | 'past_due' | 'paused' | 'cancelled'; funderName?: string | undefined; institutionName?: string | undefined; currentPeriodEnd?: string | undefined }[];
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

  auditLog(): Promise<{ at: string; actor: string; action: string; subject: string; detail?: string | undefined }[]>;
}

export class AdminDataError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'GATES_INCOMPLETE' | 'SAME_APPROVER' | 'UNAVAILABLE';
  constructor(
    code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'GATES_INCOMPLETE' | 'SAME_APPROVER' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'AdminDataError';
  }
}
