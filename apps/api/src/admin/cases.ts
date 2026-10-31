// The ops queue (T-0930, REQ-ADM-005): every ops.case the money flows open that is not a compliance alert (those
// are T-0908's queue): suspense credits and deposits the bank never saw (T-0618), payout account mismatches
// (T-0623), and the balance proof's breaks (T-0203). Ops filter it, assign a case, and resolve or dismiss it with
// a note; each change is audited. Ops and finance staff work it; any staff member reads it (every staff token
// carries `admin`, so `admin` says nothing about who may act). A suspense credit is
// resolved only by recording it against an institution (T-0631), so here it can only be dismissed, when the money
// went back to its sender. A payload may quote a remitter's text: it is returned as data, never interpreted.
import { DomainError } from '@kesher/domain';
import type { AuditService } from '../audit/service.ts';
import type { Database, SqlClient } from '../db.ts';
import { requireStaff } from './staff-token.ts';
import { ok, route, type Handler } from '../http.ts';

const inTx = (tx: SqlClient): Database => ({ query: tx.query, transaction: async (fn) => fn(tx) });

export const OPS_CASE_KINDS = ['suspense', 'deposit_not_on_statement', 'payout_account_mismatch', 'balance_break', 'system_total_break', 'unbalanced_journal', 'kyb_application'] as const;
export type OpsCaseKind = (typeof OPS_CASE_KINDS)[number];
export type CaseStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';
const STATUSES: readonly CaseStatus[] = ['open', 'investigating', 'resolved', 'dismissed'];
export const DECISIONS = ['resolved', 'dismissed'] as const;
export type CaseDecision = (typeof DECISIONS)[number];
/** Who may assign and decide; support reads. */
export const CASE_WORKERS = ['ops', 'finance'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE = 500;
const PAGE = 50;

export interface OpsCase {
  id: string;
  kind: OpsCaseKind;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: CaseStatus;
  /** One line for the queue, built from the payload's own fields. */
  summary: string;
  /** What opened it, as the job wrote it: data, never instructions. */
  payload: Record<string, unknown>;
  openedAt: string;
  assignedTo?: string;
  assignedAt?: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface CaseActor {
  subject: string;
  partyId: string;
  role: string;
}

interface Row {
  id: string;
  kind: OpsCaseKind;
  severity: OpsCase['severity'];
  status: CaseStatus;
  payload: Record<string, unknown>;
  opened_at: string | Date;
  assigned_to: string | null;
  assigned_at: string | Date | null;
  decided_by: string | null;
  decided_at: string | Date | null;
  decision_note: string | null;
}

const COLUMNS = 'id, kind, severity, status, payload, opened_at, assigned_to, assigned_at, decided_by, decided_at, decision_note';
const iso = (v: string | Date): string => new Date(v).toISOString();
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const money = (v: unknown): string => {
  const m = v as { minor?: unknown; currency?: unknown } | undefined;
  return typeof m?.minor === 'string' && typeof m.currency === 'string' ? `${m.currency} ${m.minor}` : '';
};

function summaryOf(r: Row): string {
  const p = r.payload;
  const parts = (() => {
    switch (r.kind) {
      case 'suspense':
        return [money(p['amount']), str(p['rail']), str(p['bankReference']), str(p['reason']).replace(/_/g, ' ')];
      case 'deposit_not_on_statement':
        return [money(p['amount']), str(p['rail']), str(p['bankReference']), `value date ${str(p['valueDate'])}`];
      default:
        return [str(p['summary']) || str(p['reason']).replace(/_/g, ' ')];
    }
  })().filter(Boolean);
  return (parts.join(' · ') || r.kind.replace(/_/g, ' ')).slice(0, 300);
}

const toCase = (r: Row): OpsCase => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  status: r.status,
  summary: summaryOf(r),
  payload: r.payload,
  openedAt: iso(r.opened_at),
  ...(r.assigned_to ? { assignedTo: r.assigned_to } : {}),
  ...(r.assigned_at ? { assignedAt: iso(r.assigned_at) } : {}),
  ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
  ...(r.decided_at ? { decidedAt: iso(r.decided_at) } : {}),
  ...(r.decision_note ? { note: r.decision_note } : {}),
});

export interface CaseFilter {
  kind?: OpsCaseKind;
  status?: CaseStatus;
  /** A staff subject; the queue's "mine". */
  assignedTo?: string;
}

const encodeCursor = (c: { at: string; id: string }): string => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string | undefined): { at: string; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof c.at === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.at)) && UUID.test(c.id)) return { at: c.at, id: c.id };
  } catch {
    // fall through
  }
  throw new DomainError('VALIDATION_FAILED', 'cursor is not one this API gave out');
}

export class OpsCases {
  private readonly db: Database;
  private readonly audit: AuditService;
  constructor(db: Database, audit: AuditService) {
    this.db = db;
    this.audit = audit;
  }

  /** Newest first, cursor-paged; filters combine. */
  async list(filter: CaseFilter, cursor?: string): Promise<{ items: OpsCase[]; nextCursor?: string }> {
    const after = decodeCursor(cursor);
    const r = await this.db.query<Row>(
      `select ${COLUMNS} from ops.case
        where kind = any($1) and ($2::text is null or kind = $2) and ($3::text is null or status = $3) and ($4::text is null or assigned_to = $4)
          and ($5::timestamptz is null or (opened_at, id) < ($5::timestamptz, $6::uuid))
        order by opened_at desc, id desc limit ${PAGE + 1}`,
      [[...OPS_CASE_KINDS], filter.kind ?? null, filter.status ?? null, filter.assignedTo ?? null, after?.at ?? null, after?.id ?? null],
    );
    const items = r.rows.slice(0, PAGE).map(toCase);
    const last = r.rows.length > PAGE ? r.rows[PAGE - 1] : undefined;
    return { items, ...(last ? { nextCursor: encodeCursor({ at: iso(last.opened_at), id: last.id }) } : {}) };
  }

