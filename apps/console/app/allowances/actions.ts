'use server';
// I07 server actions (T-0610): preview and run as the signed-in finance member, and the step-up relay. The
// step-up token goes from the API into an httpOnly cookie for five minutes and from there onto the run's
// X-Step-Up header; page script never holds it. Errors come back as codes: server actions do not throw
// across the wire.
import { cookies } from 'next/headers';
import { codeOf, institutionApi } from '../../src/api.ts';
import type { Result, RunResult } from '../../src/allowances.ts';
import { getConfig } from '../../src/config.ts';
import { requestContext } from '../../src/request.ts';
import { cookieOptions, secondsUntil, STEP_UP_COOKIE } from '../../src/session.ts';

async function asStaff<T>(call: (api: ReturnType<typeof institutionApi>, institutionId: string) => Promise<T>): Promise<Result<T>> {
  const { landing, access } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) return { ok: false, code: 'UNAUTHENTICATED' };
  const stepUp = (await cookies()).get(STEP_UP_COOKIE)?.value;
  try {
    return { ok: true, value: await call(institutionApi(getConfig().CONSOLE_API_URL, access, stepUp), landing.institution.id) };
  } catch (e) {
    const code = codeOf(e);
    if (!code) throw e;
    return { ok: false, code };
  }
}

export async function previewAllowance(scheduleId: string, date: string): Promise<Result<RunResult>> {
  return asStaff((api, id) => api.runAllowance(id, { scheduleId, date, dryRun: true }, `preview-${crypto.randomUUID()}`));
}

/** Runs, or (for the second finance member) approves, the schedule's run for the date. */
export async function runAllowance(scheduleId: string, date: string, idempotencyKey: string): Promise<Result<RunResult>> {
  return asStaff((api, id) => api.runAllowance(id, { scheduleId, date, dryRun: false }, idempotencyKey));
}

export async function beginStepUp(): Promise<Result<unknown>> {
  return asStaff(async (api) => (await api.stepUp()).options);
}

export async function finishStepUp(response: unknown): Promise<Result<true>> {
  const r = await asStaff((api) => api.stepUp(response));
  if (!r.ok) return r;
  if (!r.value.stepUpToken || !r.value.expiresAt) return { ok: false, code: 'UNAUTHENTICATED' };
  (await cookies()).set(STEP_UP_COOKIE, r.value.stepUpToken, cookieOptions(getConfig().CONSOLE_ENVIRONMENT, secondsUntil(r.value.expiresAt, new Date())));
  return { ok: true, value: true };
}
