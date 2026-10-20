// What the proxy resolved for this request (T-0608, T-0610), for server components and server actions.
import { cookies, headers } from 'next/headers';
import { codeOf, institutionApi, type Result } from './api.ts';
import { getConfig } from './config.ts';
import { localeFrom, type Locale } from './i18n.ts';
import { ACCESS_HEADER, decodeLanding, LANDING_HEADER, STEP_UP_COOKIE, type Landing } from './session.ts';


export interface RequestContext {
  landing: Landing;
  /** The access token the proxy resolved; absent when signed out or without institution access. */
  access: string | undefined;
  locale: Locale;
}

export async function requestContext(): Promise<RequestContext> {
  const h = await headers();
  return { landing: decodeLanding(h.get(LANDING_HEADER)), access: h.get(ACCESS_HEADER) ?? undefined, locale: localeFrom(h.get('accept-language')) };
}

/** Runs `call` as the signed-in staff member for their own institution, with the step-up cookie when there is one. */
export async function asStaff<T>(call: (api: ReturnType<typeof institutionApi>, institutionId: string) => Promise<T>): Promise<Result<T>> {
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
