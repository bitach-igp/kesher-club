// A ledger correction (T-0685, REQ-LED-001, REQ-ADM-002): finance proposes reversing one journal, two OTHER finance
// users approve it (the proposer's own approval never counts), and the second approval posts ONE reversing journal under
// the key `{approvalId}:reverse`. The ledger stays insert-only: the reversal is a new journal linked by reverses_id.
import { DomainError, type Currency } from '@kesher/domain';
import { requireStaff } from '../admin/staff-token.ts';
import type { AuditService } from '../audit/service.ts';
import type { Database } from '../db.ts';
import { created, ok, requireIdempotencyKey, route, type Handler, type HttpRequest } from '../http.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { ApprovalRequest, ApprovalService, Approver } from './service.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const subjectOf = (key: string) => `ledger-correction:${key}`;
const reverseKey = (approvalId: string) => `${approvalId}:reverse`;

export interface LedgerCorrection {
  id: string;
  journalId: string;
  reason: string;
  status: ApprovalRequest['status'];
  approvals: number;
  required: number;
  requestedBy: string;
  expiresAt: string;
  /** The reversing journal, once the second approval has executed it. */
  reversal?: { journalId: string; effectiveAt: string; totals: { currency: Currency; minor: bigint }[] };
}

export class LedgerCorrections {
  private readonly db: Database;
  private readonly approvals: ApprovalService;
  private readonly ledger: PostgresLedger;
  private readonly audit: AuditService;
  constructor(db: Database, approvals: ApprovalService, ledger: PostgresLedger, audit: AuditService) {
    this.db = db;
    this.approvals = approvals;
    this.ledger = ledger;
    this.audit = audit;
  }

  /** Finance proposes the reversal of one journal. Idempotent per key: a replay returns the same request. */
  async propose(input: { journalId: string; reason: string; idempotencyKey: string }, by: Approver, now: Date): Promise<LedgerCorrection> {
    if (by.role !== 'finance') throw new DomainError('FORBIDDEN', 'Only finance proposes ledger corrections');
    const reason = input.reason.trim();
    if (!reason) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
    if (!UUID.test(input.journalId)) throw new DomainError('VALIDATION_FAILED', 'journalId must be a journal id');
    const subject = subjectOf(input.idempotencyKey);
    const prior = await this.approvals.find('ledger_correction', subject);
    if (prior) {
      if ((prior.payload as { journalId?: string }).journalId !== input.journalId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for another correction');
      return this.view(prior);
    }
    const j = await this.db.query<{ id: string }>('select id from ledger.journal where id = $1', [input.journalId]);
    if (j.rowCount === 0) throw new DomainError('NOT_FOUND', 'Journal not found');
    const reversed = await this.db.query<{ id: string }>('select id from ledger.journal where reverses_id = $1', [input.journalId]);
    if (reversed.rowCount && reversed.rowCount > 0) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Journal already reversed');
    const req = await this.approvals.request({ kind: 'ledger_correction', subject, scope: 'platform', requestedBy: by, payload: { journalId: input.journalId, reason } }, now);
    return this.view(req);
  }

  /** A distinct finance approval. The approval that completes the set executes the reversal. */
  async approve(approvalId: string, by: Approver, now: Date): Promise<LedgerCorrection> {
    const req = await this.mine(approvalId);
    if (req.status === 'approved') {
      // Already approved: a retry after a crash between the decision and the reversal finishes the work; nobody decides twice.
      if (by.role !== 'finance' || by.partyId === req.requestedBy) throw new DomainError('FORBIDDEN', 'Only a finance user other than the proposer can complete this correction');
      await this.execute(req, by, now);
      return this.view(req);
    }
    const after = await this.approvals.decide(approvalId, by, 'approve', now);
    if (after.status === 'approved') await this.execute(after, by, now);
    return this.view(after);
  }

  /** Rejecting (the proposer withdrawing, or another finance user refusing) ends the request and executes nothing. */
  async reject(approvalId: string, by: Approver, reason: string, now: Date): Promise<LedgerCorrection> {
    if (by.role !== 'finance') throw new DomainError('FORBIDDEN', 'Only finance decides ledger corrections');
    if (!reason.trim()) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
    await this.mine(approvalId);
    return this.view(await this.approvals.decide(approvalId, by, 'reject', now, reason.trim()));
  }

  async get(approvalId: string): Promise<LedgerCorrection> {
    return this.view(await this.mine(approvalId));
  }

  private async mine(id: string): Promise<ApprovalRequest> {
    const req = UUID.test(id) ? await this.approvals.get(id) : undefined;
    if (!req || req.kind !== 'ledger_correction') throw new DomainError('NOT_FOUND', 'Ledger correction not found');
    return req;
  }

  /** Posts the reversal exactly once: the key is the approval's, so a replay finds its own journal and writes no second audit entry. */
  private async execute(req: ApprovalRequest, by: Approver, now: Date): Promise<void> {
    const { journalId, reason } = req.payload as { journalId: string; reason: string };
    const key = reverseKey(req.id);
    const existing = await this.db.query<{ id: string }>('select id from ledger.journal where idempotency_key = $1', [key]);
    if (existing.rowCount && existing.rowCount > 0) return;
    const reversal = await this.ledger.reverse(journalId, key, { effectiveAt: now });
    await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'ledger_correction.execute', subject: `journal:${journalId}`, reason, before: { journalId, reversed: false }, after: { journalId, reversed: true, reversalJournalId: reversal.id }, payload: { approvalId: req.id, journalId, reversalJournalId: reversal.id, requestedBy: req.requestedBy } }, now);
  }

  private async view(req: ApprovalRequest): Promise<LedgerCorrection> {
    const { journalId, reason } = req.payload as { journalId: string; reason: string };
    const fresh = (await this.approvals.get(req.id)) ?? req;
    const rev = await this.db.query<{ id: string; effective_at: string | Date }>('select id, effective_at from ledger.journal where idempotency_key = $1', [reverseKey(req.id)]);
    let reversal: LedgerCorrection['reversal'];
    if (rev.rows[0]) {
      const t = await this.db.query<{ currency: Currency; minor: string }>('select currency, sum(amount_minor)::text as minor from ledger.posting where journal_id = $1 group by currency order by currency', [rev.rows[0].id]);
      reversal = { journalId: rev.rows[0].id, effectiveAt: new Date(rev.rows[0].effective_at).toISOString(), totals: t.rows.map((x) => ({ currency: x.currency, minor: BigInt(x.minor) })) };
    }
    return { id: fresh.id, journalId, reason, status: fresh.status, approvals: fresh.approvals, required: fresh.required, requestedBy: fresh.requestedBy, expiresAt: fresh.expiresAt, ...(reversal ? { reversal } : {}) };
  }
}

