// A money action with its step-up (T-0610, T-0612, REQ-AUTH-006): try it; when the API asks for a fresh
// passkey, run the ceremony once and try again with the same attempt (the caller keeps the key). A
// cancelled or failed ceremony moves nothing and says so.
import type { Result } from './api.ts';

export async function withStepUp<T>(attempt: () => Promise<Result<T>>, stepUp: () => Promise<boolean>): Promise<Result<T>> {
  const first = await attempt();
  if (first.ok || first.code !== 'STEP_UP_REQUIRED') return first;
  if (!(await stepUp())) return { ok: false, code: 'STEP_UP_CANCELLED' };
  return attempt();
}
