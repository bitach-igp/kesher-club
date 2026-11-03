// The console's server-side API calls (T-0608). The browser never holds a token: the console's server
// relays the passkey ceremony, keeps the pair in httpOnly cookies and calls the API with them.
import { ApiError, createClient, type Schemas } from '@kesher/sdk';

export type MyInstitution = Schemas['MyInstitution'];

/** A server action's answer: the API's body, or its error code. Server actions do not throw across the wire. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string };
export type TokenPair = Schemas['TokenPair'];

/** What the session needs from the API; tests pass a fake. */
export interface ConsoleApi {
  myInstitution(accessToken: string): Promise<MyInstitution>;
  refresh(refreshToken: string, deviceId: string): Promise<TokenPair>;
}

export interface SignInApi {
  /** Without a response: the discoverable-credential options. With one: the pair, once verified. */
  authenticate(deviceId: string, response?: unknown): Promise<{ options?: unknown; tokens?: TokenPair }>;
}

export function consoleApi(baseUrl: string, fetchImpl?: typeof fetch): ConsoleApi & SignInApi {
  const client = (token?: string) => createClient({ baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(token ? { getAccessToken: () => token } : {}) });
  return {
    myInstitution: (accessToken) => client(accessToken).get('/me/institution'),
    refresh: (refreshToken, deviceId) => client(refreshToken).post('/auth/token/refresh', { body: { deviceId } }),
    async authenticate(deviceId, response) {
      const r = await client().post('/auth/passkeys/authenticate', { body: { deviceId, ...(response ? { response: response as Record<string, never> } : {}) } });
      return { ...(r.options ? { options: r.options } : {}), ...(r.tokens ? { tokens: r.tokens } : {}) };
    },
  };
}

/** The browser's address as this server's own proxy saw it: the last X-Forwarded-For entry (one internet-facing hop in front of the console). */
export const browserIp = (forwardedFor: string | null): string | undefined => {
  const last = (forwardedFor ?? '').split(',').pop()?.trim();
  return last && /^[0-9a-f.:]{3,45}$/i.test(last) ? last : undefined;
};

export const statusOf = (e: unknown): number | undefined => (e instanceof ApiError ? e.status : undefined);

