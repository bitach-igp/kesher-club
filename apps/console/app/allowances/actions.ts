'use server';
// I07 server actions (T-0610): preview and run as the signed-in finance member (the step-up relay is in
// app/step-up.ts). Errors come back as codes: server actions do not throw across the wire.
import type { Result, RunResult } from '../../src/allowances.ts';
import { asStaff } from '../../src/request.ts';

export async function previewAllowance(scheduleId: string, date: string): Promise<Result<RunResult>> {
  return asStaff((api, id) => api.runAllowance(id, { scheduleId, date, dryRun: true }, `preview-${crypto.randomUUID()}`));
}

/** Runs, or (for the second finance member) approves, the schedule's run for the date. */
export async function runAllowance(scheduleId: string, date: string, idempotencyKey: string): Promise<Result<RunResult>> {
  return asStaff((api, id) => api.runAllowance(id, { scheduleId, date, dryRun: false }, idempotencyKey));
}
