'use server';
// Deposits server action (T-0630): pull dollars by ACH as the signed-in finance member (the step-up relay is in
// app/step-up.ts).
import type { Result } from '../../src/api.ts';
import type { AchPull, AchPullRequest } from '../../src/deposits.ts';
import { asStaff } from '../../src/request.ts';

export async function createAchPull(body: AchPullRequest, idempotencyKey: string): Promise<Result<AchPull>> {
  return asStaff((api, id) => api.createAchPull(id, body, idempotencyKey));
}
