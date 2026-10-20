// Institution onboarding (T-0924, REQ-ADM-004): Kesher admins create institutions and make signed-up
// members their staff. The staff role applies at once; finance and admin move money or people, so they
// open a staff_grant approval that a second, different admin must approve before the role lands. Every
// change is audited against the member's party id, so Customer 360 shows it. Removal deactivates the
// org.staff row, which every institution handler checks per request, so institution actions stop at
// once; the org_* role leaves the member's token at their next sign-in.
import { DomainError, uuidv7 } from '@kesher/domain';
import type { ApprovalRequest, ApprovalService, Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { IdentityRepository } from '../auth/repository.ts';
import { isPgError, PG, type Database, type SqlClient } from '../db.ts';
import { created, ok, requireIdempotencyKey, route, type Handler } from '../http.ts';
import { maskPhone } from './customers.ts';
import { approvalBody } from './handlers.ts';
import { requireStaff, staffActor } from './staff-token.ts';

export const STAFF_ROLES = ['staff', 'finance', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type InstitutionMarket = 'US' | 'IL';

/** The token role each institution role carries; institution handlers check these. */
export const ORG_ROLE: Record<StaffRole, string> = { staff: 'org_staff', finance: 'org_finance', admin: 'org_admin' };

export interface AdminInstitution {
  id: string;
  name: string;
  market: InstitutionMarket;
  createdAt: string;
  activeStaff: number;
}

export interface InstitutionStaffMember {
  partyId: string;
  institutionId: string;
  role: StaffRole;
  active: boolean;
  createdAt: string;
  phoneMasked?: string;
}

export interface StaffAssignment {
  staff?: InstitutionStaffMember;
  grant?: ApprovalRequest;
}

interface GrantPayload {
  institutionId: string;
  partyId: string;
  role: StaffRole;
  reason: string;
}

interface StaffRow {
  party_id: string;
  institution_id: string;
  role: StaffRole;
  active: boolean;
  created_at: string | Date;
}

const MAX_NAME = 120;
const MAX_REASON = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The audit service wants a Database; inside a transaction the client is the transaction. */
const inTx = (tx: SqlClient): Database => ({ query: tx.query, transaction: async (fn) => fn(tx) });
const iso = (v: string | Date): string => new Date(v).toISOString();
const toStaff = (r: StaffRow): InstitutionStaffMember => ({ partyId: r.party_id, institutionId: r.institution_id, role: r.role, active: r.active, createdAt: iso(r.created_at) });

function requireReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r || r.length > MAX_REASON) throw new DomainError('VALIDATION_FAILED', `A reason of 1 to ${MAX_REASON} characters is required`);
  return r;
}

export class InstitutionAdmin {
  private readonly db: Database;
  private readonly identity: IdentityRepository;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  constructor(db: Database, identity: IdentityRepository, approvals: ApprovalService, audit: AuditService) {
    this.db = db;
    this.identity = identity;
    this.approvals = approvals;
    this.audit = audit;
  }

