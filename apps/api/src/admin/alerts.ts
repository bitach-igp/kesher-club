// Compliance alerts (T-0908, REQ-CMP-001): ops.case rows of the monitoring kinds, read as a queue and
// decided with a disposition. The rules that open them are T-0909 (worker); the recon job already
// opens recon_break cases. A payload may quote member or merchant text: it is returned as text.
import { DomainError } from '@kesher/domain';
import type { AuditService } from '../audit/service.ts';
import type { Database, SqlClient } from '../db.ts';

/** The audit service wants a Database; inside a transaction the client is the transaction. */
const inTx = (tx: SqlClient): Database => ({ query: tx.query, transaction: async (fn) => fn(tx) });

export const ALERT_KINDS = ['structuring', 'sanctions_hit', 'kyc_manual_review', 'velocity', 'recon_break'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const DISPOSITIONS = ['in_review', 'cleared', 'escalated'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export type AlertStatus = 'open' | 'in_review' | 'cleared' | 'escalated';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: Severity;
  status: AlertStatus;
  partyId?: string;
  /** From the rule that opened the case; may quote member or merchant text. */
  summary: string;
  openedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface StaffActor {
  subject: string;
  partyId: string;
  role: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE = 500;

interface Row {
  id: string;
  kind: AlertKind;
  severity: Severity;
  status: 'open' | 'investigating' | 'resolved' | 'dismissed';
  payload: Record<string, unknown>;
  opened_at: string | Date;
  disposition: Disposition | null;
  decided_by: string | null;
  decided_at: string | Date | null;
  decision_note: string | null;
}

const iso = (v: string | Date): string => new Date(v).toISOString();

/** A case without a disposition is open; investigating/resolved/dismissed without one came from elsewhere and read as in_review/cleared. */
const statusOf = (r: Row): AlertStatus => r.disposition ?? (r.status === 'open' ? 'open' : r.status === 'investigating' ? 'in_review' : 'cleared');

const summaryOf = (r: Row): string => {
  const s = r.payload['summary'];
  if (typeof s === 'string' && s.trim()) return s.slice(0, 500);
  if (r.kind === 'recon_break') return [r.payload['provider'], r.payload['externalId'], r.payload['reason']].filter((x) => typeof x === 'string').join(' · ') || 'Reconciliation break';
  return r.kind.replace(/_/g, ' ');
};

const toAlert = (r: Row): Alert => {
  const party = r.payload['partyId'];
  return {
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    status: statusOf(r),
    ...(typeof party === 'string' && UUID.test(party) ? { partyId: party.toLowerCase() } : {}),
    summary: summaryOf(r),
    openedAt: iso(r.opened_at),
    ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
    ...(r.decided_at ? { decidedAt: iso(r.decided_at) } : {}),
    ...(r.decision_note ? { note: r.decision_note } : {}),
  };
};

const COLUMNS = 'id, kind, severity, status, payload, opened_at, disposition, decided_by, decided_at, decision_note';

export class AlertService {
  private readonly db: Database;
  private readonly audit: AuditService;
  constructor(
    db: Database,
    audit: AuditService,
  ) {
    this.db = db;
    this.audit = audit;
  }

  /** Every monitoring case, undecided first (worst severity, then oldest), then decided ones newest first. */
  async list(): Promise<Alert[]> {
    const r = await this.db.query<Row>(
      `select ${COLUMNS} from ops.case where kind = any($1)
        order by (disposition is null or disposition = 'in_review') desc,
                 array_position(array['critical','high','medium','low'], severity),
                 case when disposition is null or disposition = 'in_review' then opened_at end asc,
                 decided_at desc nulls last, opened_at desc`,
      [[...ALERT_KINDS]],
    );
    return r.rows.map(toAlert);
  }

  async get(id: string): Promise<Alert | undefined> {
    const r = await this.db.query<Row>(`select ${COLUMNS} from ops.case where id = $1 and kind = any($2)`, [id, [...ALERT_KINDS]]);
    return r.rows[0] ? toAlert(r.rows[0]) : undefined;
  }

  /** cleared and escalated are final; in_review can be decided again. */
  async decide(id: string, disposition: Disposition, note: string, by: StaffActor, now: Date): Promise<Alert> {
    if (!DISPOSITIONS.includes(disposition)) throw new DomainError('VALIDATION_FAILED', `decision must be one of ${DISPOSITIONS.join(', ')}`);
    const trimmed = note.trim();
    if (!trimmed || trimmed.length > MAX_NOTE) throw new DomainError('VALIDATION_FAILED', `note must be 1 to ${MAX_NOTE} characters`);
    if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 'Alert not found');
    const current = await this.get(id);
    if (!current) throw new DomainError('NOT_FOUND', 'Alert not found');
    if (current.status === 'cleared' || current.status === 'escalated') throw new DomainError('IDEMPOTENCY_CONFLICT', 'Alert already decided');
    const caseStatus = disposition === 'cleared' ? 'resolved' : 'investigating';
    return this.db.transaction(async (tx) => {
      const r = await tx.query<Row>(
        `update ops.case set disposition = $2, decided_by = $3, decided_at = $4, decision_note = $5, status = $6,
                resolved_at = case when $2 = 'cleared' then $4 else resolved_at end,
                resolved_by = case when $2 = 'cleared' then $7::uuid else resolved_by end,
                resolution = case when $2 = 'cleared' then $5 else resolution end
          where id = $1 and (disposition is null or disposition = 'in_review') returning ${COLUMNS}`,
        [id, disposition, by.subject, now, trimmed, caseStatus, by.partyId],
      );
      if (!r.rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Alert already decided');
      const alert = toAlert(r.rows[0]);
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: `alert.${disposition}`, subject: id, reason: trimmed, payload: { kind: alert.kind, ...(alert.partyId ? { partyId: alert.partyId } : {}) } }, now, inTx(tx));
      return alert;
    });
  }
}
