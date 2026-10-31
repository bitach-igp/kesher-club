// Team and roles (T-0643, REQ-INS-020): an institution's admins invite staff and change or remove their roles.
// - An invite goes by email or SMS; the address and the link's token are kept only as hashes. The invitee accepts
//   signed in, and becomes staff at once.
// - `finance` and `admin` move money or people, so they land only through a staff_grant on the shared approvals: the
//   proposing admin is its first approver, and a second, different admin of the same institution approves it with a
//   step-up. With a single admin, the grant waits in the admin console's queue, where a Kesher admin approves it
//   (REQ-ADM-004, T-0924); that queue already lists grants by institution.
// - Removing someone deactivates their staff row, which every institution handler checks per request, so their next
//   call is refused; their org role leaves their token at the next sign-in. The last active admin cannot be removed
//   or demoted. Every change is audited. Only admins act; other staff read the list.
import { createHash, randomBytes } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import type { NotifyPort } from '@kesher/ports';
import type { ApprovalRequest, ApprovalService, Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { IdentityRepository } from '../auth/repository.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { Database } from '../db.ts';
import { created, ok, requireIdempotencyKey, requirePrincipal, requireRole, route, type Handler, type HttpRequest } from '../http.ts';
import { ORG_ROLE, STAFF_ROLES, type StaffRole } from '../admin/institutions.ts';
import { approvalBody } from '../admin/handlers.ts';

export const STAFF_INVITE_BASE_URL = 'https://console.kesher.example/staff-invite?token=';
const INVITE_TTL_MS = 7 * 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const iso = (v: string | Date): string => new Date(v).toISOString();

export interface TeamMember {
  partyId: string;
  role: StaffRole;
  active: boolean;
  since: string;
}

export interface StaffInvite {
  id: string;
  role: StaffRole;
  channel: 'email' | 'sms';
  sentAt: string;
  expiresAt: string;
  acceptedAt?: string;
}

export interface Team {
  staff: TeamMember[];
  invites: StaffInvite[];
  /** Finance and admin roles waiting for a second approver. */
  pendingGrants: ApprovalRequest[];
}

interface GrantPayload {
  institutionId: string;
  partyId: string;
  role: StaffRole;
  reason: string;
}

export interface TeamDeps {
  db: Database;
  identity: Pick<IdentityRepository, 'findUser' | 'setUserRoles'>;
  approvals: ApprovalService;
  audit: AuditService;
  notify: NotifyPort;
}

const asRole = (v: unknown): StaffRole => {
  if (typeof v !== 'string' || !(STAFF_ROLES as readonly string[]).includes(v)) throw new DomainError('VALIDATION_FAILED', 'role must be staff, finance or admin');
  return v as StaffRole;
};

export class InstitutionTeam {
  private readonly d: TeamDeps;
  constructor(deps: TeamDeps) {
    this.d = deps;
  }

  async read(institutionId: string, now: Date): Promise<Team> {
    const [staff, invites, grants] = await Promise.all([
      this.d.db.query<{ party_id: string; role: StaffRole; active: boolean; created_at: string | Date }>('select party_id, role, active, created_at from org.staff where institution_id = $1 order by active desc, created_at, party_id', [institutionId]),
      this.d.db.query<{ id: string; role: StaffRole; channel: 'email' | 'sms'; sent_at: string | Date; expires_at: string | Date; accepted_at: string | Date | null }>(
        `select i.id, i.role, i.channel, i.sent_at, i.expires_at, a.accepted_at from org.staff_invite i left join org.staff_invite_acceptance a on a.invite_id = i.id
          where i.institution_id = $1 and (a.invite_id is null and i.expires_at > $2) order by i.sent_at desc`,
        [institutionId, now],
      ),
      this.d.db.query<{ id: string }>(`select id from ops.approval_request where kind = 'staff_grant' and status = 'awaiting_second_approval' and expires_at > $2 and payload->>'institutionId' = $1 order by created_at`, [institutionId, now]),
    ]);
    return {
      staff: staff.rows.map((s) => ({ partyId: s.party_id, role: s.role, active: s.active, since: iso(s.created_at) })),
      invites: invites.rows.map((i) => ({ id: i.id, role: i.role, channel: i.channel, sentAt: iso(i.sent_at), expiresAt: iso(i.expires_at), ...(i.accepted_at ? { acceptedAt: iso(i.accepted_at) } : {}) })),
      pendingGrants: (await Promise.all(grants.rows.map((g) => this.d.approvals.get(g.id)))).filter((g): g is ApprovalRequest => !!g),
    };
  }

  /** Sends an invite once per key; the address is hashed, the token travels only in the message. */
  async invite(institutionId: string, admin: string, body: unknown, key: string, now: Date): Promise<StaffInvite> {
    const b = (body ?? {}) as Record<string, unknown>;
    const role = asRole(b['role']);
    const email = typeof b['email'] === 'string' ? b['email'].trim().toLowerCase() : '';
    const phone = typeof b['phone'] === 'string' ? b['phone'].trim() : '';
    if (!!email === !!phone) throw new DomainError('VALIDATION_FAILED', 'Give an email or a phone number, not both');
    if (email && !EMAIL.test(email)) throw new DomainError('VALIDATION_FAILED', 'email is not an email address');
    if (phone && !PHONE.test(phone)) throw new DomainError('VALIDATION_FAILED', 'phone must be in international form, +972…');
    const seen = await this.d.db.query<{ id: string; institution_id: string; role: StaffRole }>('select id, institution_id, role from org.staff_invite where idempotency_key = $1', [key]);
    if (seen.rows[0]) {
      if (seen.rows[0].institution_id !== institutionId || seen.rows[0].role !== role) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key sent a different invite');
      return this.inviteView(seen.rows[0].id);
    }
    const token = randomBytes(24).toString('base64url');
    const id = uuidv7(now);
    const channel = email ? 'email' : 'sms';
    await this.d.db.query(
      'insert into org.staff_invite (id, institution_id, idempotency_key, role, channel, recipient_hash, token_hash, invited_by, sent_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, institutionId, key, role, channel, sha256(email || phone), sha256(token), admin, now, new Date(now.getTime() + INVITE_TTL_MS)],
    );
    const name = (await this.d.db.query<{ name: string }>('select name from org.institution where id = $1', [institutionId])).rows[0]?.name ?? '';
    await this.d.notify.send({ channel, to: email || phone, template: 'institution.staff_invite', locale: 'en', data: { institutionName: name, role, inviteUrl: `${STAFF_INVITE_BASE_URL}${token}` }, category: 'service' }, `staff-invite:${id}`);
    await this.d.audit.record({ actorId: admin, actorRole: 'org_admin', action: 'institution.staff.invite', subject: id, reason: `Invited as ${role}`, payload: { institutionId, role, channel } }, now);
    return this.inviteView(id);
  }

  /** The invitee, signed in, joins as staff; a finance or admin invite also opens the grant its inviter proposed. */
  async accept(token: string, partyId: string, now: Date): Promise<{ staff: TeamMember; grant?: ApprovalRequest }> {
    const r = await this.d.db.query<{ id: string; institution_id: string; role: StaffRole; invited_by: string; expires_at: string | Date; party_id: string | null }>(
      'select i.id, i.institution_id, i.role, i.invited_by, i.expires_at, a.party_id from org.staff_invite i left join org.staff_invite_acceptance a on a.invite_id = i.id where i.token_hash = $1',
      [sha256(token)],
    );
    const inv = r.rows[0];
    if (!inv) throw new DomainError('NOT_FOUND', 'Invite not found');
    if (inv.party_id && inv.party_id !== partyId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This invite was already accepted');
    if (!inv.party_id && new Date(inv.expires_at).getTime() <= now.getTime()) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This invite has expired; ask for a new one');
    const elsewhere = await this.d.db.query<{ institution_id: string }>('select institution_id from org.staff where party_id = $1 and active', [partyId]);
    if (elsewhere.rows[0] && elsewhere.rows[0].institution_id !== inv.institution_id) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Already staff of another institution');
    if (!inv.party_id) await this.d.db.query('insert into org.staff_invite_acceptance (invite_id, party_id, accepted_at) values ($1, $2, $3) on conflict do nothing', [inv.id, partyId, now]);
    const current = elsewhere.rows[0] ? await this.member(inv.institution_id, partyId) : undefined;
    const staff = current ?? (await this.apply(inv.institution_id, partyId, 'staff', { partyId, role: 'org_staff' }, 'Accepted a staff invite', now));
    if (inv.role === 'staff') return { staff };
    const grant = await this.propose(inv.institution_id, partyId, inv.role, { partyId: inv.invited_by, role: 'org_admin' }, `invite:${inv.id}`, 'Invited with this role', now);
    return { staff, grant };
  }

  /** An admin's change: a role, or removal. Staff applies at once; finance and admin open a grant. */
  async change(institutionId: string, admin: string, partyId: string, body: unknown, key: string, now: Date): Promise<{ staff: TeamMember; grant?: ApprovalRequest }> {
    const b = (body ?? {}) as Record<string, unknown>;
    const target = UUID.test(partyId) ? await this.member(institutionId, partyId.toLowerCase()) : undefined;
    if (!target || !target.active) throw new DomainError('NOT_FOUND', 'Not active staff of this institution');
    if (b['active'] === false) {
      await this.requireAnotherAdmin(institutionId, target);
      await this.d.db.query('update org.staff set active = false where party_id = $1 and institution_id = $2', [target.partyId, institutionId]);
      await this.setOrgRole(target.partyId, undefined);
      await this.d.audit.record({ actorId: admin, actorRole: 'org_admin', action: 'institution.staff.remove', subject: target.partyId, reason: 'Removed by an institution admin', before: { institutionId, role: target.role, active: true }, after: { institutionId, role: target.role, active: false }, payload: { institutionId } }, now);
      return { staff: (await this.member(institutionId, target.partyId))! };
    }
    const role = asRole(b['role']);
    if (role === target.role) return { staff: target };
    if (role === 'staff') {
      await this.requireAnotherAdmin(institutionId, target);
      return { staff: await this.apply(institutionId, target.partyId, 'staff', { partyId: admin, role: 'org_admin' }, `Role changed from ${target.role}`, now) };
    }
    if (target.partyId === admin) throw new DomainError('FORBIDDEN', 'You cannot raise your own role');
    return { staff: target, grant: await this.propose(institutionId, target.partyId, role, { partyId: admin, role: 'org_admin' }, key, `Raised to ${role}`, now) };
  }

  /** The second admin's approval; the proposer cannot approve their own grant. Applies the role once approved. */
  async approve(institutionId: string, admin: string, grantId: string, now: Date): Promise<{ grant: ApprovalRequest; staff?: TeamMember }> {
    const pre = UUID.test(grantId) ? await this.d.approvals.get(grantId) : undefined;
    const p = pre?.payload as unknown as GrantPayload | undefined;
    if (!pre || pre.kind !== 'staff_grant' || p?.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Grant not found');
    if (p.partyId === admin) throw new DomainError('FORBIDDEN', 'You cannot approve your own role');
    const grant = await this.d.approvals.decide(grantId, { partyId: admin, role: 'org_admin' }, 'approve', now);
    if (grant.status !== 'approved') return { grant };
    return { grant, staff: await this.apply(institutionId, p.partyId, p.role, { partyId: admin, role: 'org_admin' }, p.reason, now, grantId) };
  }

  private async propose(institutionId: string, partyId: string, role: StaffRole, by: Approver, key: string, reason: string, now: Date): Promise<ApprovalRequest> {
    const payload: GrantPayload = { institutionId, partyId, role, reason };
    let grant = await this.d.approvals.request({ kind: 'staff_grant', subject: `staff:${institutionId}:${partyId}:${role}:${key}`, scope: `institution:${institutionId}`, requestedBy: by, payload: { ...payload } }, now);
    if (grant.approvals === 0) {
      grant = await this.d.approvals.decide(grant.id, by, 'approve', now, 'proposed');
      await this.d.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'institution.staff.propose', subject: partyId, reason, payload: { institutionId, role, grantId: grant.id } }, now);
    }
    return grant;
  }

  /** Writes the staff row and the token role; nobody moves between institutions. */
  private async apply(institutionId: string, partyId: string, role: StaffRole, actor: Approver, reason: string, now: Date, grantId?: string): Promise<TeamMember> {
    const r = await this.d.db.query(
      `insert into org.staff (party_id, institution_id, role, active, created_at) values ($1, $2, $3, true, $4)
       on conflict (party_id) do update set institution_id = excluded.institution_id, role = excluded.role, active = true
         where org.staff.institution_id = excluded.institution_id or not org.staff.active
       returning party_id`,
      [partyId, institutionId, role, now],
    );
    if (!r.rowCount) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Already staff of another institution');
    await this.setOrgRole(partyId, role);
    await this.d.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.staff.grant', subject: partyId, reason, after: { institutionId, role, active: true }, payload: { institutionId, role, ...(grantId ? { grantId } : {}) } }, now);
    return (await this.member(institutionId, partyId))!;
  }

  /** The last active admin stays: someone must be able to approve and manage the team. */
  private async requireAnotherAdmin(institutionId: string, target: TeamMember): Promise<void> {
    if (target.role !== 'admin') return;
    const r = await this.d.db.query<{ n: number }>(`select count(*)::int as n from org.staff where institution_id = $1 and active and role = 'admin' and party_id <> $2`, [institutionId, target.partyId]);
    if (!r.rows[0]?.n) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The institution needs at least one admin');
  }

  private async setOrgRole(partyId: string, role: StaffRole | undefined): Promise<void> {
    const user = await this.d.identity.findUser(partyId);
    if (!user) return;
    const kept = user.roles.filter((r) => !r.startsWith('org_'));
    await this.d.identity.setUserRoles(partyId, role ? [...kept, ORG_ROLE[role]] : kept);
  }

  private async member(institutionId: string, partyId: string): Promise<TeamMember | undefined> {
    const r = await this.d.db.query<{ party_id: string; role: StaffRole; active: boolean; created_at: string | Date }>('select party_id, role, active, created_at from org.staff where party_id = $1 and institution_id = $2', [partyId, institutionId]);
    const s = r.rows[0];
    return s ? { partyId: s.party_id, role: s.role, active: s.active, since: iso(s.created_at) } : undefined;
  }

  private async inviteView(id: string): Promise<StaffInvite> {
    const r = await this.d.db.query<{ id: string; role: StaffRole; channel: 'email' | 'sms'; sent_at: string | Date; expires_at: string | Date; accepted_at: string | Date | null }>(
      'select i.id, i.role, i.channel, i.sent_at, i.expires_at, a.accepted_at from org.staff_invite i left join org.staff_invite_acceptance a on a.invite_id = i.id where i.id = $1',
      [id],
    );
    const i = r.rows[0]!;
    return { id: i.id, role: i.role, channel: i.channel, sentAt: iso(i.sent_at), expiresAt: iso(i.expires_at), ...(i.accepted_at ? { acceptedAt: iso(i.accepted_at) } : {}) };
  }
}

type StaffOfFn = (partyId: string) => Promise<{ institutionId: string; role: StaffRole } | undefined>;

export function teamHandlers(team: InstitutionTeam, stepUp: StepUpService, staffOf: StaffOfFn): Record<string, Handler> {
  /** Active staff of this institution; `admin` only when asked. Another institution reads as not found. */
  const own = async (req: HttpRequest, admin: boolean) => {
    const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
    const institutionId = req.params['id'] ?? '';
    const staff = await staffOf(p.partyId);
    if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
    if (admin && staff.role !== 'admin') throw new DomainError('FORBIDDEN', 'Only institution admins manage the team');
    return { institutionId, partyId: p.partyId };
  };
  const grantBody = (g: ApprovalRequest | undefined) => (g ? { grant: approvalBody(g) } : {});
  return {
    getInstitutionTeam: route(async (req) => {
      const { institutionId } = await own(req, false);
      const t = await team.read(institutionId, req.now);
      return ok({ ...t, pendingGrants: t.pendingGrants.map(approvalBody) });
    }),
    createStaffInvite: route(async (req) => {
      const { institutionId, partyId } = await own(req, true);
      return created(await team.invite(institutionId, partyId, req.body, requireIdempotencyKey(req), req.now));
    }),
    acceptStaffInvite: route(async (req) => {
      const p = requirePrincipal(req);
      const r = await team.accept(req.params['token'] ?? '', p.partyId, req.now);
      return ok({ staff: r.staff, ...grantBody(r.grant) });
    }),
    updateInstitutionStaff: route(async (req) => {
      const { institutionId, partyId } = await own(req, true);
      const r = await team.change(institutionId, partyId, req.params['partyId'] ?? '', req.body, requireIdempotencyKey(req), req.now);
      return ok({ staff: r.staff, ...grantBody(r.grant) });
    }),
    approveStaffGrant: route(async (req) => {
      const { institutionId, partyId } = await own(req, true);
      requireStepUp(stepUp, req);
      const r = await team.approve(institutionId, partyId, req.params['grantId'] ?? '', req.now);
      return ok({ grant: approvalBody(r.grant), ...(r.staff ? { staff: r.staff } : {}) });
    }),
  };
}
