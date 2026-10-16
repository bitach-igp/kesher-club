// OIDC callback: checks state, exchanges the code, verifies the ID token (issuer, audience,
// nonce, phishing-resistant amr) and sets the session cookie. Tokens are never logged.
import { createRemoteJWKSet } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { discover, exchangeCode, NONCE_COOKIE, RETURN_TO_COOKIE, STATE_COOKIE } from '../../../src/auth/oidc.ts';
import { SESSION_COOKIE, verifySession } from '../../../src/auth/session.ts';
import { getConfig } from '../../../src/config.ts';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cfg = getConfig();
  const q = request.nextUrl.searchParams;
  const state = request.cookies.get(STATE_COOKIE)?.value;
  const nonce = request.cookies.get(NONCE_COOKIE)?.value;
  const returnTo = request.cookies.get(RETURN_TO_COOKIE)?.value ?? '/';
  const signIn = (reason: string) => NextResponse.redirect(new URL(`/auth/sign-in?${new URLSearchParams({ reason, return_to: returnTo })}`, cfg.ADMIN_BASE_URL), { status: 303 });
  const code = q.get('code');
  if (!code || !state || !nonce || q.get('state') !== state) return signIn('invalid');
  const disc = await discover(cfg.ADMIN_OIDC_ISSUER);
  let idToken: string;
  try {
    ({ idToken } = await exchangeCode({ tokenEndpoint: disc.token_endpoint, code, redirectUri: `${cfg.ADMIN_BASE_URL}/auth/callback`, clientId: cfg.ADMIN_OIDC_CLIENT_ID, clientSecret: cfg.ADMIN_OIDC_CLIENT_SECRET }));
  } catch {
    return signIn('invalid');
  }
  const verdict = await verifySession(idToken, { jwks: createRemoteJWKSet(new URL(cfg.ADMIN_OIDC_JWKS_URL)), issuer: cfg.ADMIN_OIDC_ISSUER, audience: cfg.ADMIN_OIDC_AUDIENCE, nonce });
  if (!verdict.ok) return signIn(verdict.reason);
  const res = NextResponse.redirect(new URL(returnTo, cfg.ADMIN_BASE_URL), { status: 303 });
  const maxAge = Math.max(60, Math.floor((verdict.session.expiresAt.getTime() - Date.now()) / 1000));
  res.cookies.set(SESSION_COOKIE, idToken, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge });
  for (const c of [STATE_COOKIE, NONCE_COOKIE, RETURN_TO_COOKIE]) res.cookies.set(c, '', { path: '/auth', maxAge: 0 });
  return res;
}