/** The API as the signed-in staff member, for pages and server actions; the step-up token comes from its httpOnly cookie. */
export function institutionApi(baseUrl: string, accessToken: string, stepUpToken?: string, opts: { clientIp?: string; fetch?: typeof fetch } = {}) {
  const base = opts.fetch ?? fetch;
  // The API reads the person's address from the last X-Forwarded-For entry (the bank's application form wants it): the console's server forwards the browser's.
  const forwarding: typeof fetch | undefined = opts.clientIp ? (input, init) => base(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'x-forwarded-for': opts.clientIp! } }) : opts.fetch;
  const c = createClient({
    baseUrl,
    ...(forwarding ? { fetch: forwarding } : {}),
    getAccessToken: () => accessToken,
    // A preview sends an empty header and the API ignores it; a run without a fresh token answers STEP_UP_REQUIRED.
    getStepUpToken: () => stepUpToken ?? '',
    newIdempotencyKey: () => {
      throw new Error('Every console call that takes an idempotency key names it');
    },
  });
  return {
    schedules: (id: string) => c.get('/institutions/{id}/allowance-schedules', { path: { id } }),
    createSchedule: (id: string, body: Schemas['AllowanceScheduleRequest'], idempotencyKey: string) => c.post('/institutions/{id}/allowance-schedules', { path: { id }, body, idempotencyKey }),
    runs: (id: string) => c.get('/institutions/{id}/allowance-runs', { path: { id } }),
    runAllowance: (id: string, body: Schemas['AllowanceRunRequest'], idempotencyKey: string) => c.post('/institutions/{id}/allowance-runs', { path: { id }, body, idempotencyKey }),
    stepUp: (response?: unknown) => c.post('/auth/step-up', { body: response ? { response: response as Record<string, never> } : {} }),
    collections: (id: string, month: string) => c.get('/institutions/{id}/collections', { path: { id }, query: { month } }),
    billMembers: (id: string, body: Schemas['FeeBillRequest'], idempotencyKey: string) => c.post('/institutions/{id}/fee-items', { path: { id }, body, idempotencyKey }),
    exportCollections: (id: string, month: string, format: 'csv' | 'xlsx') => c.get('/institutions/{id}/collections/export', { path: { id }, query: { month, format } }),
    payouts: (id: string, cursor?: string) => c.get('/institutions/{id}/payouts', { path: { id }, query: cursor ? { cursor } : {} }),
    payoutAccount: (id: string) => c.get('/institutions/{id}/payout-account', { path: { id } }),
    createPayout: (id: string, body: Schemas['InstitutionPayoutRequest'], idempotencyKey: string) => c.post('/institutions/{id}/payouts', { path: { id }, body, idempotencyKey }),
    approvePayout: (id: string, idempotencyKey: string) => c.post('/payouts/{id}/approve', { path: { id }, idempotencyKey }),
    rejectPayout: (id: string, reason: string, idempotencyKey: string) => c.post('/payouts/{id}/reject', { path: { id }, body: { reason }, idempotencyKey }),
    achPulls: (id: string) => c.get('/institutions/{id}/ach-pulls', { path: { id } }),
    dashboard: (id: string) => c.get('/institutions/{id}/dashboard', { path: { id } }),
    cohorts: (id: string) => c.get('/institutions/{id}/cohorts', { path: { id } }),
    statement: (id: string, month: string, currency: 'ILS' | 'USD') => c.get('/institutions/{id}/statement', { path: { id }, query: { month, currency } }),
    exportStatement: (id: string, month: string, currency: 'ILS' | 'USD', format: 'csv' | 'xlsx') => c.get('/institutions/{id}/statement/export', { path: { id }, query: { month, currency, format } }),
    student: (id: string, memberId: string) => c.get('/institutions/{id}/members/{memberId}', { path: { id, memberId } }),
    roster: (id: string, query: { status?: 'invited' | 'verified' | 'active' | 'declined' | 'removed'; cohort?: string; cursor?: string }) => c.get('/institutions/{id}/members', { path: { id }, query }),
    placeInCohort: (id: string, cohortId: string, memberIds: string[], idempotencyKey: string) => c.post('/institutions/{id}/cohorts/{cohortId}/members', { path: { id, cohortId }, body: { memberIds }, idempotencyKey }),
    importRoster: (id: string, body: Schemas['RosterImportRequest'], idempotencyKey: string) => c.post('/institutions/{id}/rosters', { path: { id }, body, idempotencyKey }),
    createCohort: (id: string, body: { name: string; startsOn: string; endsOn: string }, idempotencyKey: string) => c.post('/institutions/{id}/cohorts', { path: { id }, body, idempotencyKey }),
    createAchPull: (id: string, body: Schemas['InstitutionAchPullRequest'], idempotencyKey: string) => c.post('/institutions/{id}/ach-pulls', { path: { id }, body, idempotencyKey }),
    usBanking: (id: string) => c.get('/institutions/{id}/us-banking', { path: { id } }),
    startUsBanking: (id: string, body: { holder: 'platform' | 'institution'; usEntity?: { legalName: string; ein: string } }, idempotencyKey: string) => c.post('/institutions/{id}/us-banking', { path: { id }, body, idempotencyKey }),
    usFunding: (id: string) => c.get('/institutions/{id}/us-funding', { path: { id } }),
    quoteUsFunding: (id: string, amount: Schemas['Money']) => c.post('/institutions/{id}/us-funding/quote', { path: { id }, body: { amount } }),
    requestUsFunding: (id: string, quoteId: string, idempotencyKey: string) => c.post('/institutions/{id}/us-funding', { path: { id }, body: { quoteId }, idempotencyKey }),
    approveUsFunding: (id: string, requestId: string) => c.post('/institutions/{id}/us-funding/{requestId}/approve', { path: { id, requestId } }),
    cancelUsFunding: (id: string, requestId: string) => c.post('/institutions/{id}/us-funding/{requestId}/cancel', { path: { id, requestId } }),
    team: (id: string) => c.get('/institutions/{id}/team', { path: { id } }),
    inviteStaff: (id: string, body: { role: 'staff' | 'finance' | 'admin'; email?: string; phone?: string }, idempotencyKey: string) =>
      c.post('/institutions/{id}/staff-invites', { path: { id }, body, idempotencyKey }),
    changeStaff: (id: string, partyId: string, body: { role?: 'staff' | 'finance' | 'admin'; active?: false }, idempotencyKey: string) =>
      c.patch('/institutions/{id}/team/{partyId}', { path: { id, partyId }, body, idempotencyKey }),
    approveStaffGrant: (id: string, grantId: string) => c.post('/institutions/{id}/staff-grants/{grantId}/approve', { path: { id, grantId } }),
  };
}

/**
 * The API as the signed-in person themselves, for I01 (T-0633): someone with no institution yet applies with
 * their member token. Nothing here reaches institution data.
 */
export function memberApi(baseUrl: string, accessToken: string) {
  const c = createClient({
    baseUrl,
    getAccessToken: () => accessToken,
    newIdempotencyKey: () => {
      throw new Error('Every console call that takes an idempotency key names it');
    },
  });
  return {
    capabilities: () => c.get('/me/capabilities'),
    myApplication: () => c.get('/me/institution-application'),
    createApplication: (body: Schemas['InstitutionApplicationRequest'], idempotencyKey: string) => c.post('/institution-applications', { body, idempotencyKey }),
    addSignatory: (id: string, body: { fullName: string; roles: ('board' | 'control' | 'signatory')[]; self?: boolean }, idempotencyKey: string) => c.post('/institution-applications/{id}/signatories', { path: { id }, body, idempotencyKey }),
    proposeAccount: (id: string, body: { holderName: string; iban?: string; routingNumber?: string; accountNumber?: string }) => c.post('/institution-applications/{id}/account', { path: { id }, body }),
    submitApplication: (id: string) => c.post('/institution-applications/{id}/submit', { path: { id } }),
  };
}

/** The problem's `problems` list, when the API named what was wrong (an account, a missing step). */
export const problemsOf = (e: unknown): string[] | undefined => {
  if (!(e instanceof ApiError)) return undefined;
  const p = (e.problem as unknown as Record<string, unknown>)['problems'] ?? (e.problem as unknown as Record<string, unknown>)['missing'];
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : undefined;
};

/** The API's error code, for a server action to hand back; undefined for anything that is not an API answer. */
export const codeOf = (e: unknown): string | undefined => (e instanceof ApiError ? String(e.code ?? e.status) : undefined);
