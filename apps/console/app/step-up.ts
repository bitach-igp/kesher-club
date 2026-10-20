'use server';
// The step-up relay for every money action in the console (T-0610, T-0612): the API's 5-minute step-up
// token goes into an httpOnly cookie, and the money action's server action puts it on X-Step-Up. Page
// script runs the passkey ceremony and never holds the token.
import { cookies } from 'next/headers';
import type { Result } from '../src/api.ts';
import { getConfig } from '../src/config.ts';
import { asStaff } from '../src/request.ts';
import { cookieOptions, secondsUntil, STEP_UP_COOKIE } from '../src/session.ts';

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
