// Framework-agnostic HTTP core for the API. Handlers are pure async functions over a small request
// shape so every module is unit-testable without sockets, and the NestJS (ADR-001) binding is one
// adapter file. Errors become RFC 9457 problem+json through DomainError (packages/domain).
import { DomainError, ERROR_CODES } from '@kesher/domain';
import { randomUUID } from 'node:crypto';

export interface Principal {
  /** `staff` for admin-console tokens (ADR-013); absent or `member` for member tokens. */
  kind?: 'member' | 'staff';
  /** The IdP subject behind a staff principal (its partyId is derived from it). */
  subject?: string;
  partyId: string;
  /** Roles on this token: member, funder, org_staff, org_finance, admin. */
  roles: readonly string[];
  /** Session id for device binding and family revocation (REQ-AUTH-007). */
  sessionId: string;
  deviceId: string;
  /** 24 h recovery hold end, when active (REQ-AUTH-003). */
  restrictedUntil?: string;
}

export interface HttpRequest<B = unknown> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: B;
  /** Set by the auth middleware; absent on public routes. */
  principal?: Principal;
  traceId: string;
  /** Raw body for signature verification on webhooks. */
  rawBody?: string;
  now: Date;
}

export interface HttpResponse<B = unknown> {
  status: number;
  body?: B;
  headers?: Record<string, string>;
}

export type Handler<Req = unknown, Res = unknown> = (req: HttpRequest<Req>) => Promise<HttpResponse<Res>>;

export const ok = <B>(body: B, status = 200): HttpResponse<B> => ({ status, body });
export const created = <B>(body: B): HttpResponse<B> => ({ status: 201, body });
export const noContent = (): HttpResponse<never> => ({ status: 204 });

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  traceId: string;
  [k: string]: unknown;
}

/** Maps any thrown value to problem+json. Unknown errors become a 500 with no stack (Tab 3 §8 debug leakage). */
export function toProblem(err: unknown, traceId: string): HttpResponse<ProblemBody> {
  if (err instanceof DomainError) {
    return { status: ERROR_CODES[err.code], body: err.toProblem(traceId) as ProblemBody, headers: { 'content-type': 'application/problem+json' } };
  }
  if (err instanceof HttpError) {
    return { status: err.status, body: { type: 'about:blank', title: err.message, status: err.status, code: err.code, traceId, ...err.extra }, headers: { 'content-type': 'application/problem+json', ...err.headers } };
  }
  return { status: 500, body: { type: 'about:blank', title: 'Internal error', status: 500, code: 'INTERNAL', traceId }, headers: { 'content-type': 'application/problem+json' } };
}

/** For transport-level failures that are not domain errors (401 challenges, 403 scope, 429). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Wraps a handler so thrown errors become problem+json and every response carries the trace id. */
export const route =
  <Req, Res>(handler: Handler<Req, Res>): Handler<Req, Res | ProblemBody> =>
  async (req) => {
    try {
      const res = await handler(req);
      return { ...res, headers: { 'x-trace-id': req.traceId, ...res.headers } };
    } catch (e) {
      const p = toProblem(e, req.traceId);
      return { ...p, headers: { 'x-trace-id': req.traceId, ...p.headers } };
    }
  };

/** Builds a request for tests and adapters; fills trace id and clock. */
export function makeRequest<B>(partial: Partial<HttpRequest<B>> & { method: HttpRequest['method']; path: string }): HttpRequest<B> {
  const headers = Object.fromEntries(Object.entries(partial.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { params: {}, query: {}, body: undefined as B, traceId: randomUUID(), now: new Date(), ...partial, headers };
}

export const requirePrincipal = (req: HttpRequest): Principal => {
  if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
  // Staff tokens open /admin/* only (ADR-013); a staff principal has no member accounts to act on.
  if (req.principal.kind === 'staff') throw new DomainError('FORBIDDEN', 'Staff tokens are accepted on admin operations only');
  return req.principal;
};

export const requireRole = (req: HttpRequest, ...roles: string[]): Principal => {
  const p = requirePrincipal(req);
  if (!roles.some((r) => p.roles.includes(r))) throw new DomainError('FORBIDDEN', `Needs one of: ${roles.join(', ')}`);
  return p;
};

/** Idempotency-Key is mandatory on every money and create call (contract parameters/IdempotencyKey). */
export const requireIdempotencyKey = (req: HttpRequest): string => {
  const k = req.headers['idempotency-key'];
  if (!k || k.length < 8 || k.length > 128) throw new DomainError('VALIDATION_FAILED', 'Idempotency-Key header (8–128 chars) required');
  return k;
};
