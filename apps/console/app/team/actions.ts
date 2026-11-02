'use server';
// I11 server actions (T-0644): invite, change and approve run as the signed-in staff member of their institution.
// Each write refuses a non-admin before it reaches the API, so the screen's rule holds even for a direct call.
import type { Schemas } from '@kesher/sdk';
import type { Result } from '../../src/api.ts';
import { asStaff, requestContext } from '../../src/request.ts';
import { canManage } from '../../src/team.ts';

export type InviteBody = { role: 'staff' | 'finance' | 'admin'; email?: string; phone?: string };
export type ChangeBody = { role?: 'staff' | 'finance' | 'admin'; active?: false };

async function refuseNonAdmin(): Promise<Result<never> | undefined> {
  const { landing } = await requestContext();
  if (landing.kind !== 'dashboard') return { ok: false, code: 'UNAUTHENTICATED' };
  return canManage(landing.role) ? undefined : { ok: false, code: 'FORBIDDEN' };
}

export async function createStaffInvite(body: InviteBody, idempotencyKey: string): Promise<Result<Schemas['StaffInvite']>> {
  const refused = await refuseNonAdmin();
  if (refused) return refused;
  return asStaff((api, id) => api.inviteStaff(id, body, idempotencyKey));
}

export async function changeStaff(partyId: string, body: ChangeBody, idempotencyKey: string): Promise<Result<Schemas['StaffChange']>> {
  const refused = await refuseNonAdmin();
  if (refused) return refused;
  return asStaff((api, id) => api.changeStaff(id, partyId, body, idempotencyKey));
}

export async function approveStaffGrant(grantId: string): Promise<Result<Schemas['StaffChange']>> {
  const refused = await refuseNonAdmin();
  if (refused) return refused;
  return asStaff((api, id) => api.approveStaffGrant(id, grantId));
}
