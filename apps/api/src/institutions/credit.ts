// Institution credit limits (T-0616, REQ-INS-008): an institution may pay allowances on credit, down to minus
// the limit Kesher set on purpose for that currency, and no further. A limit is ₪0 / $0 until one admin
// proposes one and a second, different admin approves it (approval kind `credit_limit`); each approved limit
// is a new row in ops.institution_credit_limit, audited, never an update.
//
// Headroom is what the account holds, plus the limit, less what other runs already started still owe. A run
// is started under one advisory lock per institution (`withLock`): the check and the run's move to
// `running` commit together, so two runs cannot both pass on the same headroom; the second sees the first's
// unpaid remainder reserved. Payouts (T-0527) never use the limit: credit pays students, not suppliers.
// Credit also waits on the institution's KYB (T-0621): a limit is set, and drawn, only while the decision is
// `approved`; under `approved_with_limits` the drawable limit is zero.
import { DomainError, format, fromWire, money, toWire, uuidv7, type Currency, type Money } from '@kesher/domain';
import type { ApprovalRequest, ApprovalService, Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import { approvalBody } from '../admin/handlers.ts';
import { requireStaff, staffActor } from '../admin/staff-token.ts';
import type { Database, SqlClient } from '../db.ts';
import type { KybGate } from './kyb-gate.ts';
import { created, ok, requireIdempotencyKey, route, type Handler } from '../http.ts';

const CURRENCIES = ['ILS', 'USD'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LimitPayload {
  institutionId: string;
  limitMinor: string;
  currency: Currency;
  reason: string;
}

export interface CreditLimit {
  currency: Currency;
  limit: ReturnType<typeof toWire>;
  setAt?: string;
}

export interface Headroom {
  balance: Money;
  /** The limit that can be drawn now: the approved one, or zero while the KYB decision keeps credit closed (T-0621). */
  limit: Money;
  /** An approved limit exists but the KYB decision does not open credit. */
  creditClosed: boolean;
  /** What runs already started, other than the one asking, still owe. */
  reserved: Money;
}

/** What a run still owes: its members not yet paid, at the schedule's amount (the total is that amount × members). */
export async function owedByRun(client: SqlClient, run: { workflowId: string; memberCount: number; total: Money }): Promise<Money> {
  if (run.memberCount === 0) return money(0n, run.total.currency);
  const r = await client.query<{ paid: number }>(`select count(*)::int as paid from org.allowance_payment where workflow_id = $1 and status = 'paid'`, [run.workflowId]);
  const unpaid = BigInt(Math.max(0, run.memberCount - (r.rows[0]?.paid ?? 0)));
  return money(unpaid * (run.total.minor / BigInt(run.memberCount)), run.total.currency);
}

export class InstitutionCredit {
  private readonly db: Database;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  private readonly kyb: Pick<KybGate, 'allows' | 'require'>;
  constructor(db: Database, approvals: ApprovalService, audit: AuditService, kyb: Pick<KybGate, 'allows' | 'require'>) {
    this.db = db;
    this.approvals = approvals;
    this.audit = audit;
    this.kyb = kyb;
  }

  /** The approved limit, or zero when none was ever set. */
  async limit(institutionId: string, currency: Currency, client: SqlClient = this.db): Promise<Money> {
    const r = await client.query<{ limit_minor: string }>('select limit_minor::text from ops.institution_credit_limit where institution_id = $1 and currency = $2 order by set_at desc, id desc limit 1', [institutionId, currency]);
    return money(BigInt(r.rows[0]?.limit_minor ?? '0'), currency);
  }

  async headroom(institutionId: string, currency: Currency, excludingWorkflow: string, client: SqlClient = this.db): Promise<Headroom> {
    // Credit-normal: the ledger balance negated is what the institution holds.
    const b = await client.query<{ balance: string }>(
      `select coalesce(-sum(b.balance_minor), 0)::text as balance from ledger.account a join ops.account_balance b on b.account_id = a.id
        where a.owner_party_id = $1 and a.type = 'institution_master' and a.currency = $2`,
      [institutionId, currency],
    );
    const reserved = await client.query<{ reserved: string }>(
      `select coalesce(sum((r.member_count - p.paid)::bigint * (r.total_minor / r.member_count)), 0)::text as reserved
         from org.allowance_run r
         join org.allowance_schedule s on s.id = r.schedule_id
         cross join lateral (select count(*)::int as paid from org.allowance_payment ap where ap.workflow_id = r.workflow_id and ap.status = 'paid') p
        where s.institution_id = $1 and r.currency = $2 and r.status = 'running' and r.member_count > 0 and r.workflow_id <> $3`,
      [institutionId, currency, excludingWorkflow],
    );
    const approved = await this.limit(institutionId, currency, client);
    const open = await this.kyb.allows(institutionId, 'credit', client);
    return { balance: money(BigInt(b.rows[0]!.balance), currency), limit: open ? approved : money(0n, currency), creditClosed: !open && approved.minor > 0n, reserved: money(BigInt(reserved.rows[0]!.reserved), currency) };
  }

  /** INSUFFICIENT_FUNDS, saying what the account holds, the limit, and what the run needs, unless the headroom covers it. */
  async requireHeadroom(institutionId: string, needed: Money, workflowId: string, client: SqlClient = this.db): Promise<void> {
    // Allowances wait on the KYB decision (T-0621); inside startRun this runs under the institution's lock.
    await this.kyb.require(institutionId, 'allowances', client);
    const h = await this.headroom(institutionId, needed.currency, workflowId, client);
    if (needed.minor <= h.balance.minor + h.limit.minor - h.reserved.minor) return;
    const held = h.reserved.minor > 0n ? ` (${format(h.reserved)} of it is reserved by runs already started)` : '';
    const limit = h.creditClosed ? 'no credit until the institution\'s KYB is fully approved' : `a credit limit of ${format(h.limit)}`;
    throw new DomainError('INSUFFICIENT_FUNDS', `The run needs ${format(needed)}; the account holds ${format(h.balance)} with ${limit}${held}`, {
      balance: toWire(h.balance),
      creditLimit: toWire(h.limit),
      ...(h.creditClosed ? { creditClosed: true } : {}),
      reserved: toWire(h.reserved),
      needed: toWire(needed),
    });
  }

  /** Runs `fn` in one transaction holding the institution's credit lock; the lock ends with the transaction. */
  withLock<T>(institutionId: string, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('institution-credit:' || $1, 0))`, [institutionId]);
      return fn(tx);
    });
  }

  async list(institutionId: string, now: Date): Promise<{ items: CreditLimit[]; pending: ApprovalRequest[] }> {
    await this.requireInstitution(institutionId);
    const items = await Promise.all(
      CURRENCIES.map(async (c) => {
        const r = await this.db.query<{ set_at: string | Date }>('select set_at from ops.institution_credit_limit where institution_id = $1 and currency = $2 order by set_at desc, id desc limit 1', [institutionId, c]);
        const at = r.rows[0]?.set_at;
        return { currency: c, limit: toWire(await this.limit(institutionId, c)), ...(at ? { setAt: new Date(at).toISOString() } : {}) };
      }),
    );
    const open = await this.db.query<{ id: string }>(`select id from ops.approval_request where kind = 'credit_limit' and status = 'awaiting_second_approval' and expires_at > $2 and payload->>'institutionId' = $1 order by created_at`, [institutionId, now]);
    const pending = (await Promise.all(open.rows.map((x) => this.approvals.get(x.id)))).filter((x): x is ApprovalRequest => !!x);
    return { items, pending };
  }

  /** One admin proposes; nothing changes until a second approves. The key scopes the proposal, so a retry answers it. */
  async propose(input: { idempotencyKey: string; institutionId: string; limit: unknown; reason: unknown }, actor: Approver, now: Date): Promise<ApprovalRequest> {
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    if (!reason) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
    let limit: Money;
    try {
      limit = fromWire(input.limit as { minor: string; currency: string });
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'limit must be { minor, currency }');
    }
    if (limit.minor < 0n) throw new DomainError('VALIDATION_FAILED', 'limit cannot be negative');
    await this.requireInstitution(input.institutionId);
    await this.kyb.require(input.institutionId, 'credit');
    const payload: LimitPayload = { institutionId: input.institutionId, limitMinor: limit.minor.toString(), currency: limit.currency, reason };
    let req = await this.approvals.request({ kind: 'credit_limit', subject: `credit:${input.institutionId}:${limit.currency}:${input.idempotencyKey}`, scope: 'platform', requestedBy: actor, amount: limit, payload: { ...payload } }, now);
    const p = req.payload as unknown as LimitPayload;
    if (p.limitMinor !== payload.limitMinor || p.currency !== payload.currency) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key proposed a different limit');
    if (req.approvals === 0) {
      req = await this.approvals.decide(req.id, actor, 'approve', now, 'proposed');
      await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.credit.propose', subject: input.institutionId, reason, payload: { currency: limit.currency, limitMinor: payload.limitMinor, requestId: req.id } }, now);
    }
    return req;
  }

  /** The second admin's approval sets the limit; the proposer's own approval is refused (one decision per person). */
  async approve(requestId: string, actor: Approver, now: Date): Promise<{ request: ApprovalRequest; limit?: CreditLimit }> {
    const pre = UUID.test(requestId) ? await this.approvals.get(requestId) : undefined;
    if (!pre || pre.kind !== 'credit_limit') throw new DomainError('NOT_FOUND', 'Credit limit proposal not found');
    // The decision may have changed since the proposal.
    if (pre.status === 'awaiting_second_approval') await this.kyb.require((pre.payload as unknown as LimitPayload).institutionId, 'credit');
    const request = await this.approvals.decide(requestId, actor, 'approve', now);
    if (request.status !== 'approved') return { request };
    const p = request.payload as unknown as LimitPayload;
    // Keyed by the approval: a replay after a crash writes the row once.
    const r = await this.db.query('insert into ops.institution_credit_limit (id, institution_id, currency, limit_minor, approval_id, set_at) values ($1, $2, $3, $4, $5, $6) on conflict (approval_id) do nothing', [uuidv7(now), p.institutionId, p.currency, p.limitMinor, requestId, now]);
    const before = await this.limitBefore(p.institutionId, p.currency, requestId);
    if (r.rowCount) await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.credit.set', subject: p.institutionId, reason: p.reason, before: { currency: p.currency, limitMinor: before }, after: { currency: p.currency, limitMinor: p.limitMinor }, payload: { currency: p.currency, fromMinor: before, toMinor: p.limitMinor, requestId, proposedBy: pre.requestedBy, approvedBy: actor.partyId } }, now);
    return { request, limit: { currency: p.currency, limit: { minor: p.limitMinor, currency: p.currency }, setAt: now.toISOString() } };
  }

  private async limitBefore(institutionId: string, currency: Currency, requestId: string): Promise<string> {
    const r = await this.db.query<{ limit_minor: string }>('select limit_minor::text from ops.institution_credit_limit where institution_id = $1 and currency = $2 and approval_id <> $3 order by set_at desc, id desc limit 1', [institutionId, currency, requestId]);
    return r.rows[0]?.limit_minor ?? '0';
  }

  private async requireInstitution(id: string): Promise<void> {
    const r = UUID.test(id) ? await this.db.query('select 1 from org.institution where id = $1', [id]) : { rowCount: 0 };
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Institution not found');
  }
}

/** /admin/institutions/{id}/credit-limits and /admin/credit-limits/{id}/approve: staff tokens; writes take an admin. */
export function creditHandlers(credit: InstitutionCredit): Record<'listAdminCreditLimits' | 'proposeAdminCreditLimit' | 'approveAdminCreditLimit', Handler> {
  return {
    listAdminCreditLimits: route(async (req) => {
      requireStaff(req);
      const r = await credit.list(req.params['id'] ?? '', req.now);
      return ok({ items: r.items, pending: r.pending.map(approvalBody) });
    }),
    proposeAdminCreditLimit: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const b = (req.body ?? {}) as { limit?: unknown; reason?: unknown };
      return created({ request: approvalBody(await credit.propose({ idempotencyKey: requireIdempotencyKey(req), institutionId: req.params['id'] ?? '', limit: b.limit, reason: b.reason }, staffActor(p), req.now)) });
    }),
    approveAdminCreditLimit: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const r = await credit.approve(req.params['id'] ?? '', staffActor(p), req.now);
      return ok({ request: approvalBody(r.request), ...(r.limit ? { limit: r.limit } : {}) });
    }),
  };
}
