// node:http binding for the API: parses the request, runs the bearer middleware, dispatches by
// the route table, writes JSON or problem+json. Replace with the NestJS adapter when ADR-001 is
// accepted; handlers do not change.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { toProblem, type HttpRequest, type HttpResponse } from './http.ts';
import { match } from './routes.ts';
import type { App } from './app.ts';
import { DomainError } from '@kesher/domain';

const MAX_BODY = 2 * 1024 * 1024 + 1024;
/** OAuth's token endpoint takes a form body (RFC 6749 §3.2, T-1016); every other route stays JSON-only. */
const FORM_BODY = new Set(['issueAgentToken']);

export async function dispatch(app: App, input: { method: string; url: string; headers: Record<string, string>; rawBody: string; now?: Date }): Promise<HttpResponse> {
  const traceId = input.headers['traceparent']?.split('-')[1] ?? randomUUID();
  const u = new URL(input.url, 'http://api.local');
  const pathname = u.pathname.replace(/^\/v1(?=\/)/, '');
  const found = match(input.method, pathname);
  if (!found) return toProblem(new DomainError('NOT_FOUND', 'No such route'), traceId);
  let body: unknown = undefined;
  if (input.rawBody && FORM_BODY.has(found.route.operationId) && (input.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
    body = Object.fromEntries(new URLSearchParams(input.rawBody));
  } else if (input.rawBody) {
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      return toProblem(new DomainError('VALIDATION_FAILED', 'Body must be JSON'), traceId);
    }
  }
  let req: HttpRequest = { method: found.route.method, path: pathname, params: found.params, query: Object.fromEntries(u.searchParams), headers: input.headers, body, rawBody: input.rawBody, traceId, now: input.now ?? new Date() };
  try {
    req = await app.authenticate(req);
  } catch (e) {
    return toProblem(e, traceId);
  }
  if (!found.route.public && !req.principal) return toProblem(new DomainError('UNAUTHENTICATED', 'Sign in required'), traceId);
  const handler = app.handlers[found.route.operationId]!;
  return handler(req);
}

export function createServer(app: App): http.Server {
  return http.createServer(async (req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ type: 'about:blank', title: 'Body too large', status: 413, code: 'VALIDATION_FAILED' }));
        return;
      }
    }
    let out: HttpResponse;
    try {
      out = await dispatch(app, { method: req.method ?? 'GET', url: req.url ?? '/', headers, rawBody: raw });
    } catch (e) {
      out = toProblem(e, randomUUID());
    }
    const contentType = out.headers?.['content-type'] ?? 'application/json; charset=utf-8';
    res.writeHead(out.status, { ...out.headers, 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(out.body === undefined ? '' : JSON.stringify(out.body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  });
}
