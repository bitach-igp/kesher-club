'use server';
// I03 server action (T-0637): create a cohort as the signed-in staff member, with the browser's key.
import type { Result } from '../../src/api.ts';
import type { Cohort } from '../../src/cohorts.ts';
import { asStaff } from '../../src/request.ts';

export async function createCohort(body: { name: string; startsOn: string; endsOn: string }, idempotencyKey: string): Promise<Result<Cohort>> {
  return asStaff((api, id) => api.createCohort(id, body, idempotencyKey));
}
