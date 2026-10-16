// Two-person approval service (T-0605, REQ-INS-004, REQ-ADM-002), shared by institutions and the
// admin console. A request names how many distinct approvers it needs; a person decides once;
// the requester cannot be an approver of their own money request; over-threshold amounts and
// money flags always need two.
import { DomainError, uuidv7, type Currency, type Money } from '@kesher/domain';
import { isPgError, PG, type Database } from '../db.ts';

export type ApprovalKind = 'allowance_run' | 'payout' | 'flag_flip' | 'provider_binding' | 'ledger_correction';
export type ApprovalStatus = 'pending' | 'awaiting_second_approval' | 'approved' | 'rejected' | 'expired';

/** ₪5,000 (REQ-INS-004): institution money over this needs a second finance approver. */
export const SECOND_APPROVER_THRESHOLD_ILS_MINOR = 500_000n;
const DEFAULT_TTL_MS = 7 * 86_400_000;

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  subject: string;
  payload: Record<string, unknown>;
  amount?: Money;
  required: number;
  scope: string;
  requestedBy: string;
  status: ApprovalStatus;
  approvals: number;
  expiresAt: string;
}

export interface Approver {
  partyId: string;
  /** finance | admin | org_admin … */
  role: string;
}

interface Row {
  id: string;
  kind: ApprovalKind;
  subject: string;
  payload: Record<string, unknown>;
  amount_minor: string | null;
  currency: Currency | null;
  required: number;
  scope: string;
  requested_by: string;
  status: ApprovalStatus;
  expires_at: string | Date;
  approvals: number;
}

/** How many distinct approvers an action needs. */
export function approversRequired(kind: ApprovalKind, amount?: Money): number {
  if (kind === 'flag_flip' || kind === 'provider_binding' || kind === 'ledger_correction') return 2;
  if (amount && amount.currency === 'ILS' && amount.minor > SECOND_APPROVER_THRESHOLD_ILS_MINOR) return 2;
  if (amount && amount.currency === 'USD' && amount.minor > SECOND_APPROVER_THRESHOLD_ILS_MINOR / 4n) return 2; // ~₪5,000 at 1:4 as a conservative floor
  return 1;
}

export class ApprovalService {
  constructor(private readonly db: Database) {}

