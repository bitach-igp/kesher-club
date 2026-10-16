// The signed-in admin, as the proxy attached it. Pages and route handlers read it from here only.
import { headers } from 'next/headers';
import { ADMIN_ROLES_HEADER, ADMIN_SUBJECT_HEADER } from '../auth/proxy.ts';
import type { AdminActor } from '../data/types.ts';

export async function currentActor(): Promise<AdminActor> {
  const h = await headers();
  const subject = h.get(ADMIN_SUBJECT_HEADER);
  if (!subject) throw new Error('No admin identity on the request: the proxy did not run');
  return { subject, roles: (h.get(ADMIN_ROLES_HEADER) ?? '').split(',').filter(Boolean) };
}

/** Route handlers answer with problem+json like the API does. */
export const problem = (status: number, code: string, detail: string): Response =>
  Response.json({ type: `https://kesher.club/problems/${code.toLowerCase()}`, title: code, status, code, detail }, { status, headers: { 'content-type': 'application/problem+json' } });
