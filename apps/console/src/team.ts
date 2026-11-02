// I11 team and roles (T-0644, REQ-INS-020): the staff with role and state — active, removed, open invites, and a
// finance or admin raise waiting for a second admin. Every staff role reads; only admins manage: they invite,
// change a role and remove (a removal asks once to confirm), and every write keeps its Idempotency-Key so a retry
// never makes it twice. A person shows as the last four digits of their party id; names are data, never copy. The
// signed-in person's party id comes from their access token's sub claim, read without verifying: the API enforces
// every rule; the console only hides the buttons the API would refuse.
import type { Schemas } from '@kesher/sdk';
import type { Result } from './api.ts';
import { t, type CopyKey, type Locale } from './i18n.ts';
import { withStepUp } from './step-up.ts';

export type MyInstitution = Schemas['MyInstitution'];
export type MyRole = MyInstitution['role'];
export type InstitutionTeam = Schemas['InstitutionTeam'];
export type TeamMember = Schemas['TeamMember'];
export type StaffInvite = Schemas['StaffInvite'];
export type StaffChange = Schemas['StaffChange'];
export type Grant = Schemas['ApprovalRequest'];
export type StaffRole = TeamMember['role'];
export const ROLES: readonly StaffRole[] = ['staff', 'finance', 'admin'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9]\d{7,14}$/;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const sameId = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The signed-in person's party id: the access token's sub claim. */
export function partyIdOf(accessToken: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown };
    const sub = str(claims.sub) ?? '';
    return UUID.test(sub) ? sub.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** A person to humans, never a raw party id. */
export const who = (partyId: string | undefined): string => (partyId ? `•••• ${partyId.slice(-4)}` : '');

/** Only institution admins manage the team; staff and finance read the list. */
export const canManage = (role: MyRole): boolean => role === 'admin';

export const roleKey = (r: StaffRole): CopyKey => `team.role.${r}` as CopyKey;
export const statusKey = (s: 'invited' | 'active' | 'removed'): CopyKey => `team.status.${s}` as CopyKey;
export const inviteChannelKey = (c: StaffInvite['channel']): CopyKey => `team.invite.by.${c}` as CopyKey;

export type TeamRow = { kind: 'member'; state: 'active' | 'removed'; member: TeamMember } | { kind: 'invite'; invite: StaffInvite };
export function rowsOf(team: InstitutionTeam): TeamRow[] {
  return [
    ...team.staff.map((member): TeamRow => ({ kind: 'member', state: member.active ? 'active' : 'removed', member })),
    ...team.invites.map((invite): TeamRow => ({ kind: 'invite', invite })),
  ];
}

export const grantRole = (g: Grant): StaffRole | undefined => ROLES.find((r) => g.payload['role'] === r);
export const grantPerson = (g: Grant): string | undefined => str(g.payload['partyId']);

/** Approve is a second admin's act: not the person being raised, not the admin who proposed it. */
export const canApprove = (g: Grant, me: string | undefined): boolean =>
  g.status === 'awaiting_second_approval' && !!me && !sameId(grantPerson(g), me) && !sameId(str(g.requestedBy), me);

/** The institution must keep one admin: the last active admin cannot be removed. */
export function lastAdminOf(m: TeamMember, team: InstitutionTeam): boolean {
  if (m.role !== 'admin' || !m.active) return false;
  return team.staff.filter((s) => s.active && s.role === 'admin' && !sameId(s.partyId, m.partyId)).length === 0;
}

/** The key a change goes with: the last attempt's when the change is the same, else new. */
export interface Attempt {
  change: string;
  key: string;
}
export const attemptFor = (last: Attempt | undefined, change: string, newKey: () => string): Attempt =>
  last && last.change === change ? last : { change, key: newKey() };

export interface InviteDraft {
  role: StaffRole | '';
  email: string;
  phone: string;
}
export type InviteProblem = 'role' | 'email' | 'phone' | 'either';
export type InviteBody = { role: StaffRole; email?: string; phone?: string };

