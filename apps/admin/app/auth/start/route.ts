// Starts the OIDC authorization-code flow. State and nonce live in short, HttpOnly cookies.
import { NextResponse, type NextRequest } from 'next/server';
import { authorizationUrl, discover, NONCE_COOKIE, randomToken, RETURN_TO_COOKIE, STATE_COOKIE } from '../../../src/auth/oidc.ts';
import { getConfig } from '../../../src/config.ts';

const cookie = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/auth', maxAge: 600 };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cfg = getConfig();
  const disc = await discover(cfg.ADMIN_OIDC_ISSUER);
  const state = randomToken();
  const nonce = randomToken();
  const rt = request.nextUrl.searchParams.get('return_to');
  const returnTo = rt && rt.startsWith('/') && !rt.startsWith('//') ? rt : '/';
  const url = authorizationUrl({ authorizationEndpoint: disc.authorization_endpoint, clientId: cfg.ADMIN_OIDC_CLIENT_ID, redirectUri: `${cfg.ADMIN_BASE_URL}/auth/callback`, state, nonce });
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.set(STATE_COOKIE, state, cookie);
  res.cookies.set(NONCE_COOKIE, nonce, cookie);
  res.cookies.set(RETURN_TO_COOKIE, returnTo, cookie);
  return res;
}
