// Typed client over contracts/openapi.yaml (T-0007). Paths, methods, bodies and responses come
// from the generated schema; this file adds auth headers, step-up, idempotency keys, problem+json
// mapping and bigint-safe Money. Runtime dependency: `fetch` only.
import type { ErrorCode } from '@kesher/domain';
import type { components, paths } from './schema.generated.ts';

export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];
type Paths = paths;
export type Path = keyof Paths;
export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';
/** Paths that implement a method (openapi-typescript types the others as `never`). */
export type PathsWith<M extends HttpMethod> = { [P in Path]: Paths[P][M] extends undefined ? never : P }[Path];
export type Method<P extends Path> = { [M in HttpMethod]: Paths[P][M] extends undefined ? never : M }[HttpMethod];

type Op<P extends Path, M extends HttpMethod> = NonNullable<Paths[P][M]>;
type ParamsOf<P extends Path, M extends HttpMethod> = Op<P, M> extends { parameters: infer X } ? X : never;
type PathParams<P extends Path, M extends HttpMethod> = ParamsOf<P, M> extends { path: infer X } ? (X extends undefined ? Record<string, never> : X) : Record<string, never>;
type QueryParams<P extends Path, M extends HttpMethod> = ParamsOf<P, M> extends { query?: infer X } ? (X extends undefined ? Record<string, never> : X) : Record<string, never>;
type BodyOf<P extends Path, M extends HttpMethod> = Op<P, M> extends { requestBody: { content: { 'application/json': infer B } } } ? B : Op<P, M> extends { requestBody?: { content: { 'application/json': infer B } } } ? B | undefined : undefined;
type Responses<P extends Path, M extends HttpMethod> = Op<P, M> extends { responses: infer R } ? R : never;
type SuccessCode<R> = Extract<keyof R, 200 | 201 | 204>;
type JsonOf<R, C extends keyof R> = R[C] extends { content: { 'application/json': infer J } } ? J : void;
export type Result<P extends Path, M extends HttpMethod> = JsonOf<Responses<P, M>, SuccessCode<Responses<P, M>>>;

export interface RequestOptions<P extends Path, M extends HttpMethod> {
  path?: PathParams<P, M>;
  query?: QueryParams<P, M>;
  body?: BodyOf<P, M>;
  /** Supplied by the caller for retries so a double-tap never creates two transfers (REQ-PAY-005). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  constructor(
    status: number,
    problem: Problem,
  ) {
    super(problem.detail ?? problem.title);
    this.status = status;
    this.problem = problem;
    this.name = 'ApiError';
  }
  get code(): ErrorCode | Problem['code'] {
    return this.problem.code;
  }
}

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Access token (10-minute). Return undefined for public calls. */
  getAccessToken?: () => Promise<string | undefined> | string | undefined;
  /** Step-up token younger than 5 minutes; asked only for operations whose contract declares X-Step-Up. */
  getStepUpToken?: () => Promise<string> | string;
  /** Idempotency keys for operations that declare Idempotency-Key, when the caller passes none. */
  newIdempotencyKey?: () => string;
  /** Trace id propagated as `traceparent` (NFR-007). */
  traceparent?: () => string | undefined;
}

