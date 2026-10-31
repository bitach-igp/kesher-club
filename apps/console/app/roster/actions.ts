'use server';
// I04 server action (T-0639): place selected students in a cohort as the signed-in staff member.
import type { Result } from '../../src/api.ts';
import { asStaff } from '../../src/request.ts';

export async function placeInCohort(cohortId: string, memberIds: string[], idempotencyKey: string): Promise<Result<{ placed: number }>> {
  return asStaff(async (api, id) => ({ placed: (await api.placeInCohort(id, cohortId, memberIds, idempotencyKey)).placed }));
}
