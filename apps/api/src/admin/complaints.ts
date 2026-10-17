// Complaints (T-0908, REQ-CMP-002): the register the bank audits. Staff log a complaint on a
// member's behalf (phone, email, bank, regulator) or the app files one; acknowledging and resolving
// stamp the acting staff subject and the API clock, so the SLA clocks (console, sla.ts) read the same
// timestamps the export carries. The summary is member text: stored and returned, never interpreted.
import { DomainError, uuidv7 } from '@kesher/domain';
import type { AuditService } from '../audit/service.ts';
import type { Database, SqlClient } from '../db.ts';

/** The audit service wants a Database; inside a transaction the client is the transaction. */
const inTx = (tx: SqlClient): Database => ({ query: tx.query, transaction: async (fn) => fn(tx) });

export const COMPLAINT_CHANNELS = ['app', 'email', 'phone', 'bank', 'regulator'] as const;
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number];
export type ComplaintStatus = 'open' | 'acknowledged' | 'resolved' | 'withdrawn';

export interface Complaint {
  id: string;
  partyId: string;
  channel: ComplaintChannel;
  category: string;
  /** Member text: untrusted. */
  summary: string;
  status: ComplaintStatus;
  openedAt: string;
  loggedBy: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  owner?: string;
  escalatedToBank: boolean;
}

export interface OpenComplaintInput {
  partyId: string;
  channel: ComplaintChannel;
  category: string;
  summary: string;
  escalatedToBank?: boolean;
  /** When the complaint reached us; defaults to now. Phone and letter complaints are often logged later. */
  openedAt?: Date;
}

/** Who is acting: the staff SSO subject (the string the console shows as owner) and their audit identity. */
export interface StaffActor {
  subject: string;
  partyId: string;
  role: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUMMARY = 2000;
const MAX_CATEGORY = 80;

interface Row {
  id: string;
  party_id: string;
  channel: ComplaintChannel;
  category: string;
  summary: string;
  status: ComplaintStatus;
  opened_at: string | Date;
  logged_by: string;
  acknowledged_at: string | Date | null;
  acknowledged_by: string | null;
  resolved_at: string | Date | null;
  resolved_by: string | null;
  owner: string | null;
  escalated_to_bank: boolean;
}

const iso = (v: string | Date): string => new Date(v).toISOString();

const toComplaint = (r: Row): Complaint => ({
  id: r.id,
  partyId: r.party_id,
  channel: r.channel,
  category: r.category,
  summary: r.summary,
  status: r.status,
  openedAt: iso(r.opened_at),
  loggedBy: r.logged_by,
  ...(r.acknowledged_at ? { acknowledgedAt: iso(r.acknowledged_at) } : {}),
  ...(r.acknowledged_by ? { acknowledgedBy: r.acknowledged_by } : {}),
  ...(r.resolved_at ? { resolvedAt: iso(r.resolved_at) } : {}),
  ...(r.resolved_by ? { resolvedBy: r.resolved_by } : {}),
  ...(r.owner ? { owner: r.owner } : {}),
  escalatedToBank: r.escalated_to_bank,
});

export class ComplaintService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Every complaint, open ones first by age, then closed ones newest first. This is also the export. */
  async list(): Promise<Complaint[]> {
    const r = await this.db.query<Row>(`select * from ops.complaint order by (status in ('open', 'acknowledged')) desc, case when status in ('open', 'acknowledged') then opened_at end asc, opened_at desc`);
    return r.rows.map(toComplaint);
  }

  async get(id: string): Promise<Complaint | undefined> {
    const r = await this.db.query<Row>(`select * from ops.complaint where id = $1`, [id]);
    return r.rows[0] ? toComplaint(r.rows[0]) : undefined;
  }

  async open(input: OpenComplaintInput, by: StaffActor, now: Date): Promise<Complaint> {
    if (!UUID.test(input.partyId)) throw new DomainError('VALIDATION_FAILED', 'partyId must be a uuid');
    if (!COMPLAINT_CHANNELS.includes(input.channel)) throw new DomainError('VALIDATION_FAILED', `channel must be one of ${COMPLAINT_CHANNELS.join(', ')}`);
    const category = input.category.trim();
    const summary = input.summary.trim();
    if (!category || category.length > MAX_CATEGORY) throw new DomainError('VALIDATION_FAILED', `category must be 1 to ${MAX_CATEGORY} characters`);
    if (!summary || summary.length > MAX_SUMMARY) throw new DomainError('VALIDATION_FAILED', `summary must be 1 to ${MAX_SUMMARY} characters`);
    const openedAt = input.openedAt ?? now;
    if (openedAt.getTime() > now.getTime()) throw new DomainError('VALIDATION_FAILED', 'openedAt cannot be in the future');
    const id = uuidv7(now);
    return this.db.transaction(async (tx) => {
      const r = await tx.query<Row>(
        `insert into ops.complaint (id, party_id, channel, category, summary, status, opened_at, logged_by, escalated_to_bank, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $9) returning *`,
        [id, input.partyId.toLowerCase(), input.channel, category, summary, openedAt, by.subject, input.escalatedToBank ?? false, now],
      );
      // Audit is person-scoped (the Customer 360 tail reads subject = party id); the member's text stays out of the chain.
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'complaint.opened', subject: input.partyId.toLowerCase(), reason: `${input.channel} complaint logged by ${by.subject}`, payload: { complaintId: id, channel: input.channel, category } }, now, inTx(tx));
      return toComplaint(r.rows[0]!);
    });
  }

  async acknowledge(id: string, by: StaffActor, now: Date): Promise<Complaint> {
    const c = await this.get(id);
    if (!c) throw new DomainError('NOT_FOUND', 'Complaint not found');
    if (c.status !== 'open') throw new DomainError('IDEMPOTENCY_CONFLICT', 'Complaint is not open');
    return this.db.transaction(async (tx) => {
      const r = await tx.query<Row>(
        `update ops.complaint set status = 'acknowledged', acknowledged_at = $2, acknowledged_by = $3, owner = coalesce(owner, $3), updated_at = $2 where id = $1 and status = 'open' returning *`,
        [id, now, by.subject],
      );
      if (!r.rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Complaint is not open');
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'complaint.acknowledged', subject: c.partyId, reason: `acknowledged by ${by.subject}`, payload: { complaintId: id } }, now, inTx(tx));
      return toComplaint(r.rows[0]);
    });
  }

  /** Resolving an open complaint acknowledges it in the same stroke; the bank sees both stamps. */
  async resolve(id: string, by: StaffActor, now: Date): Promise<Complaint> {
    const c = await this.get(id);
    if (!c) throw new DomainError('NOT_FOUND', 'Complaint not found');
    if (c.status === 'resolved' || c.status === 'withdrawn') throw new DomainError('IDEMPOTENCY_CONFLICT', 'Complaint already closed');
    return this.db.transaction(async (tx) => {
      const r = await tx.query<Row>(
        `update ops.complaint set status = 'resolved', resolved_at = $2, resolved_by = $3, acknowledged_at = coalesce(acknowledged_at, $2), acknowledged_by = coalesce(acknowledged_by, $3), owner = coalesce(owner, $3), updated_at = $2
          where id = $1 and status in ('open', 'acknowledged') returning *`,
        [id, now, by.subject],
      );
      if (!r.rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Complaint already closed');
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'complaint.resolved', subject: c.partyId, reason: `resolved by ${by.subject}`, payload: { complaintId: id } }, now, inTx(tx));
      return toComplaint(r.rows[0]);
    });
  }
}