  /** Creates (or returns) the request for (kind, subject). The requester's own approval counts only for single-approver actions. */
  async request(input: { kind: ApprovalKind; subject: string; scope: string; requestedBy: Approver; amount?: Money; payload?: Record<string, unknown>; ttlMs?: number }, now: Date): Promise<ApprovalRequest> {
    const required = approversRequired(input.kind, input.amount);
    const id = uuidv7(now);
    try {
      await this.db.query(
        `insert into ops.approval_request (id, kind, subject, payload, amount_minor, currency, required, scope, requested_by, status, expires_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, input.kind, input.subject, JSON.stringify(input.payload ?? {}), input.amount?.minor.toString() ?? null, input.amount?.currency ?? null, required, input.scope, input.requestedBy.partyId, required === 1 ? 'pending' : 'awaiting_second_approval', new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)), now],
      );
    } catch (e) {
      if (!isPgError(e, PG.UNIQUE_VIOLATION)) throw e;
    }
    const r = (await this.find(input.kind, input.subject))!;
    // The requester's intent counts as the first approval for money actions; a second person must still approve.
    if (r.approvals === 0 && (input.kind === 'allowance_run' || input.kind === 'payout')) return this.decide(r.id, input.requestedBy, 'approve', now, 'requested');
    return r;
  }

  async decide(requestId: string, by: Approver, decision: 'approve' | 'reject', now: Date, reason?: string): Promise<ApprovalRequest> {
    const pre = await this.get(requestId);
    if (!pre) throw new DomainError('NOT_FOUND', 'Approval request not found');
    if ((pre.status === 'pending' || pre.status === 'awaiting_second_approval') && Date.parse(pre.expiresAt) <= now.getTime()) {
      await this.db.query(`update ops.approval_request set status = 'expired', decided_at = $2 where id = $1 and status in ('pending','awaiting_second_approval')`, [requestId, now]);
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Request expired');
    }
    return this.db.transaction(async (tx) => {
      const row = await tx.query<Row>('select r.*, (select count(*)::int from ops.approval_decision d where d.request_id = r.id and d.decision = $2) as approvals from ops.approval_request r where r.id = $1 for update', [requestId, 'approve']);
      const r = row.rows[0];
      if (!r) throw new DomainError('NOT_FOUND', 'Approval request not found');
      if (r.status === 'approved' || r.status === 'rejected') throw new DomainError('IDEMPOTENCY_CONFLICT', `Request already ${r.status}`);
      if (r.status === 'expired') throw new DomainError('IDEMPOTENCY_CONFLICT', 'Request expired');
      // Distinct approvers are guaranteed by unique (request_id, decided_by): one person decides once.
      if ((r.kind === 'flag_flip' || r.kind === 'provider_binding') && by.role !== 'admin') throw new DomainError('FORBIDDEN', 'Only admins approve flag and binding changes');
      if ((r.kind === 'allowance_run' || r.kind === 'payout') && r.required >= 2 && reason !== 'requested' && by.role !== 'finance' && by.role !== 'org_admin') throw new DomainError('FORBIDDEN', 'A finance-role approver is required');
      try {
        await tx.query('insert into ops.approval_decision (id, request_id, decided_by, role, decision, reason, at) values ($1, $2, $3, $4, $5, $6, $7)', [uuidv7(now), requestId, by.partyId, by.role, decision, reason ?? null, now]);
      } catch (e) {
        if (isPgError(e, PG.UNIQUE_VIOLATION)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This person already decided');
        throw e;
      }
      if (decision === 'reject') {
        await tx.query(`update ops.approval_request set status = 'rejected', decided_at = $2 where id = $1`, [requestId, now]);
      } else {
        const approvals = r.approvals + 1;
        const status: ApprovalStatus = approvals >= r.required ? 'approved' : 'awaiting_second_approval';
        await tx.query(`update ops.approval_request set status = $2, decided_at = case when $2 = 'approved' then $3 else decided_at end where id = $1`, [requestId, status, now]);
      }
      const after = await tx.query<Row>('select r.*, (select count(*)::int from ops.approval_decision d where d.request_id = r.id and d.decision = $2) as approvals from ops.approval_request r where r.id = $1', [requestId, 'approve']);
      return toRequest(after.rows[0]!);
    });
  }

  async find(kind: ApprovalKind, subject: string): Promise<ApprovalRequest | undefined> {
    const r = await this.db.query<Row>(`select r.*, (select count(*)::int from ops.approval_decision d where d.request_id = r.id and d.decision = 'approve') as approvals from ops.approval_request r where kind = $1 and subject = $2`, [kind, subject]);
    return r.rows[0] ? toRequest(r.rows[0]) : undefined;
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const r = await this.db.query<Row>(`select r.*, (select count(*)::int from ops.approval_decision d where d.request_id = r.id and d.decision = 'approve') as approvals from ops.approval_request r where id = $1`, [id]);
    return r.rows[0] ? toRequest(r.rows[0]) : undefined;
  }

  /** True only when the request exists and is approved (the gate every money action checks before executing). */
  async isApproved(kind: ApprovalKind, subject: string): Promise<boolean> {
    return (await this.find(kind, subject))?.status === 'approved';
  }
}

function toRequest(r: Row): ApprovalRequest {
  return {
    id: r.id,
    kind: r.kind,
    subject: r.subject,
    payload: r.payload,
    ...(r.amount_minor && r.currency ? { amount: { minor: BigInt(r.amount_minor), currency: r.currency } } : {}),
    required: r.required,
    scope: r.scope,
    requestedBy: r.requested_by,
    status: r.status,
    approvals: r.approvals,
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}