/** The OpenAPI `LedgerCorrection`: bigint sums travel as decimal strings. */
export const correctionBody = (c: LedgerCorrection) => ({ ...c, ...(c.reversal ? { reversal: { ...c.reversal, totals: c.reversal.totals.map((t) => ({ currency: t.currency, minor: t.minor.toString() })) } } : {}) });

const financeActor = (req: HttpRequest) => {
  const p = requireStaff(req, 'finance');
  return { partyId: p.partyId, role: 'finance' };
};

export function ledgerCorrectionHandlers(svc: LedgerCorrections): Record<string, Handler> {
  return {
    proposeAdminLedgerCorrection: route(async (req) => {
      const by = financeActor(req);
      const key = requireIdempotencyKey(req);
      const b = (req.body ?? {}) as { journalId?: unknown; reason?: unknown };
      if (typeof b.journalId !== 'string') throw new DomainError('VALIDATION_FAILED', 'journalId is required');
      if (typeof b.reason !== 'string') throw new DomainError('VALIDATION_FAILED', 'A reason is required');
      return created(correctionBody(await svc.propose({ journalId: b.journalId, reason: b.reason.slice(0, 500), idempotencyKey: key }, by, req.now)));
    }),
    approveAdminLedgerCorrection: route(async (req) => ok(correctionBody(await svc.approve(req.params['id'] ?? '', financeActor(req), req.now)))),
    rejectAdminLedgerCorrection: route(async (req) => {
      const by = financeActor(req);
      const b = (req.body ?? {}) as { reason?: unknown };
      return ok(correctionBody(await svc.reject(req.params['id'] ?? '', by, typeof b.reason === 'string' ? b.reason.slice(0, 500) : '', req.now)));
    }),
  };
}
