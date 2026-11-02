'use server';
// I11 server actions (T-0644): invite, change and approve run as the signed-in staff member of their institution.
import type { Schemas } from '@kesher/sdk';
import type { Result } from '../../src/api.ts';
import { asStaff } from '../../src/request.ts';

export type InviteBody = { role: 'staff' | 'finance' | 'admin'; email?: string; phone?: string };
export type ChangeBody = { role?: 'staff' | 'finance' | 'admin'; active?: false };

export async function createStaffInvite(body: InviteBody, idempotencyKey: string): Promise<Result<Schemas['StaffInvite']>> {
  return asStaff((api, id) => api.inviteStaff(id, body, idempotencyKey));
}

export async function changeStaff(partyId: string, body: ChangeBody, idempotencyKey: string): Promise<Result<Schemas['StaffChange']>> {
  return asStaff((api, id) => api.changeStaff(id, partyId, body, idempotencyKey));
}

export async function approveStaffGrant(grantId: string): Promise<Result<Schemas['StaffChange']>> {
  return asStaff((api, id) => api.approveStaffGrant(id, grantId));
}
