// Test support (T-0782): builds an HttpRequest for suites. It lives beside test-db.ts and test-seed.ts, not in
// http.ts, so no production module carries a test builder's `randomUUID` and `new Date()` defaults.
import { randomUUID } from 'node:crypto';
import type { HttpRequest } from './http.ts';

/** Builds a request for tests; fills trace id and clock. */
export function makeRequest<B>(partial: Partial<HttpRequest<B>> & { method: HttpRequest['method']; path: string }): HttpRequest<B> {
  const headers = Object.fromEntries(Object.entries(partial.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { params: {}, query: {}, body: undefined as B, traceId: randomUUID(), now: new Date(), ...partial, headers };
}
