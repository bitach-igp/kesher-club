// Next.js proxy (the file Next 16 runs in front of every request; `middleware.ts` in older
// versions). Adapts NextRequest to the pure gate in src/auth/proxy.ts. Config is read at boot and
// crashes the process when anything is missing (constitution art. 6).
import { createRemoteJWKSet } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from './src/config.ts';
import { ADMIN_ROLES_HEADER, ADMIN_SUBJECT_HEADER, adminProxy } from './src/auth/proxy.ts';
import { SESSION_COOKIE } from './src/auth/session.ts';

const cfg = getConfig();
const jwks = createRemoteJWKSet(new URL(cfg.ADMIN_OIDC_JWKS_URL));

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const result = await adminProxy(
    { path: request.nextUrl.pathname, search: request.nextUrl.search, headers: request.headers, sessionCookie: request.cookies.get(SESSION_COOKIE)?.value },
    { cidrs: cfg.ADMIN_VPN_CIDRS, verifier: { jwks, issuer: cfg.ADMIN_OIDC_ISSUER, audience: cfg.ADMIN_OIDC_AUDIENCE } },
  );
  switch (result.kind) {
    case 'forbidden':
      return NextResponse.json(result.problem, { status: 403, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
    case 'redirect':
      return NextResponse.redirect(new URL(result.location, request.nextUrl.origin), { status: 303 });
    case 'next': {
      // Identity travels to the pages on request headers the proxy owns; anything the client sent is dropped.
      const headers = new Headers(request.headers);
      headers.delete(ADMIN_SUBJECT_HEADER);
      headers.delete(ADMIN_ROLES_HEADER);
      if (result.subject) headers.set(ADMIN_SUBJECT_HEADER, result.subject);
      if (result.roles.length) headers.set(ADMIN_ROLES_HEADER, result.roles.join(','));
      const res = NextResponse.next({ request: { headers } });
      res.headers.set('cache-control', 'no-store');
      res.headers.set('x-frame-options', 'DENY');
      res.headers.set('referrer-policy', 'no-referrer');
      return res;
    }
  }
}

// Next reads the matcher at build time and only from a literal; src/auth/proxy.test.ts keeps it equal to
// PROXY_MATCHER (T-0915).
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|healthz).*)'] };
