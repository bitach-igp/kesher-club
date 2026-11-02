// T-0644 I11 (TST-INS-020 at the screen): a role change to finance or admin reads "Waiting for a second admin";
// an admin cannot approve their own request; removal asks once to confirm; a retry keeps its key; the invite draft
// needs a role and exactly one address; 403 reads as a sentence; the last admin stays.
import { describe, expect, it } from 'vitest';
import type { Schemas } from '@kesher/sdk';
import { COPY } from './i18n.ts';
import {
  attemptFor,
  canApprove,
  canManage,
  checkInvite,
  claimMessage,
  errorKeyOf,
  grantPerson,
  grantRole,
  inviteMessage,
  lastAdminOf,
  messageText,
  partyIdOf,
  removeFlow,
  roleKey,
  statusKey,
  who,
  type StaffChange,
} from './team.ts';

const RIVKA = '01990a52-0000-7000-8000-0000000001a1';
const DOV = '01990a52-0000-7000-8000-0000000002d2';
const YITZCHAK = '01990a52-0000-7000-8000-0000000003a3';

const grant: Schemas['ApprovalRequest'] = {
  id: '01990a52-0000-7000-8000-0000000004g4',
  kind: 'staff_grant',
  status: 'awaiting_second_approval',
  approvals: 1,
  subject: 'staff:ohr:dov:finance',
  requestedBy: RIVKA,
  expiresAt: '2026-11-09T00:00:00.000Z',
  payload: { institutionId: '01990a52-0000-7000-8000-0000000000i0', partyId: DOV, role: 'finance', reason: 'Raised to finance' },
};
const dov: Schemas['TeamMember'] = { partyId: DOV, role: 'staff', active: true, since: '2026-11-01T00:00:00.000Z' };
const ok = (value: StaffChange): { ok: true; value: StaffChange } => ({ ok: true, value });
const invite: Schemas['StaffInvite'] = { id: '01990a52-0000-7000-8000-0000000005v5', role: 'staff', channel: 'email', sentAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z' };

const token = (sub: string): string => `a.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.c`;

describe('T-0644 I11 team and roles', () => {
  it('a role change to finance or admin reads "Waiting for a second admin"; one to staff reads as done', () => {
    for (const role of ['finance', 'admin'] as const) {
      const raised = { ...grant, payload: { ...grant.payload, role } };
      expect(messageText(claimMessage(ok({ staff: dov, grant: raised })), 'en')).toBe('Waiting for a second admin.');
      expect(messageText(claimMessage(ok({ staff: dov, grant: raised })), 'he')).toMatch(/מנהל נוסף/);
    }
    expect(messageText(claimMessage(ok({ staff: dov })), 'en')).toBe('The role changed.');
    expect(messageText(inviteMessage({ ok: true, value: invite }), 'en')).toBe('The invite is on its way.');
  });

  it('an admin cannot approve their own request: not as the proposer, not as the person raised', () => {
    expect(canApprove(grant, RIVKA)).toBe(false);
    expect(canApprove(grant, DOV)).toBe(false);
    expect(canApprove(grant, YITZCHAK)).toBe(true);
    expect(canApprove(grant, undefined)).toBe(false);
    expect(canApprove({ ...grant, status: 'approved' }, YITZCHAK)).toBe(false);
    expect(grantPerson(grant)).toBe(DOV);
    expect(grantRole(grant)).toBe('finance');
    expect(partyIdOf(token(DOV))).toBe(DOV);
    expect(partyIdOf(token('not-a-party'))).toBeUndefined();
    expect(partyIdOf('junk')).toBeUndefined();
  });

  it('removal asks once to confirm: a first click arms, only a deliberate confirm acts, a cancel lets go', () => {
    expect(removeFlow('idle', 'remove')).toBe('armed');
    expect(removeFlow('armed', 'remove')).toBe('armed');
    expect(removeFlow('armed', 'confirm')).toBe('go');
    expect(removeFlow('armed', 'cancel')).toBe('idle');
    expect(removeFlow('idle', 'confirm')).toBe('idle');
  });

  it('a retry keeps its key; a different change takes a new one', () => {
    let n = 0;
    const next = () => `key-${++n}-0000`;
    const change = JSON.stringify([DOV, 'finance']);
    const last = attemptFor(undefined, change, next);
    expect(attemptFor(last, change, next).key).toBe(last.key);
    expect(attemptFor(last, JSON.stringify([DOV, 'admin']), next).key).toBe('key-2-0000');
    expect(attemptFor(last, JSON.stringify('remove'), next).key).toBe('key-3-0000');
  });

  it('the invite draft needs a role and exactly one address', () => {
    expect(checkInvite({ role: '', email: '', phone: '' })).toEqual({ ok: false, problems: ['role', 'either'] });
    expect(checkInvite({ role: 'staff', email: 'Dov@Ohr.example', phone: '' })).toEqual({ ok: true, body: { role: 'staff', email: 'dov@ohr.example' } });
    expect(checkInvite({ role: 'staff', email: ' dov@ohr.example ', phone: '+972526112233' })).toEqual({ ok: false, problems: ['either'] });
    expect(checkInvite({ role: 'finance', email: 'not-an-email', phone: '' })).toEqual({ ok: false, problems: ['email'] });
    expect(checkInvite({ role: 'admin', email: '', phone: '0526112233' })).toEqual({ ok: false, problems: ['phone'] });
  });

  it('403 reads as a sentence, in both locales, as do the other refusals', () => {
    expect(errorKeyOf('FORBIDDEN')).toBe('team.forbidden');
    expect(errorKeyOf('NOT_FOUND')).toBe('team.gone');
    expect(errorKeyOf('SOMETHING_ELSE')).toBe('team.error');
    for (const locale of ['en', 'he'] as const)
      for (const code of ['FORBIDDEN', 'NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'STEP_UP_CANCELLED', 'INTERNAL'])
        expect(COPY[locale][errorKeyOf(code)]).toMatch(/[.]$/);
    expect(who(DOV)).toBe(`•••• ${DOV.slice(-4)}`);
    expect(who(undefined)).toBe('');
  });

  it('the roles, states and the person line exist as copy; only an admin manages', () => {
    expect(roleKey('admin')).toBe('team.role.admin');
    expect(statusKey('invited')).toBe('team.status.invited');
    expect(COPY.he['team.status.awaiting_second_approval']).toMatch(/מנהל/);
    expect(canManage('admin')).toBe(true);
    for (const role of ['staff', 'finance'] as const) expect(canManage(role)).toBe(false);
  });

  it('the institution keeps one admin: the last one cannot be removed', () => {
    const rivka = { partyId: RIVKA, role: 'admin' as const, active: true, since: '' };
    const team = { staff: [rivka, dov], invites: [], pendingGrants: [] };
    expect(lastAdminOf(rivka, team)).toBe(true);
    expect(lastAdminOf({ ...rivka, partyId: YITZCHAK }, { ...team, staff: [rivka, { ...rivka, partyId: YITZCHAK }] })).toBe(false);
  });
});