  async get(id: string): Promise<OpsCase> {
    const r = UUID.test(id) ? await this.db.query<Row>(`select ${COLUMNS} from ops.case where id = $1 and kind = any($2)`, [id, [...OPS_CASE_KINDS]]) : { rows: [] as Row[] };
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Case not found');
    return toCase(r.rows[0]);
  }

  /** The case is the actor's now, and under investigation. A decided case takes no assignment. */
  async assign(id: string, by: CaseActor, now: Date): Promise<OpsCase> {
    const current = await this.get(id);
    if (current.status === 'resolved' || current.status === 'dismissed') throw new DomainError('IDEMPOTENCY_CONFLICT', `This case is already ${current.status}`);
    return this.db.transaction(async (tx) => {
      const r = await tx.query<Row>(`update ops.case set assigned_to = $2, assigned_at = $3, status = 'investigating' where id = $1 and status in ('open', 'investigating') returning ${COLUMNS}`, [id, by.subject, now]);
      if (!r.rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This case was decided a moment ago');
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'case.assign', subject: id, reason: `Assigned to ${by.subject}`, before: { assignedTo: current.assignedTo ?? null }, after: { assignedTo: by.subject }, payload: { kind: current.kind } }, now, inTx(tx));
      return toCase(r.rows[0]);
    });
  }

  /** Resolved or dismissed, with a note; final. A suspense credit is resolved only through its deposit (T-0631). */
  async decide(id: string, decision: CaseDecision, note: string, by: CaseActor, now: Date): Promise<OpsCase> {
    if (!DECISIONS.includes(decision)) throw new DomainError('VALIDATION_FAILED', `decision must be one of ${DECISIONS.join(', ')}`);
    const trimmed = note.trim();
    if (!trimmed || trimmed.length > MAX_NOTE) throw new DomainError('VALIDATION_FAILED', `note must be 1 to ${MAX_NOTE} characters`);
    const current = await this.get(id);
    if (current.status === 'resolved' || current.status === 'dismissed') throw new DomainError('IDEMPOTENCY_CONFLICT', `This case is already ${current.status}`);
    if (current.kind === 'suspense' && decision === 'resolved') {
      throw new DomainError('VALIDATION_FAILED', 'A suspense credit is resolved by recording it against an institution; dismiss it only when the money went back to its sender', { reason: 'resolve_through_deposit' });
    }
    return this.db.transaction(async (tx) => {
      const r = await tx.query<Row>(
        `update ops.case set status = $2, decided_by = $3, decided_at = $4, decision_note = $5, resolved_at = $4, resolved_by = $6::uuid, resolution = $5
          where id = $1 and status in ('open', 'investigating') returning ${COLUMNS}`,
        [id, decision, by.subject, now, trimmed, by.partyId],
      );
      if (!r.rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This case was decided a moment ago');
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: `case.${decision}`, subject: id, reason: trimmed, before: { status: current.status }, after: { status: decision }, payload: { kind: current.kind } }, now, inTx(tx));
      return toCase(r.rows[0]);
    });
  }
}

const actorOf = (p: ReturnType<typeof requireStaff>): CaseActor => ({ subject: p.subject ?? p.partyId, partyId: p.partyId, role: p.roles.find((r) => (CASE_WORKERS as readonly string[]).includes(r)) ?? 'ops' });

function filterOf(q: Record<string, string | undefined>, me: string): CaseFilter {
  const kind = q['kind'];
  if (kind !== undefined && !(OPS_CASE_KINDS as readonly string[]).includes(kind)) throw new DomainError('VALIDATION_FAILED', `kind must be one of ${OPS_CASE_KINDS.join(', ')}`);
  const status = q['status'];
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', `status must be one of ${STATUSES.join(', ')}`);
  const assignee = q['assignee'];
  if (assignee !== undefined && assignee !== 'me') throw new DomainError('VALIDATION_FAILED', 'assignee can only be me');
  return { ...(kind ? { kind: kind as OpsCaseKind } : {}), ...(status ? { status: status as CaseStatus } : {}), ...(assignee ? { assignedTo: me } : {}) };
}

/** /admin/cases (T-0930). */
export function caseHandlers(cases: OpsCases): Record<string, Handler> {
  return {
    listAdminCases: route(async (req) => {
      const p = requireStaff(req);
      return ok(await cases.list(filterOf(req.query, p.subject ?? p.partyId), req.query['cursor']));
    }),
    getAdminCase: route(async (req) => {
      requireStaff(req);
      return ok(await cases.get(req.params['id'] ?? ''));
    }),
    assignAdminCase: route(async (req) => ok(await cases.assign(req.params['id'] ?? '', actorOf(requireStaff(req, ...CASE_WORKERS)), req.now))),
    decideAdminCase: route(async (req) => {
      const by = actorOf(requireStaff(req, ...CASE_WORKERS));
      const b = (req.body ?? {}) as { decision?: unknown; note?: unknown };
      if (typeof b.decision !== 'string' || typeof b.note !== 'string') throw new DomainError('VALIDATION_FAILED', 'decision and note are required');
      return ok(await cases.decide(req.params['id'] ?? '', b.decision as CaseDecision, b.note, by, req.now));
    }),
  };
}
