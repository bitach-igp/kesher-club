// What the proxy resolved for this request (T-0608, T-0610), for server components and server actions.
import { headers } from 'next/headers';
import { localeFrom, type Locale } from './i18n.ts';
import { ACCESS_HEADER, decodeLanding, LANDING_HEADER, type Landing } from './session.ts';

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
