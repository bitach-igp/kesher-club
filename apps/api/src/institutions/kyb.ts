// Institution KYB (T-0619, REQ-INS-011, ADR-017): the record compliance decides on. The record holds:
// - the people: board members, control persons and signatories;
// - every check with its evidence reference;
// - the disposition of each screening hit;
// - the decisions.
// All of it is insert-only; the current state is the latest row. An institution with no decision is
// `needs_more_info`.
//
// An approval (`approved` or `approved_with_limits`) is refused, with every blocking reason listed, unless:
// - the registry and identifier checks are clear;
// - exempt status is clear or excepted;
// - the institution and each person are screened, with every hit disposed of and none a true sanctions match;
// - there is a control person, and each one has passed T2 KYC.
// A true PEP match is not a bar, but it makes the institution high risk. A high-risk approval waits for a second, different compliance reviewer (approval kind `kyb_decision`).
// Nothing here stores a document or an image, only a reference to where the evidence is kept.
import { DomainError, uuidv7 } from '@kesher/domain';
import type { ApprovalRequest, ApprovalService, Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import { isPgError, PG, type Database, type SqlClient } from '../db.ts';

export const KYB_STATUSES = ['needs_more_info', 'approved_with_limits', 'approved', 'rejected'] as const;
export type KybStatus = (typeof KYB_STATUSES)[number];
export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];
export const PERSON_ROLES = ['board', 'control', 'signatory'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];
export type CheckKind = 'registry' | 'identifier' | 'exempt_status' | 'sanctions' | 'pep';
export type CheckResult = 'clear' | 'hit' | 'missing' | 'excepted';

export interface KybPerson {
  id: string;
  fullName: string;
  roles: PersonRole[];
  partyId?: string;
}

export interface KybCheck {
  id: string;
  kind: CheckKind;
  /** Absent for a check on the institution itself. */
  personId?: string;
  result: CheckResult;
  provider: string;
  evidenceRef?: string;
  detail: Record<string, unknown>;
  checkedAt: string;
  disposition?: { outcome: 'false_positive' | 'true_match'; note: string; decidedBy: string; decidedAt: string };
}

export interface KybDecision {
  status: KybStatus;
  risk?: Risk;
  reasons: string[];
  decidedBy?: string;
  decidedAt?: string;
}

export interface KybRecord {
  institutionId: string;
  decision: KybDecision;
  people: KybPerson[];
  /** The latest check of each kind for the institution and for each person. */
  checks: KybCheck[];
  /** What an approval would be refused for today, as reason codes; empty when it could be approved. */
  blocking: string[];
  pendingApproval?: ApprovalRequest;
}

interface PendingDecision {
  institutionId: string;
  status: 'approved' | 'approved_with_limits';
  risk: Risk;
  reasons: string[];
  idempotencyKey: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date): string => new Date(v).toISOString();
const SCREENING: readonly CheckKind[] = ['sanctions', 'pep'];

export class InstitutionKyb {
  private readonly db: Database;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  constructor(db: Database, approvals: ApprovalService, audit: AuditService) {
    this.db = db;
    this.approvals = approvals;
    this.audit = audit;
  }

  /** The current decision; `needs_more_info` before any. What the gate (T-0621) reads. */
  async current(institutionId: string, client: SqlClient = this.db): Promise<KybDecision> {
    const r = await client.query<{ status: KybStatus; risk: Risk | null; reasons: string[]; decided_by: string; decided_at: string | Date }>(
      'select status, risk, reasons, decided_by, decided_at from org.kyb_decision where institution_id = $1 order by seq desc limit 1',
      [institutionId],
    );
    const d = r.rows[0];
    if (!d) return { status: 'needs_more_info', reasons: [] };
    return { status: d.status, ...(d.risk ? { risk: d.risk } : {}), reasons: d.reasons, decidedBy: d.decided_by, decidedAt: iso(d.decided_at) };
  }

  async record(institutionId: string): Promise<KybRecord> {
    await this.requireInstitution(institutionId);
    const [decision, people, checks] = await Promise.all([this.current(institutionId), this.people(institutionId), this.latestChecks(institutionId)]);
    const open = await this.db.query<{ id: string }>(`select id from ops.approval_request where kind = 'kyb_decision' and status = 'awaiting_second_approval' and payload->>'institutionId' = $1 order by created_at desc limit 1`, [institutionId]);
    const pendingApproval = open.rows[0] ? await this.approvals.get(open.rows[0].id) : undefined;
    return { institutionId, decision, people, checks, blocking: await this.blocking(people, checks), ...(pendingApproval ? { pendingApproval } : {}) };
  }

