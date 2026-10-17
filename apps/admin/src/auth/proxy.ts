// The request-level gate (T-0116, REQ-AUTH-009), pure over a small request shape so it is tested
// without Next. `proxy.ts` at the app root adapts NextRequest to this and NextResponse from it.
import { decideAdminAccess, SSO_EXEMPT_PATHS, type SignInReason } from './guard.ts';
import { verifySession, type SessionVerdict, type SessionVerifier } from './session.ts';
import { clientIpFrom, type Cidr } from './vpn.ts';

export interface ProxyRequest {
  readonly path: string;
  readonly search?: string;
  readonly headers: { get(name: string): string | null };
  readonly sessionCookie: string | undefined;
}

export interface ProxyEnv {
  readonly cidrs: readonly Cidr[];
  readonly verifier: SessionVerifier;
  readonly now?: Date;
}

export type ProxyResult =
  | { readonly kind: 'forbidden'; readonly status: 403; readonly problem: { type: string; title: string; status: 403; code: 'FORBIDDEN'; detail: string } }
  | { readonly kind: 'redirect'; readonly location: string; readonly reason: SignInReason }
  | { readonly kind: 'next'; readonly subject: string | undefined; readonly roles: readonly string[] };

export const SIGN_IN_PATH = '/auth/sign-in';
/** Header the proxy sets for pages; never trusted from the client (the proxy strips it first). */
export const ADMIN_SUBJECT_HEADER = 'x-kesher-admin-subject';
export const ADMIN_ROLES_HEADER = 'x-kesher-admin-roles';

export async function adminProxy(req: ProxyRequest, env: ProxyEnv): Promise<ProxyResult> {
  const verify = (token: string): Promise<SessionVerdict> => verifySession(token, env.now ? { ...env.verifier, now: env.now } : env.verifier);
  const decision = await decideAdminAccess({ path: req.path, clientIp: clientIpFrom(req.headers), sessionToken: req.sessionCookie, cidrs: env.cidrs, verify });
  switch (decision.kind) {
    case 'forbidden_ip':
      // Same body for every non-VPN caller: no hint about what exists behind the proxy.
      return { kind: 'forbidden', status: 403, problem: { type: 'https://kesher.club/problems/forbidden', title: 'Forbidden', status: 403, code: 'FORBIDDEN', detail: 'The admin console is reachable only over the VPN.' } };
    case 'redirect_sign_in': {
      const returnTo = `${req.path}${req.search ?? ''}`;
      const q = new URLSearchParams({ reason: decision.reason, return_to: returnTo });
      return { kind: 'redirect', location: `${SIGN_IN_PATH}?${q.toString()}`, reason: decision.reason };
    }
    case 'allow':
      return { kind: 'next', subject: decision.session?.subject, roles: decision.session?.roles ?? [] };
  }
}

/** Paths the proxy leaves alone entirely (static assets, health). Everything else is gated, sign-in included. */
export const PROXY_MATCHER = ['/((?!_next/static|_next/image|favicon.ico|healthz).*)'];

export { SSO_EXEMPT_PATHS };
