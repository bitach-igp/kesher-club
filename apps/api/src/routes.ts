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
  { method: 'GET', path: '/status', operationId: 'getStatus', public: true },
  { method: 'GET', path: '/me/institution', operationId: 'getMyInstitution' },
  { method: 'GET', path: '/me/preferences', operationId: 'getPreferences' },
  { method: 'PATCH', path: '/me/preferences', operationId: 'updatePreferences' },
  { method: 'GET', path: '/.well-known/oauth-authorization-server', operationId: 'getAuthorizationServerMetadata', public: true },
  { method: 'GET', path: '/oauth/jwks', operationId: 'getOAuthJwks', public: true },
  { method: 'GET', path: '/oauth/authorize', operationId: 'authorizeAgent', public: true },
  { method: 'POST', path: '/oauth/token', operationId: 'issueAgentToken', public: true },
  { method: 'GET', path: '/oauth/requests/{id}', operationId: 'getAgentConsent' },
  { method: 'POST', path: '/oauth/requests/{id}/approve', operationId: 'approveAgentConsent' },
  { method: 'POST', path: '/oauth/requests/{id}/deny', operationId: 'denyAgentConsent' },
  { method: 'GET', path: '/me/display-name', operationId: 'getDisplayName' },
  { method: 'PATCH', path: '/me/display-name', operationId: 'updateDisplayName' },
  { method: 'GET', path: '/households/{id}', operationId: 'getHousehold' },
  { method: 'POST', path: '/memberships', operationId: 'createMembership' },
  { method: 'GET', path: '/plans', operationId: 'listPlans' },
  { method: 'GET', path: '/accounts', operationId: 'listAccounts' },
  { method: 'GET', path: '/accounts/{id}/transactions', operationId: 'listTransactions' },
  { method: 'GET', path: '/me/closure', operationId: 'getClosure' },
  { method: 'POST', path: '/me/closure', operationId: 'closeAccount' },
  { method: 'GET', path: '/accounts/{id}/auto-reload', operationId: 'getAutoReload' },
  { method: 'POST', path: '/accounts/{id}/auto-reload', operationId: 'setAutoReload' },
  { method: 'POST', path: '/loads', operationId: 'createLoad' },
  { method: 'POST', path: '/transfers', operationId: 'createTransfer' },
  { method: 'POST', path: '/transfers/preview', operationId: 'previewTransfer' },
  { method: 'POST', path: '/p2p/recipients/resolve', operationId: 'resolveRecipient' },
  { method: 'POST', path: '/transfers/{id}/cancel', operationId: 'cancelTransfer' },
  { method: 'GET', path: '/requests', operationId: 'listPaymentRequests' },
  { method: 'POST', path: '/requests', operationId: 'createPaymentRequest' },
  { method: 'POST', path: '/splits', operationId: 'createSplit' },
  { method: 'POST', path: '/requests/{id}/pay', operationId: 'payPaymentRequest' },
  { method: 'POST', path: '/requests/{id}/decline', operationId: 'declinePaymentRequest' },
  { method: 'POST', path: '/requests/{id}/cancel', operationId: 'cancelPaymentRequest' },
  { method: 'POST', path: '/fx/quotes', operationId: 'createFxQuote' },
  { method: 'POST', path: '/fx/conversions', operationId: 'convert' },
  { method: 'GET', path: '/cards', operationId: 'listCards' },
  { method: 'POST', path: '/cards/physical', operationId: 'orderPhysicalCard' },
  { method: 'POST', path: '/cards/{id}/activate', operationId: 'activateCard' },
  { method: 'POST', path: '/cards/{id}/status', operationId: 'setCardStatus' },
  { method: 'POST', path: '/cards/{id}/details-token', operationId: 'cardDetailsToken' },
  { method: 'GET', path: '/cards/{id}', operationId: 'getCard' },
  { method: 'PATCH', path: '/cards/{id}/controls', operationId: 'updateCardControls' },
  { method: 'POST', path: '/cards/{id}/provisioning/{wallet}', operationId: 'startPushProvisioning' },
  { method: 'GET', path: '/catalogue', operationId: 'listCatalogue' },
  { method: 'POST', path: '/addon-orders', operationId: 'createAddonOrder' },
  { method: 'GET', path: '/invites/{token}', operationId: 'getInvite', public: true },
  { method: 'POST', path: '/invites/{token}/accept', operationId: 'acceptInvite' },
  { method: 'POST', path: '/institutions/{id}/rosters', operationId: 'importRoster' },
  { method: 'POST', path: '/institutions/{id}/fee-items', operationId: 'createFeeItems' },
  { method: 'GET', path: '/institutions/{id}/collections', operationId: 'listCollections' },
  { method: 'GET', path: '/institutions/{id}/collections/export', operationId: 'exportCollections' },
  { method: 'GET', path: '/fee-items', operationId: 'listFeeItems' },
  { method: 'POST', path: '/fee-items/{id}/pay', operationId: 'payFeeItem' },
  { method: 'GET', path: '/institutions/{id}/allowance-schedules', operationId: 'listAllowanceSchedules' },
  { method: 'POST', path: '/institutions/{id}/allowance-schedules', operationId: 'createAllowanceSchedule' },
  { method: 'GET', path: '/institutions/{id}/payouts', operationId: 'listInstitutionPayouts' },
  { method: 'POST', path: '/institutions/{id}/payouts', operationId: 'createInstitutionPayout' },
  { method: 'GET', path: '/institutions/{id}/payout-account', operationId: 'getInstitutionPayoutAccount' },
  { method: 'GET', path: '/institutions/{id}/ach-pulls', operationId: 'listInstitutionAchPulls' },
  { method: 'POST', path: '/institutions/{id}/ach-pulls', operationId: 'createInstitutionAchPull' },
  { method: 'POST', path: '/payouts/{id}/approve', operationId: 'approvePayout' },
  { method: 'POST', path: '/payouts/{id}/reject', operationId: 'rejectPayout' },
  { method: 'GET', path: '/institutions/{id}/allowance-runs', operationId: 'listAllowanceRuns' },
  { method: 'POST', path: '/institutions/{id}/allowance-runs', operationId: 'runAllowance' },
  { method: 'POST', path: '/payouts', operationId: 'createPayout' },
  { method: 'GET', path: '/agent-grants', operationId: 'listAgentGrants' },
  { method: 'DELETE', path: '/agent-grants/{id}', operationId: 'revokeAgentGrant' },
  { method: 'GET', path: '/intents', operationId: 'listIntents' },
  { method: 'GET', path: '/intents/{id}', operationId: 'getIntent' },
  { method: 'POST', path: '/intents/{id}/approve', operationId: 'approveIntent' },
  { method: 'POST', path: '/intents/{id}/decline', operationId: 'declineIntent' },
  { method: 'POST', path: '/hooks/{provider}', operationId: 'providerWebhook', public: true },
  { method: 'POST', path: '/jit/card-authorizations', operationId: 'cardAuthorization', public: true },
  // Admin console (ADR-013): staff token only; the handlers refuse member and agent principals.
  { method: 'POST', path: '/kyc/sessions', operationId: 'startKycSession' },
  { method: 'GET', path: '/kyc/status', operationId: 'getKycStatus' },
  { method: 'GET', path: '/admin/flags', operationId: 'listAdminFlags' },
  { method: 'POST', path: '/admin/flags/{key}/flips', operationId: 'proposeFlagFlip' },
  { method: 'POST', path: '/admin/flag-flips/{id}/approve', operationId: 'approveFlagFlip' },
  { method: 'GET', path: '/admin/institutions', operationId: 'listAdminInstitutions' },
  { method: 'POST', path: '/admin/institutions', operationId: 'createAdminInstitution' },
  { method: 'GET', path: '/admin/institutions/{id}/deposits', operationId: 'listAdminInstitutionDeposits' },
  { method: 'POST', path: '/admin/institutions/{id}/deposits', operationId: 'recordAdminInstitutionDeposit' },
  { method: 'POST', path: '/admin/deposits/{id}/approve', operationId: 'approveAdminDeposit' },
  { method: 'POST', path: '/admin/deposits/{id}/reject', operationId: 'rejectAdminDeposit' },
  { method: 'GET', path: '/admin/institutions/{id}/staff', operationId: 'listAdminInstitutionStaff' },
  { method: 'POST', path: '/admin/institutions/{id}/staff', operationId: 'assignAdminInstitutionStaff' },
  { method: 'POST', path: '/admin/institutions/{id}/staff/{partyId}/remove', operationId: 'removeAdminInstitutionStaff' },
  { method: 'POST', path: '/admin/staff-grants/{id}/approve', operationId: 'approveAdminStaffGrant' },
  { method: 'GET', path: '/admin/institutions/{id}/credit-limits', operationId: 'listAdminCreditLimits' },
  { method: 'POST', path: '/admin/institutions/{id}/credit-limits', operationId: 'proposeAdminCreditLimit' },
  { method: 'POST', path: '/admin/credit-limits/{id}/approve', operationId: 'approveAdminCreditLimit' },
  { method: 'GET', path: '/admin/institutions/{id}/kyb', operationId: 'getAdminInstitutionKyb' },
  { method: 'POST', path: '/admin/institutions/{id}/kyb/people', operationId: 'addAdminKybPerson' },
  { method: 'POST', path: '/admin/institutions/{id}/kyb/checks', operationId: 'recordAdminKybCheck' },
  { method: 'POST', path: '/admin/institutions/{id}/kyb/run', operationId: 'runAdminKybChecks' },
  { method: 'POST', path: '/admin/kyb/checks/{id}/dispose', operationId: 'disposeAdminKybCheck' },
  { method: 'POST', path: '/admin/institutions/{id}/kyb/decisions', operationId: 'decideAdminKyb' },
  { method: 'POST', path: '/admin/kyb/decisions/{id}/approve', operationId: 'approveAdminKybDecision' },
  { method: 'GET', path: '/admin/institutions/{id}/payout-accounts', operationId: 'listAdminPayoutAccounts' },
  { method: 'POST', path: '/admin/institutions/{id}/payout-accounts', operationId: 'recordAdminPayoutAccount' },
  { method: 'POST', path: '/admin/payout-accounts/{id}/approve', operationId: 'approveAdminPayoutAccount' },
  { method: 'GET', path: '/admin/bindings', operationId: 'listAdminBindings' },
  { method: 'GET', path: '/admin/audit', operationId: 'listAdminAudit' },
  { method: 'GET', path: '/admin/customers', operationId: 'listAdminCustomers' },
  { method: 'GET', path: '/admin/customers/{id}', operationId: 'getAdminCustomer' },
  { method: 'GET', path: '/admin/complaints', operationId: 'listAdminComplaints' },
  { method: 'POST', path: '/admin/complaints', operationId: 'openAdminComplaint' },
  { method: 'POST', path: '/admin/complaints/{id}/acknowledge', operationId: 'acknowledgeAdminComplaint' },
  { method: 'POST', path: '/admin/complaints/{id}/resolve', operationId: 'resolveAdminComplaint' },
  { method: 'GET', path: '/admin/cases', operationId: 'listAdminCases' },
  { method: 'GET', path: '/admin/cases/{id}', operationId: 'getAdminCase' },
  { method: 'POST', path: '/admin/cases/{id}/assign', operationId: 'assignAdminCase' },
  { method: 'POST', path: '/admin/cases/{id}/decisions', operationId: 'decideAdminCase' },
  { method: 'GET', path: '/admin/alerts', operationId: 'listAdminAlerts' },
  { method: 'POST', path: '/admin/alerts/{id}/decisions', operationId: 'decideAdminAlert' },
  { method: 'POST', path: '/admin/audit/verify', operationId: 'verifyAdminAudit' },
  { method: 'GET', path: '/admin/fx/rates', operationId: 'listAdminFxRates' },
  { method: 'POST', path: '/admin/fx/rates', operationId: 'proposeAdminFxRate' },
  { method: 'POST', path: '/admin/fx/rates/{id}/approve', operationId: 'approveAdminFxRate' },
  { method: 'POST', path: '/admin/fx/rates/{id}/reject', operationId: 'rejectAdminFxRate' },
  { method: 'GET', path: '/admin/price-rules', operationId: 'listAdminPriceRules' },
  { method: 'POST', path: '/admin/price-rules', operationId: 'proposeAdminPriceRule' },
  { method: 'POST', path: '/admin/price-rules/{id}/approve', operationId: 'approveAdminPriceRule' },
  { method: 'POST', path: '/admin/price-rules/{id}/reject', operationId: 'rejectAdminPriceRule' },
  { method: 'GET', path: '/admin/plans', operationId: 'listAdminPlans' },
  { method: 'POST', path: '/admin/plans', operationId: 'proposeAdminPlanVersion' },
  { method: 'POST', path: '/admin/plans/{code}/versions/{version}/approve', operationId: 'approveAdminPlanVersion' },
  { method: 'POST', path: '/admin/plans/{code}/versions/{version}/reject', operationId: 'rejectAdminPlanVersion' },
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
