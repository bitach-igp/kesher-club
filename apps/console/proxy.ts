// Next.js proxy (T-0608): resolves the session before any page renders. Signed out goes to /sign-in; a
// refreshed pair is written back; the landing reaches the pages on a header only this proxy sets.
// Config is read at boot and crashes the process when anything is missing (constitution art. 6).
import { NextResponse, type NextRequest } from 'next/server';
import { consoleApi } from './src/api.ts';
import { getConfig } from './src/config.ts';
import { ACCESS_COOKIE, cookieWrites, DEVICE_COOKIE, encodeLanding, LANDING_HEADER, REFRESH_COOKIE, resolveSession } from './src/session.ts';

const cfg = getConfig();
const api = consoleApi(cfg.CONSOLE_API_URL);

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const { landing, write } = await resolveSession(api, {
    access: request.cookies.get(ACCESS_COOKIE)?.value,
    refresh: request.cookies.get(REFRESH_COOKIE)?.value,
    device: request.cookies.get(DEVICE_COOKIE)?.value,
  });
  let res: NextResponse;
  if (landing.kind === 'signed_out') {
    res = NextResponse.redirect(new URL('/sign-in', request.nextUrl.origin), { status: 303 });
  } else {
    const headers = new Headers(request.headers);
    headers.set(LANDING_HEADER, encodeLanding(landing));
    res = NextResponse.next({ request: { headers } });
  }
  for (const c of cookieWrites(write, cfg.CONSOLE_ENVIRONMENT, new Date())) res.cookies.set(c.name, c.value, c.options);
  res.headers.set('cache-control', 'no-store');
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
}

// Every page but sign-in (and its server actions) and Next's own assets.
export const config = { matcher: ['/((?!sign-in|_next/|favicon.ico).*)'] };
