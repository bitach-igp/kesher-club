// The access decision behind the proxy (T-0116, REQ-AUTH-009). Pure: the proxy maps the result
// to a 403 problem, a redirect to sign-in or a pass-through with the admin identity attached.
import { isVpnIp, type Cidr } from './vpn.ts';
import type { AdminSession, SessionFailure, SessionVerdict } from './session.ts';

/** Paths that need the VPN but not a session yet (the sign-in flow itself). */
export const SSO_EXEMPT_PATHS: readonly string[] = ['/auth/sign-in', '/auth/start', '/auth/callback'];

export type SignInReason = 'no_session' | SessionFailure;

export type AccessDecision =
  | { readonly kind: 'forbidden_ip' }
  | { readonly kind: 'redirect_sign_in'; readonly reason: SignInReason }
  | { readonly kind: 'allow'; readonly session: AdminSession | undefined };

export interface AccessInput {
  readonly path: string;
  readonly clientIp: string | undefined;
  readonly sessionToken: string | undefined;
  readonly cidrs: readonly Cidr[];
  readonly verify: (token: string) => Promise<SessionVerdict>;
}

export async function decideAdminAccess(input: AccessInput): Promise<AccessDecision> {
  // 1. VPN first: nothing, not even the sign-in page, is reachable from outside (fail secure).
  if (!isVpnIp(input.clientIp, input.cidrs)) return { kind: 'forbidden_ip' };
  if (SSO_EXEMPT_PATHS.includes(input.path)) return { kind: 'allow', session: undefined };
  // 2. SSO with a phishing-resistant authenticator.
  if (!input.sessionToken) return { kind: 'redirect_sign_in', reason: 'no_session' };
  const verdict = await input.verify(input.sessionToken);
  if (!verdict.ok) return { kind: 'redirect_sign_in', reason: verdict.reason };
  return { kind: 'allow', session: verdict.session };
}

/** Copy for the sign-in page. The hardware-key reason is explicit so admins know what to fix. */
export const SIGN_IN_REASON_TEXT: Readonly<Record<SignInReason, string>> = {
  no_session: 'Sign in with your Identity Center account to continue.',
  expired: 'Your session has expired. Sign in again.',
  invalid: 'Your session could not be verified. Sign in again.',
  hardware_key_required: 'Hardware key required: sign in with a phishing-resistant method (security key or passkey).',
};