  /** A board member, control person or signatory; a retry with the same key answers the same person. */
  async addPerson(institutionId: string, input: { fullName: unknown; roles: unknown; partyId?: unknown }, key: string, actor: Approver, now: Date): Promise<KybPerson> {
    await this.requireInstitution(institutionId);
    const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : '';
    if (!fullName || fullName.length > 200) throw new DomainError('VALIDATION_FAILED', 'fullName must be 1 to 200 characters');
    const roles = Array.isArray(input.roles) ? [...new Set(input.roles)] : [];
    if (!roles.length || !roles.every((r): r is PersonRole => (PERSON_ROLES as readonly unknown[]).includes(r))) throw new DomainError('VALIDATION_FAILED', 'roles must be one or more of board, control, signatory');
    if (input.partyId !== undefined && (typeof input.partyId !== 'string' || !UUID.test(input.partyId))) throw new DomainError('VALIDATION_FAILED', 'partyId must be a uuid');
    const partyId = input.partyId as string | undefined;
    try {
      await this.db.query('insert into org.kyb_person (id, institution_id, idempotency_key, full_name, roles, party_id, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)', [uuidv7(now), institutionId, key, fullName, roles, partyId ?? null, actor.partyId, now]);
    } catch (e) {
      if (!isPgError(e, PG.UNIQUE_VIOLATION)) throw e;
    }
    const r = await this.db.query<PersonRow>('select id, institution_id, full_name, roles, party_id from org.kyb_person where idempotency_key = $1', [key]);
    const row = r.rows[0]!;
    if (row.institution_id !== institutionId || row.full_name !== fullName) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key added a different person');
    return toPerson(row);
  }

