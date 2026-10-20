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

export const statusOf = (e: unknown): number | undefined => (e instanceof ApiError ? e.status : undefined);

/** The API as the signed-in staff member, for pages and server actions; the step-up token comes from its httpOnly cookie. */
export function institutionApi(baseUrl: string, accessToken: string, stepUpToken?: string) {
  const c = createClient({
    baseUrl,
    getAccessToken: () => accessToken,
    // A preview sends an empty header and the API ignores it; a run without a fresh token answers STEP_UP_REQUIRED.
    getStepUpToken: () => stepUpToken ?? '',
    newIdempotencyKey: () => {
      throw new Error('Every console call that takes an idempotency key names it');
    },
  });
  return {
    schedules: (id: string) => c.get('/institutions/{id}/allowance-schedules', { path: { id } }),
    runs: (id: string) => c.get('/institutions/{id}/allowance-runs', { path: { id } }),
    runAllowance: (id: string, body: Schemas['AllowanceRunRequest'], idempotencyKey: string) => c.post('/institutions/{id}/allowance-runs', { path: { id }, body, idempotencyKey }),
    stepUp: (response?: unknown) => c.post('/auth/step-up', { body: response ? { response: response as Record<string, never> } : {} }),
    collections: (id: string, month: string) => c.get('/institutions/{id}/collections', { path: { id }, query: { month } }),
    exportCollections: (id: string, month: string, format: 'csv' | 'xlsx') => c.get('/institutions/{id}/collections/export', { path: { id }, query: { month, format } }),
    payouts: (id: string, cursor?: string) => c.get('/institutions/{id}/payouts', { path: { id }, query: cursor ? { cursor } : {} }),
    createPayout: (id: string, body: Schemas['PayoutRequest'], idempotencyKey: string) => c.post('/institutions/{id}/payouts', { path: { id }, body, idempotencyKey }),
    approvePayout: (id: string, idempotencyKey: string) => c.post('/payouts/{id}/approve', { path: { id }, idempotencyKey }),
    rejectPayout: (id: string, reason: string, idempotencyKey: string) => c.post('/payouts/{id}/reject', { path: { id }, body: { reason }, idempotencyKey }),
  };
}

/** The API's error code, for a server action to hand back; undefined for anything that is not an API answer. */
export const codeOf = (e: unknown): string | undefined => (e instanceof ApiError ? String(e.code ?? e.status) : undefined);