  /** Creates the institution once per key; a retry with the same key and body answers the same institution. */
  async create(input: { idempotencyKey: string; name: unknown; market: unknown; reason: unknown }, actor: Approver, now: Date): Promise<AdminInstitution> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > MAX_NAME) throw new DomainError('VALIDATION_FAILED', `name must be 1 to ${MAX_NAME} characters`);
    if (input.market !== 'US' && input.market !== 'IL') throw new DomainError('VALIDATION_FAILED', 'market must be US or IL');
    const market = input.market;
    const reason = requireReason(input.reason);
    const replay = async (): Promise<AdminInstitution | undefined> => {
      const r = await this.db.query<{ institution_id: string }>('select institution_id from org.institution_onboarding where idempotency_key = $1', [input.idempotencyKey]);
      const id = r.rows[0]?.institution_id;
      if (!id) return undefined;
      const i = (await this.get(id))!;
      if (i.name !== name || i.market !== market) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This key created a different institution');
      return i;
    };
    const seen = await replay();
    if (seen) return seen;
    const id = uuidv7(now);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query('insert into org.institution (id, name, market, created_at) values ($1, $2, $3, $4)', [id, name, market, now]);
        await tx.query('insert into org.institution_onboarding (idempotency_key, institution_id, created_by, created_at) values ($1, $2, $3, $4)', [input.idempotencyKey, id, actor.partyId, now]);
        await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.create', subject: id, reason, after: { name, market } }, now, inTx(tx));
      });
    } catch (e) {
      // A concurrent create with the same key won; answer what it made.
      if (isPgError(e, PG.UNIQUE_VIOLATION)) {
        const won = await replay();
        if (won) return won;
      }
      throw e;
    }
    return (await this.get(id))!;
  }

  async list(): Promise<AdminInstitution[]> {
    const r = await this.db.query<{ id: string; name: string; market: InstitutionMarket; created_at: string | Date; active_staff: number }>(
      `select i.id, i.name, i.market, i.created_at, (select count(*)::int from org.staff s where s.institution_id = i.id and s.active) as active_staff
         from org.institution i order by i.created_at, i.name limit 500`,
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, market: x.market, createdAt: iso(x.created_at), activeStaff: x.active_staff }));
  }

  async get(id: string): Promise<AdminInstitution | undefined> {
    if (!UUID.test(id)) return undefined;
    const r = await this.db.query<{ id: string; name: string; market: InstitutionMarket; created_at: string | Date; active_staff: number }>(
      `select i.id, i.name, i.market, i.created_at, (select count(*)::int from org.staff s where s.institution_id = i.id and s.active) as active_staff
         from org.institution i where i.id = $1`,
      [id],
    );
    const x = r.rows[0];
    return x ? { id: x.id, name: x.name, market: x.market, createdAt: iso(x.created_at), activeStaff: x.active_staff } : undefined;
  }

  /** The institution's staff, active first, and the finance/admin grants still waiting for a second admin. */
  async staff(institutionId: string, now: Date): Promise<{ items: InstitutionStaffMember[]; pendingGrants: ApprovalRequest[] }> {
    await this.requireInstitution(institutionId);
    const rows = await this.db.query<StaffRow>('select party_id, institution_id, role, active, created_at from org.staff where institution_id = $1 order by active desc, created_at, party_id', [institutionId]);
    const items = await Promise.all(rows.rows.map(async (r) => {
      const user = await this.identity.findUser(r.party_id);
      return { ...toStaff(r), ...(user ? { phoneMasked: maskPhone(user.phone) } : {}) };
    }));
    const open = await this.db.query<{ id: string }>(
      `select id from ops.approval_request where kind = 'staff_grant' and status = 'awaiting_second_approval' and expires_at > $2 and payload->>'institutionId' = $1 order by created_at`,
      [institutionId, now],
    );
    const pendingGrants = (await Promise.all(open.rows.map((g) => this.approvals.get(g.id)))).filter((g): g is ApprovalRequest => !!g);
    return { items, pendingGrants };
  }

  /**
   * Makes a signed-up member the institution's staff. `staff` applies now; `finance` and `admin` open a
   * staff_grant with the proposer as its first approver. The key scopes the grant, so a retry answers
   * the same grant and a later re-grant (after a removal) opens a new one.
   */
  async assign(input: { idempotencyKey: string; institutionId: string; partyId: unknown; role: unknown; reason: unknown }, actor: Approver, now: Date): Promise<StaffAssignment> {
    const reason = requireReason(input.reason);
    if (typeof input.role !== 'string' || !(STAFF_ROLES as readonly string[]).includes(input.role)) throw new DomainError('VALIDATION_FAILED', 'role must be staff, finance or admin');
    if (typeof input.partyId !== 'string' || !UUID.test(input.partyId)) throw new DomainError('VALIDATION_FAILED', 'partyId must be a uuid');
    const role = input.role as StaffRole;
    const partyId = input.partyId.toLowerCase();
    await this.requireInstitution(input.institutionId);
    await this.requireAssignable(input.institutionId, partyId);

    if (role === 'staff') {
      // A retry finds the row it wrote and writes (and audits) nothing more.
      const same = await this.db.query<StaffRow>('select party_id, institution_id, role, active, created_at from org.staff where party_id = $1 and institution_id = $2 and active and role = $3', [partyId, input.institutionId, role]);
      if (same.rows[0]) return { staff: toStaff(same.rows[0]) };
      return { staff: await this.apply({ institutionId: input.institutionId, partyId, role, reason }, actor, now) };
    }

    const payload: GrantPayload = { institutionId: input.institutionId, partyId, role, reason };
    let grant = await this.approvals.request({ kind: 'staff_grant', subject: `staff:${input.institutionId}:${partyId}:${role}:${input.idempotencyKey}`, scope: 'platform', requestedBy: actor, payload: { ...payload } }, now);
    if (grant.approvals === 0) {
      grant = await this.approvals.decide(grant.id, actor, 'approve', now, 'proposed');
      await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.staff.propose', subject: partyId, reason, payload: { institutionId: input.institutionId, role, grantId: grant.id } }, now);
    }
    return { grant };
  }

  /** The second admin's approval: refused for the proposer (one decision per person), applied once approved. */
  async approve(grantId: string, actor: Approver, now: Date): Promise<StaffAssignment> {
    const pre = UUID.test(grantId) ? await this.approvals.get(grantId) : undefined;
    if (!pre || pre.kind !== 'staff_grant') throw new DomainError('NOT_FOUND', 'Staff grant not found');
    const p = pre.payload as unknown as GrantPayload;
    // The member may have joined another institution since the proposal; refuse before deciding.
    if (pre.status === 'awaiting_second_approval') await this.requireAssignable(p.institutionId, p.partyId);
    const grant = await this.approvals.decide(grantId, actor, 'approve', now);
    if (grant.status !== 'approved') return { grant };
    const staff = await this.apply(p, actor, now, { grantId, proposedBy: pre.requestedBy, approvedBy: actor.partyId });
    return { grant, staff };
  }

  /** Deactivates the member's staff row and strips their org role. Removing someone already removed answers the row. */
  async remove(input: { institutionId: string; partyId: string; reason: unknown }, actor: Approver, now: Date): Promise<InstitutionStaffMember> {
    const reason = requireReason(input.reason);
    await this.requireInstitution(input.institutionId);
    const partyId = input.partyId.toLowerCase();
    const r = await this.db.query<StaffRow>('update org.staff set active = false where party_id = $1 and institution_id = $2 and active returning party_id, institution_id, role, active, created_at', [partyId, input.institutionId]);
    const removed = r.rows[0];
    if (!removed) {
      const prior = await this.db.query<StaffRow>('select party_id, institution_id, role, active, created_at from org.staff where party_id = $1 and institution_id = $2', [partyId, input.institutionId]);
      if (!prior.rows[0]) throw new DomainError('NOT_FOUND', 'Not staff of this institution');
      return toStaff(prior.rows[0]);
    }
    await this.setOrgRole(partyId, undefined);
    await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.staff.remove', subject: partyId, reason, before: { institutionId: input.institutionId, role: removed.role, active: true }, after: { institutionId: input.institutionId, role: removed.role, active: false }, payload: { institutionId: input.institutionId, role: removed.role } }, now);
    return toStaff(removed);
  }

  /**
   * Writes the staff row and the token role. The upsert moves nobody between institutions: an active row
   * at another institution matches no update, which answers IDEMPOTENCY_CONFLICT.
   */
  private async apply(g: GrantPayload, actor: Approver, now: Date, approval?: { grantId: string; proposedBy: string; approvedBy: string }): Promise<InstitutionStaffMember> {
    const r = await this.db.query<StaffRow>(
      `insert into org.staff (party_id, institution_id, role, active, created_at) values ($1, $2, $3, true, $4)
       on conflict (party_id) do update set institution_id = excluded.institution_id, role = excluded.role, active = true
         where org.staff.institution_id = excluded.institution_id or not org.staff.active
       returning party_id, institution_id, role, active, created_at`,
      [g.partyId, g.institutionId, g.role, now],
    );
    if (!r.rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Already staff of another institution');
    await this.setOrgRole(g.partyId, g.role);
    await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.staff.grant', subject: g.partyId, reason: g.reason, after: { institutionId: g.institutionId, role: g.role, active: true }, payload: { institutionId: g.institutionId, role: g.role, ...(approval ?? {}) } }, now);
    const user = await this.identity.findUser(g.partyId);
    return { ...toStaff(r.rows[0]), ...(user ? { phoneMasked: maskPhone(user.phone) } : {}) };
  }

  private async setOrgRole(partyId: string, role: StaffRole | undefined): Promise<void> {
    const user = await this.identity.findUser(partyId);
    if (!user) return;
    const kept = user.roles.filter((r) => !r.startsWith('org_'));
    await this.identity.setUserRoles(partyId, role ? [...kept, ORG_ROLE[role]] : kept);
  }

  private async requireInstitution(id: string): Promise<void> {
    if (!(await this.get(id))) throw new DomainError('NOT_FOUND', 'Institution not found');
  }

  /** A signed-up, active member who is not active staff of another institution. */
  private async requireAssignable(institutionId: string, partyId: string): Promise<void> {
    const user = await this.identity.findUser(partyId);
    if (!user) throw new DomainError('NOT_FOUND', 'No member with that party id');
    if (user.status !== 'active') throw new DomainError('IDEMPOTENCY_CONFLICT', `The member's account is ${user.status}`);
    const r = await this.db.query<{ institution_id: string }>('select institution_id from org.staff where party_id = $1 and active', [partyId]);
    const at = r.rows[0]?.institution_id;
    if (at && at !== institutionId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Already staff of another institution');
  }
}

const assignmentBody = (a: StaffAssignment) => ({ ...(a.staff ? { staff: a.staff } : {}), ...(a.grant ? { grant: approvalBody(a.grant) } : {}) });

/** /admin/institutions* and /admin/staff-grants/{id}/approve: staff token only; the service audits. */
export function institutionAdminHandlers(admin: InstitutionAdmin): Record<string, Handler> {
  return {
    listAdminInstitutions: route(async (req) => {
      requireStaff(req);
      return ok({ items: await admin.list() });
    }),

    createAdminInstitution: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const b = (req.body ?? {}) as { name?: unknown; market?: unknown; reason?: unknown };
      return created(await admin.create({ idempotencyKey: requireIdempotencyKey(req), name: b.name, market: b.market, reason: b.reason }, staffActor(p), req.now));
    }),

    listAdminInstitutionStaff: route(async (req) => {
      requireStaff(req);
      const r = await admin.staff(req.params['id'] ?? '', req.now);
      return ok({ items: r.items, pendingGrants: r.pendingGrants.map(approvalBody) });
    }),

    assignAdminInstitutionStaff: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const b = (req.body ?? {}) as { partyId?: unknown; role?: unknown; reason?: unknown };
      return created(assignmentBody(await admin.assign({ idempotencyKey: requireIdempotencyKey(req), institutionId: req.params['id'] ?? '', partyId: b.partyId, role: b.role, reason: b.reason }, staffActor(p), req.now)));
    }),

    removeAdminInstitutionStaff: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const b = (req.body ?? {}) as { reason?: unknown };
      return ok(await admin.remove({ institutionId: req.params['id'] ?? '', partyId: req.params['partyId'] ?? '', reason: b.reason }, staffActor(p), req.now));
    }),

    approveAdminStaffGrant: route(async (req) => {
      const p = requireStaff(req, 'admin');
      return ok(assignmentBody(await admin.approve(req.params['id'] ?? '', staffActor(p), req.now)));
    }),
  };
}