/** Operations whose contract declares Idempotency-Key / X-Step-Up. A test keeps this in sync with the YAML. */
const HEADER_OPS: Record<string, { idempotency: boolean; stepUp: boolean }> = {
  'post /memberships': { idempotency: true, stepUp: false },
  'post /memberships/{id}/cancel': { idempotency: true, stepUp: false },
  'post /institution-applications': { idempotency: true, stepUp: false },
  'post /institution-applications/{id}/signatories': { idempotency: true, stepUp: false },
  'post /institutions/{id}/cohorts': { idempotency: true, stepUp: false },
  'post /institutions/{id}/staff-invites': { idempotency: true, stepUp: false },
  'patch /institutions/{id}/team/{partyId}': { idempotency: true, stepUp: false },
  'post /institutions/{id}/staff-grants/{grantId}/approve': { idempotency: false, stepUp: true },
  'post /institutions/{id}/cohorts/{cohortId}/members': { idempotency: true, stepUp: false },
  'post /funder-invites': { idempotency: true, stepUp: false },
  'post /funder-invites/{token}/accept': { idempotency: true, stepUp: false },
  'post /kyc/sessions': { idempotency: true, stepUp: false },
  'post /loads': { idempotency: true, stepUp: true },
  'post /accounts/{id}/auto-reload': { idempotency: true, stepUp: true },
  'post /me/closure': { idempotency: true, stepUp: true },
  'post /transfers': { idempotency: true, stepUp: true },
  'post /transfers/{id}/cancel': { idempotency: true, stepUp: false },
  'post /requests': { idempotency: true, stepUp: false },
  'post /splits': { idempotency: true, stepUp: false },
  'post /requests/{id}/pay': { idempotency: true, stepUp: true },
  'post /requests/{id}/decline': { idempotency: true, stepUp: false },
  'post /requests/{id}/cancel': { idempotency: true, stepUp: false },
  'post /fx/quotes': { idempotency: true, stepUp: false },
  'post /fx/conversions': { idempotency: true, stepUp: true },
  'post /cards/physical': { idempotency: true, stepUp: false },
  'post /cards/{id}/activate': { idempotency: true, stepUp: true },
  'post /cards/{id}/status': { idempotency: true, stepUp: false },
  'post /cards/{id}/details-token': { idempotency: false, stepUp: true },
  'patch /cards/{id}/controls': { idempotency: true, stepUp: false },
  'post /cards/{id}/provisioning/{wallet}': { idempotency: true, stepUp: true },
  'post /addon-orders': { idempotency: true, stepUp: false },
  'post /institutions/{id}/rosters': { idempotency: true, stepUp: false },
  'post /invites/{token}/accept': { idempotency: true, stepUp: false },
  'post /institutions/{id}/allowance-schedules': { idempotency: true, stepUp: false },
  'post /institutions/{id}/fee-items': { idempotency: true, stepUp: false },
  'post /institutions/{id}/allowance-runs': { idempotency: true, stepUp: true },
  'post /admin/institutions': { idempotency: true, stepUp: false },
  'post /admin/institutions/{id}/staff': { idempotency: true, stepUp: false },
  'post /admin/institutions/{id}/deposits': { idempotency: true, stepUp: false },
  'post /admin/institutions/{id}/credit-limits': { idempotency: true, stepUp: false },
  'post /admin/institutions/{id}/kyb/people': { idempotency: true, stepUp: false },
  'post /admin/institutions/{id}/kyb/decisions': { idempotency: true, stepUp: false },
  'post /admin/institutions/{id}/payout-accounts': { idempotency: true, stepUp: false },
  'post /payouts': { idempotency: true, stepUp: true },
  'post /institutions/{id}/payouts': { idempotency: true, stepUp: true },
  'post /institutions/{id}/ach-pulls': { idempotency: true, stepUp: true },
  'post /oauth/requests/{id}/approve': { idempotency: false, stepUp: true },
  'post /payouts/{id}/approve': { idempotency: true, stepUp: true },
  'post /payouts/{id}/reject': { idempotency: true, stepUp: true },
  'post /fee-items/{id}/pay': { idempotency: true, stepUp: true },
  'post /intents/{id}/approve': { idempotency: true, stepUp: true },
  'post /intents/{id}/decline': { idempotency: true, stepUp: false },
};

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const newKey = options.newIdempotencyKey ?? (() => globalThis.crypto.randomUUID());

  async function request<M extends HttpMethod, P extends PathsWith<M>>(method: M, path: P, opts: RequestOptions<P, M> = {}): Promise<Result<P, M>> {
    const url = new URL(options.baseUrl.replace(/\/$/, '') + interpolate(path, (opts.path ?? {}) as Record<string, string>));
    for (const [k, v] of Object.entries((opts.query ?? {}) as Record<string, unknown>)) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = { accept: 'application/json, application/problem+json' };
    const token = await options.getAccessToken?.();
    if (token) headers['authorization'] = `Bearer ${token}`;
    const tp = options.traceparent?.();
    if (tp) headers['traceparent'] = tp;
    const needs = HEADER_OPS[`${String(method)} ${path}`];
    if (needs?.idempotency) headers['idempotency-key'] = opts.idempotencyKey ?? newKey();
    if (needs?.stepUp) {
      if (!options.getStepUpToken) throw new Error(`${String(method)} ${path} needs a step-up token (REQ-AUTH-006)`);
      headers['x-step-up'] = await options.getStepUpToken();
    }
    const init: RequestInit = { method: String(method).toUpperCase(), headers, ...(opts.signal ? { signal: opts.signal } : {}) };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const res = await doFetch(url, init);
    if (res.status === 204) return undefined as Result<P, M>;
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : undefined) as Result<P, M>;
    throw new ApiError(res.status, parseProblem(res.status, text));
  }

  return {
    request,
    get: <P extends PathsWith<'get'>>(path: P, opts?: RequestOptions<P, 'get'>) => request('get', path, opts),
    post: <P extends PathsWith<'post'>>(path: P, opts?: RequestOptions<P, 'post'>) => request('post', path, opts),
    patch: <P extends PathsWith<'patch'>>(path: P, opts?: RequestOptions<P, 'patch'>) => request('patch', path, opts),
    delete: <P extends PathsWith<'delete'>>(path: P, opts?: RequestOptions<P, 'delete'>) => request('delete', path, opts),
  };
}

export type Client = ReturnType<typeof createClient>;

function interpolate(path: string, params: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`Missing path parameter ${k}`);
    return encodeURIComponent(v);
  });
}

function parseProblem(status: number, text: string): Problem {
  try {
    const p = JSON.parse(text) as Partial<Problem>;
    if (p && typeof p.code === 'string') return { type: p.type ?? 'about:blank', title: p.title ?? String(status), status: p.status ?? status, code: p.code, ...(p.detail !== undefined ? { detail: p.detail } : {}), ...(p.traceId !== undefined ? { traceId: p.traceId } : {}) };
  } catch {
    // fall through: a non-problem body (gateway HTML, empty) still becomes a typed error
  }
  return { type: 'about:blank', title: 'Unexpected response', status, code: status === 401 ? 'UNAUTHENTICATED' : status === 429 ? 'RATE_LIMITED' : status === 503 ? 'PROVIDER_UNAVAILABLE' : 'VALIDATION_FAILED', detail: text.slice(0, 200) };
}

export { HEADER_OPS as operationHeaders };
