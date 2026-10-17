// Shared shape for the admin's POST route handlers: resolve the actor, run, map AdminDataError.
import { AdminDataError, type AdminActor } from '../data/types.ts';
import { currentActor, problem } from './actor.ts';

const STATUS: Record<AdminDataError['code'], number> = { NOT_FOUND: 404, CONFLICT: 409, FORBIDDEN: 403, GATES_INCOMPLETE: 422, SAME_APPROVER: 422, UNAVAILABLE: 503 };

export async function adminAction(redirectTo: string, run: (by: AdminActor, now: Date) => Promise<unknown>): Promise<Response> {
  const by = await currentActor();
  try {
    await run(by, new Date());
  } catch (e) {
    if (e instanceof AdminDataError) return problem(STATUS[e.code], e.code, e.message);
    throw e;
  }
  return new Response(null, { status: 303, headers: { location: redirectTo } });
}

/** Form field as a trimmed string, or undefined. Form text is data; callers never interpret it. */
export const field = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : undefined;
};
