'use server';
// I01 server actions (T-0633): each call goes to the API as the signed-in person themselves, with their own
// token; an applicant has no institution role yet. The keys come from the browser, which keeps each one until
// its write lands.
import { codeOf, memberApi, problemsOf } from '../../src/api.ts';
import type { Application, ApplicationRequest, PersonRole } from '../../src/apply.ts';
import { getConfig } from '../../src/config.ts';
import { requestContext } from '../../src/request.ts';

export type ApplyResult = { ok: true; value: Application } | { ok: false; code: string; problems?: string[] };

async function asApplicant(call: (api: ReturnType<typeof memberApi>) => Promise<Application>): Promise<ApplyResult> {
  const { landing, access } = await requestContext();
  if (landing.kind === 'signed_out' || !access) return { ok: false, code: 'UNAUTHENTICATED' };
  try {
    return { ok: true, value: await call(memberApi(getConfig().CONSOLE_API_URL, access)) };
  } catch (e) {
    const code = codeOf(e);
    if (!code) throw e;
    const problems = problemsOf(e);
    return { ok: false, code, ...(problems ? { problems } : {}) };
  }
}

export async function createApplication(body: ApplicationRequest, idempotencyKey: string): Promise<ApplyResult> {
  return asApplicant((api) => api.createApplication(body, idempotencyKey));
}

export async function addSignatory(id: string, body: { fullName: string; roles: PersonRole[]; self?: boolean }, idempotencyKey: string): Promise<ApplyResult> {
  return asApplicant((api) => api.addSignatory(id, body, idempotencyKey));
}

export async function proposeAccount(id: string, body: { holderName: string; iban?: string; routingNumber?: string; accountNumber?: string }): Promise<ApplyResult> {
  return asApplicant((api) => api.proposeAccount(id, body));
}

export async function submitApplication(id: string): Promise<ApplyResult> {
  return asApplicant((api) => api.submitApplication(id));
}