/** What the invite call would accept: a role, and exactly one address. */
export function checkInvite(d: InviteDraft): { ok: true; body: InviteBody } | { ok: false; problems: InviteProblem[] } {
  const problems: InviteProblem[] = [];
  const role = ROLES.find((r) => r === d.role);
  if (!role) problems.push('role');
  const email = d.email.trim().toLowerCase();
  const phone = d.phone.trim();
  if (!!email === !!phone) problems.push('either');
  if (email && !EMAIL.test(email)) problems.push('email');
  if (phone && !PHONE.test(phone)) problems.push('phone');
  if (problems.length || !role) return { ok: false, problems };
  return { ok: true, body: { role, ...(email ? { email } : { phone }) } };
}

export type Message = { key: CopyKey; vars?: Record<string, string>; error?: boolean };
export const messageText = (m: Message, locale: Locale): string => t(m.key, locale, m.vars);

/** What the API's answer does to the screen: 403 is its own sentence, not found is a stale list, the rest is generic. */
export const errorKeyOf = (code: string): CopyKey =>
  code === 'FORBIDDEN' ? 'team.forbidden' : code === 'NOT_FOUND' ? 'team.gone' : code === 'STEP_UP_CANCELLED' ? 'team.cancelled' : 'team.error';
const err = (code: string): Message => ({ key: errorKeyOf(code), error: true });

/** A role to staff applies at once; one to finance or admin waits for a second admin. */
export const claimMessage = (r: Result<StaffChange>): Message =>
  !r.ok ? err(r.code) : r.value.grant ? { key: 'team.pending' } : { key: 'team.done.role' };
export const removeMessage = (r: Result<StaffChange>): Message => (!r.ok ? err(r.code) : { key: 'team.done.remove' });
export const inviteMessage = (r: Result<StaffInvite>): Message => (!r.ok ? err(r.code) : { key: 'team.done.invite' });
export const approveMessage = (r: Result<StaffChange>): Message => (!r.ok ? err(r.code) : { key: 'team.done.grant' });

export interface TeamDeps {
  invite(body: InviteBody, idempotencyKey: string): Promise<Result<StaffInvite>>;
  change(partyId: string, body: { role?: StaffRole; active?: false }, idempotencyKey: string): Promise<Result<StaffChange>>;
  approve(grantId: string): Promise<Result<StaffChange>>;
  stepUp(): Promise<boolean>;
  newKey(): string;
}

export type Outcome = { kind: 'invalid'; problems: InviteProblem[] } | { kind: 'done'; message: Message };

/** Sends an invite once per key, only when the draft names a role and exactly one address. */
export async function sendInvite(d: TeamDeps, draft: InviteDraft, idempotencyKey: string): Promise<Outcome> {
  const checked = checkInvite(draft);
  if (!checked.ok) return { kind: 'invalid', problems: checked.problems };
  return { kind: 'done', message: inviteMessage(await d.invite(checked.body, idempotencyKey)) };
}

/** A role change: applies at once for staff, opens a grant for finance and admin. */
export const claimRole = (d: TeamDeps, partyId: string, role: StaffRole, idempotencyKey: string): Promise<Outcome> =>
  d.change(partyId, { role }, idempotencyKey).then((r) => ({ kind: 'done' as const, message: claimMessage(r) }));

export const removeStaff = (d: TeamDeps, partyId: string, idempotencyKey: string): Promise<Outcome> =>
  d.change(partyId, { active: false }, idempotencyKey).then((r) => ({ kind: 'done' as const, message: removeMessage(r) }));

/** One passkey, then the second admin's approval; a cancelled ceremony changes nothing. */
export const approveGrant = (d: TeamDeps, grantId: string): Promise<Outcome> =>
  withStepUp(() => d.approve(grantId), d.stepUp).then((r) => ({ kind: 'done' as const, message: approveMessage(r) }));

/** Removal asks once to confirm: a first Remove only arms the question; only a deliberate confirm acts. */
export type Confirm = 'idle' | 'armed';
export function removeFlow(state: Confirm, click: 'remove' | 'confirm' | 'cancel'): Confirm | 'go' {
  if (click === 'cancel') return 'idle';
  if (click === 'confirm') return state === 'armed' ? 'go' : 'idle';
  return 'armed';
}
