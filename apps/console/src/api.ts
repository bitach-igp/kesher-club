// The console's server-side API calls (T-0608). The browser never holds a token: the console's server
// relays the passkey ceremony, keeps the pair in httpOnly cookies and calls the API with them.
import { ApiError, createClient, type Schemas } from '@kesher/sdk';

export type MyInstitution = Schemas['MyInstitution'];
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
