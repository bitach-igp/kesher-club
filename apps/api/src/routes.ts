// Route table: operationId → handler, matched against contracts/openapi.yaml paths. The HTTP
// binding (server.ts today, NestJS per ADR-001 when accepted) only parses the request and looks
// the handler up here; every module stays framework-free.
import type { Handler } from './http.ts';

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  operationId: string;
  /** Public routes skip the bearer requirement; the handler still sees a principal when a valid JWT is sent. */
  public?: boolean;
}

/** The contract's path table (kept in sync by a test against the YAML). */
export const ROUTES: readonly Route[] = [
  { method: 'POST', path: '/auth/otp', operationId: 'startOtp', public: true },
  { method: 'POST', path: '/auth/otp/verify', operationId: 'verifyOtp', public: true },
  { method: 'POST', path: '/auth/passkeys/register', operationId: 'registerPasskey', public: true },
  { method: 'POST', path: '/auth/passkeys/authenticate', operationId: 'authenticatePasskey', public: true },
  { method: 'POST', path: '/auth/token/refresh', operationId: 'refreshToken', public: true },
  { method: 'POST', path: '/auth/step-up', operationId: 'stepUp' },
  { method: 'GET', path: '/me/capabilities', operationId: 'getCapabilities' },
  { method: 'GET', path: '/households/{id}', operationId: 'getHousehold' },
  { method: 'POST', path: '/memberships', operationId: 'createMembership' },
  { method: 'GET', path: '/accounts', operationId: 'listAccounts' },
  { method: 'GET', path: '/accounts/{id}/transactions', operationId: 'listTransactions' },
  { method: 'POST', path: '/loads', operationId: 'createLoad' },
  { method: 'POST', path: '/transfers', operationId: 'createTransfer' },
  { method: 'POST', path: '/transfers/{id}/cancel', operationId: 'cancelTransfer' },
  { method: 'POST', path: '/fx/quotes', operationId: 'createFxQuote' },
  { method: 'POST', path: '/fx/conversions', operationId: 'convert' },
  { method: 'GET', path: '/cards/{id}', operationId: 'getCard' },
  { method: 'PATCH', path: '/cards/{id}/controls', operationId: 'updateCardControls' },
  { method: 'POST', path: '/cards/{id}/provisioning/{wallet}', operationId: 'startPushProvisioning' },
  { method: 'GET', path: '/catalogue', operationId: 'listCatalogue' },
  { method: 'POST', path: '/addon-orders', operationId: 'createAddonOrder' },
  { method: 'POST', path: '/institutions/{id}/rosters', operationId: 'importRoster' },
  { method: 'POST', path: '/institutions/{id}/allowance-runs', operationId: 'runAllowance' },
  { method: 'POST', path: '/payouts', operationId: 'createPayout' },
  { method: 'GET', path: '/agent-grants', operationId: 'listAgentGrants' },
  { method: 'DELETE', path: '/agent-grants/{id}', operationId: 'revokeAgentGrant' },
  { method: 'POST', path: '/intents/{id}/approve', operationId: 'approveIntent' },
  { method: 'POST', path: '/hooks/{provider}', operationId: 'providerWebhook', public: true },
  // Admin console (ADR-013): staff token only; the handlers refuse member and agent principals.
  { method: 'GET', path: '/admin/flags', operationId: 'listAdminFlags' },
  { method: 'POST', path: '/admin/flags/{key}/flips', operationId: 'proposeFlagFlip' },
  { method: 'POST', path: '/admin/flag-flips/{id}/approve', operationId: 'approveFlagFlip' },
  { method: 'GET', path: '/admin/bindings', operationId: 'listAdminBindings' },
  { method: 'GET', path: '/admin/audit', operationId: 'listAdminAudit' },
  { method: 'POST', path: '/admin/audit/verify', operationId: 'verifyAdminAudit' },
];

export type HandlerTable = Partial<Record<string, Handler>>;

/** Matches a method + path to a route and its path params. */
export function match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const re = new RegExp('^' + route.path.replace(/\{(\w+)\}/g, (_m, n: string) => (names.push(n), '([^/]+)')) + '$');
    const m = re.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
    return { route, params };
  }
  return undefined;
}