  /** One check result, from the provider (T-0622) or compliance (an exception carries `detail.reason`). */
  async recordCheck(institutionId: string, input: { kind: CheckKind; personId?: string; result: CheckResult; provider: string; evidenceRef?: string; detail?: Record<string, unknown> }, by: string | undefined, now: Date): Promise<KybCheck> {
    await this.requireInstitution(institutionId);
    if (input.result === 'excepted' && !(typeof input.detail?.['reason'] === 'string' && input.detail['reason'].trim())) throw new DomainError('VALIDATION_FAILED', 'An exception needs a reason');
    if (input.personId) {
      const p = await this.db.query('select 1 from org.kyb_person where id = $1 and institution_id = $2', [input.personId, institutionId]);
      if (!p.rowCount) throw new DomainError('NOT_FOUND', 'No such person in this institution\'s record');
    }
    const id = uuidv7(now);
    await this.db.query(
      'insert into org.kyb_check (id, institution_id, person_id, kind, result, provider, evidence_ref, detail, recorded_by, checked_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, institutionId, input.personId ?? null, input.kind, input.result, input.provider, input.evidenceRef ?? null, JSON.stringify(input.detail ?? {}), by ?? null, now],
    );
    return { id, kind: input.kind, ...(input.personId ? { personId: input.personId } : {}), result: input.result, provider: input.provider, ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}), detail: input.detail ?? {}, checkedAt: now.toISOString() };
  }

  /** A screening hit is a false positive or a true match, with a note; a hit is disposed of once. */
  async dispose(checkId: string, input: { outcome: unknown; note: unknown }, actor: Approver, now: Date): Promise<KybCheck> {
    if (input.outcome !== 'false_positive' && input.outcome !== 'true_match') throw new DomainError('VALIDATION_FAILED', 'outcome must be false_positive or true_match');
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 1000) : '';
    if (!note) throw new DomainError('VALIDATION_FAILED', 'A note is required');
    const r = UUID.test(checkId) ? await this.db.query<{ institution_id: string; kind: CheckKind; result: CheckResult }>('select institution_id, kind, result from org.kyb_check where id = $1', [checkId]) : { rows: [] };
    const c = r.rows[0];
    if (!c) throw new DomainError('NOT_FOUND', 'Check not found');
    if (c.result !== 'hit' || !SCREENING.includes(c.kind)) throw new DomainError('VALIDATION_FAILED', 'Only a screening hit is disposed of');
    try {
      await this.db.query('insert into org.kyb_disposition (id, check_id, outcome, note, decided_by, decided_at) values ($1, $2, $3, $4, $5, $6)', [uuidv7(now), checkId, input.outcome, note, actor.partyId, now]);
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This hit is already disposed of');
      throw e;
    }
    await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.kyb.dispose', subject: c.institution_id, reason: note, payload: { checkId, kind: c.kind, outcome: input.outcome } }, now);
    return (await this.latestChecks(c.institution_id, checkId))[0]!;
  }

  /**
   * Compliance decides. `needs_more_info` and `rejected` apply at once. An approval is refused while anything
   * blocks it; a high-risk one waits for a second reviewer. The key scopes the decision, so a retry answers it.
   */
  async decide(institutionId: string, input: { status: unknown; risk?: unknown; reasons?: unknown }, key: string, actor: Approver, now: Date): Promise<{ decision?: KybDecision; approval?: ApprovalRequest }> {
    await this.requireInstitution(institutionId);
    if (!(KYB_STATUSES as readonly unknown[]).includes(input.status)) throw new DomainError('VALIDATION_FAILED', 'status must be needs_more_info, approved_with_limits, approved or rejected');
    const status = input.status as KybStatus;
    if (input.risk !== undefined && !(RISKS as readonly unknown[]).includes(input.risk)) throw new DomainError('VALIDATION_FAILED', 'risk must be low, medium or high');
    const risk = input.risk as Risk | undefined;
    const reasons = Array.isArray(input.reasons) ? input.reasons.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 500)) : [];
    const replay = await this.db.query('select 1 from org.kyb_decision where idempotency_key = $1', [key]);
    if (replay.rowCount) return { decision: await this.current(institutionId) };

    if (status === 'needs_more_info' || status === 'rejected') {
      if (!reasons.length) throw new DomainError('VALIDATION_FAILED', 'Say why: reasons are required');
      return { decision: await this.write(institutionId, { status, ...(risk ? { risk } : {}), reasons }, key, actor, now) };
    }
    if (!risk) throw new DomainError('VALIDATION_FAILED', 'An approval names its risk rating');
    const checks = await this.latestChecks(institutionId);
    const blocking = await this.blocking(await this.people(institutionId), checks);
    // A politically exposed person is not a bar, but the institution is then high risk: two reviewers.
    if (risk !== 'high' && checks.some((c) => c.kind === 'pep' && c.disposition?.outcome === 'true_match')) blocking.push('pep_requires_high_risk');
    if (blocking.length) throw new DomainError('VALIDATION_FAILED', 'The KYB record does not support an approval yet', { blocking });
    if (risk !== 'high') return { decision: await this.write(institutionId, { status, risk, reasons }, key, actor, now) };

    const payload: PendingDecision = { institutionId, status, risk, reasons, idempotencyKey: key };
    let approval = await this.approvals.request({ kind: 'kyb_decision', subject: `kyb:${institutionId}:${key}`, scope: 'platform', requestedBy: actor, payload: { ...payload } }, now);
    if (approval.approvals === 0) {
      approval = await this.approvals.decide(approval.id, actor, 'approve', now, 'proposed');
      await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.kyb.propose', subject: institutionId, reason: reasons.join('; ') || `${status} at high risk`, payload: { status, risk, approvalId: approval.id } }, now);
    }
    return { approval };
  }

  /** The second reviewer of a high-risk approval; the record is checked again, as it may have changed since. */
  async approveDecision(approvalId: string, actor: Approver, now: Date): Promise<{ approval: ApprovalRequest; decision?: KybDecision }> {
    const pre = UUID.test(approvalId) ? await this.approvals.get(approvalId) : undefined;
    if (!pre || pre.kind !== 'kyb_decision') throw new DomainError('NOT_FOUND', 'KYB approval not found');
    const p = pre.payload as unknown as PendingDecision;
    if (pre.status === 'awaiting_second_approval') {
      const blocking = await this.blocking(await this.people(p.institutionId), await this.latestChecks(p.institutionId));
      if (blocking.length) throw new DomainError('VALIDATION_FAILED', 'The KYB record no longer supports this approval', { blocking });
    }
    const approval = await this.approvals.decide(approvalId, actor, 'approve', now);
    if (approval.status !== 'approved') return { approval };
    return { approval, decision: await this.write(p.institutionId, { status: p.status, risk: p.risk, reasons: p.reasons }, p.idempotencyKey, actor, now, { approvalId, proposedBy: pre.requestedBy }) };
  }

  /** Every reason an approval would be refused today, as stable codes the console puts in words (T-0926). */
  private async blocking(people: KybPerson[], checks: KybCheck[]): Promise<string[]> {
    const out: string[] = [];
    const own = (kind: CheckKind) => checks.find((c) => c.kind === kind && !c.personId);
    for (const kind of ['registry', 'identifier'] as const) if (own(kind)?.result !== 'clear') out.push(`${kind}_not_clear`);
    const exempt = own('exempt_status')?.result;
    if (exempt !== 'clear' && exempt !== 'excepted') out.push('exempt_status_not_shown');
    const subjects = [undefined, ...people.map((p) => p.id)];
    for (const subject of subjects) {
      for (const kind of SCREENING) {
        const c = checks.find((x) => x.kind === kind && x.personId === subject);
        const who = subject ?? 'institution';
        // Screening is never excepted: compliance may except exempt status, not a sanctions or PEP check.
        if (!c || c.result === 'missing' || c.result === 'excepted') out.push(`${kind}_not_screened:${who}`);
        else if (c.result === 'hit' && !c.disposition) out.push(`${kind}_hit_undisposed:${c.id}`);
        else if (c.result === 'hit' && c.disposition?.outcome === 'true_match' && kind === 'sanctions') out.push(`sanctions_true_match:${c.id}`);
      }
    }
    const control = people.filter((p) => p.roles.includes('control'));
    if (!control.length) out.push('no_control_person');
    for (const p of control) if (!p.partyId || !(await this.hasT2(p.partyId))) out.push(`control_person_not_t2:${p.id}`);
    return out;
  }

  /** The same reading as KycService: an approved T2 session at any time. */
  private async hasT2(partyId: string): Promise<boolean> {
    const r = await this.db.query(`select 1 from identity.kyc_session where party_id = $1 and tier = 'T2' and status = 'approved' limit 1`, [partyId]);
    return r.rowCount > 0;
  }

  private async write(institutionId: string, d: { status: KybStatus; risk?: Risk; reasons: string[] }, key: string, actor: Approver, now: Date, approval?: { approvalId: string; proposedBy: string }): Promise<KybDecision> {
    const before = await this.current(institutionId);
    try {
      await this.db.query(
        'insert into org.kyb_decision (id, institution_id, idempotency_key, status, risk, reasons, approval_id, decided_by, decided_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [uuidv7(now), institutionId, key, d.status, d.risk ?? null, d.reasons, approval?.approvalId ?? null, actor.partyId, now],
      );
    } catch (e) {
      // A replayed key or a second approve after a crash finds the decision it already wrote.
      if (isPgError(e, PG.UNIQUE_VIOLATION)) return this.current(institutionId);
      throw e;
    }
    await this.audit.record(
      { actorId: actor.partyId, actorRole: actor.role, action: 'institution.kyb.decide', subject: institutionId, reason: d.reasons.join('; ') || d.status, payload: { from: before.status, to: d.status, ...(d.risk ? { risk: d.risk } : {}), ...(approval ?? {}) } },
      now,
    );
    return this.current(institutionId);
  }

  private async people(institutionId: string): Promise<KybPerson[]> {
    const r = await this.db.query<PersonRow>('select id, institution_id, full_name, roles, party_id from org.kyb_person where institution_id = $1 order by created_at, id', [institutionId]);
    return r.rows.map(toPerson);
  }

  /** The latest check per (kind, person), with its disposition; or one check by id. */
  private async latestChecks(institutionId: string, checkId?: string): Promise<KybCheck[]> {
    const r = await this.db.query<CheckRow>(
      `select c.id, c.kind, c.person_id, c.result, c.provider, c.evidence_ref, c.detail, c.checked_at, d.outcome, d.note, d.decided_by, d.decided_at
         from (select distinct on (kind, person_id) * from org.kyb_check where institution_id = $1 and ($2::uuid is null or id = $2::uuid)
                order by kind, person_id, seq desc) c
         left join org.kyb_disposition d on d.check_id = c.id
        order by c.kind, c.person_id nulls first`,
      [institutionId, checkId ?? null],
    );
    return r.rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      ...(c.person_id ? { personId: c.person_id } : {}),
      result: c.result,
      provider: c.provider,
      ...(c.evidence_ref ? { evidenceRef: c.evidence_ref } : {}),
      detail: c.detail,
      checkedAt: iso(c.checked_at),
      ...(c.outcome ? { disposition: { outcome: c.outcome, note: c.note!, decidedBy: c.decided_by!, decidedAt: iso(c.decided_at!) } } : {}),
    }));
  }

  private async requireInstitution(id: string): Promise<void> {
    const r = UUID.test(id) ? await this.db.query('select 1 from org.institution where id = $1', [id]) : { rowCount: 0 };
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Institution not found');
  }
}

interface PersonRow {
  id: string;
  institution_id: string;
  full_name: string;
  roles: PersonRole[];
  party_id: string | null;
}

interface CheckRow {
  id: string;
  kind: CheckKind;
  person_id: string | null;
  result: CheckResult;
  provider: string;
  evidence_ref: string | null;
  detail: Record<string, unknown>;
  checked_at: string | Date;
  outcome: 'false_positive' | 'true_match' | null;
  note: string | null;
  decided_by: string | null;
  decided_at: string | Date | null;
}

const toPerson = (r: PersonRow): KybPerson => ({ id: r.id, fullName: r.full_name, roles: r.roles, ...(r.party_id ? { partyId: r.party_id } : {}) });
