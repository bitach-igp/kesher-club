'use server';
// I09 server actions (T-0612): pay out of the institution's account, and the second finance member's
// approve or reject, as the signed-in staff member (the step-up relay is in app/step-up.ts).
import type { Result } from '../../src/api.ts';
import type { InstitutionPayout, PayoutRequest } from '../../src/payouts.ts';
import { asStaff } from '../../src/request.ts';

export async function createPayout(body: PayoutRequest, idempotencyKey: string): Promise<Result<InstitutionPayout>> {
  return asStaff((api, id) => api.createPayout(id, body, idempotencyKey));
}

export async function approvePayout(payoutId: string, idempotencyKey: string): Promise<Result<InstitutionPayout>> {
  return asStaff((api) => api.approvePayout(payoutId, idempotencyKey));
}

export async function rejectPayout(payoutId: string, reason: string, idempotencyKey: string): Promise<Result<InstitutionPayout>> {
  return asStaff((api) => api.rejectPayout(payoutId, reason, idempotencyKey));
}
