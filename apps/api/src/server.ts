// node:http binding for the API: parses the request, runs the bearer middleware, dispatches by
// the route table, writes JSON or problem+json. Replace with the NestJS adapter when ADR-001 is
// accepted; handlers do not change.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { toProblem, type HttpRequest, type HttpResponse } from './http.ts';
import { match } from './routes.ts';
import type { App } from './app.ts';
import { DomainError, ID_SHAPE, type Logger } from '@kesher/domain';

const MAX_BODY = 2 * 1024 * 1024 + 1024;
/** OAuth's token endpoint takes a form body (RFC 6749 §3.2, T-1016); every other route stays JSON-only. */
const FORM_BODY = new Set(['issueAgentToken']);
/** Routes whose body is signed: it is not parsed here. Their handler verifies the received bytes first, then parses (T-0649). */
const RAW_BODY = new Set(['crowdedWebhook']);

/** A request's time is the app's clock unless the caller pins one: the demo's shared clock (T-0035) must reach handlers. */
export async function dispatch(app: App, input: { method: string; url: string; headers: Record<string, string>; rawBody: string; rawBytes?: Uint8Array; now?: Date }): Promise<HttpResponse> {
  const now = input.now ?? app.services.clock.now();
  // The trace id is the caller's W3C traceparent, else the request id the server gave this request, else a new one.
  const requestHeader = input.headers['x-request-id'];
  const traceId = input.headers['traceparent']?.split('-')[1] ?? (requestHeader !== undefined && ID_SHAPE.test(requestHeader) ? requestHeader : randomUUID());
  const u = new URL(input.url, 'http://api.local');
  const pathname = u.pathname.replace(/^\/v1(?=\/)/, '');
  // /mcp speaks JSON-RPC (T-1013), outside the REST route table and the contract.
  if (app.mcp.owns(pathname)) {
    const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const out = await app.mcp.handle({ method: input.method, pathname, headers, rawBody: input.rawBody, now });
    return { ...out, headers: { 'content-type': 'application/json', ...out.headers } };
  }
  const found = match(input.method, pathname);
  if (!found) return toProblem(new DomainError('NOT_FOUND', 'No such route'), traceId);
  let body: unknown = undefined;
  if (input.rawBody && FORM_BODY.has(found.route.operationId) && (input.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
    body = Object.fromEntries(new URLSearchParams(input.rawBody));
  } else if (input.rawBody && !RAW_BODY.has(found.route.operationId)) {
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      return toProblem(new DomainError('VALIDATION_FAILED', 'Body must be JSON'), traceId);
    }
  }
  let req: HttpRequest = { method: found.route.method, path: pathname, params: found.params, query: Object.fromEntries(u.searchParams), headers: input.headers, body, rawBody: input.rawBody, ...(input.rawBytes ? { rawBytes: input.rawBytes } : {}), traceId, now };
  try {
    req = await app.authenticate(req);
  } catch (e) {
    return toProblem(e, traceId);
  }
  if (!found.route.public && !req.principal) return toProblem(new DomainError('UNAUTHENTICATED', 'Sign in required'), traceId);
  const handler = app.handlers[found.route.operationId]!;
  return handler(req);
}

/** The operation a request ran, for the access line: the contract's operationId, never the URL (it carries ids and query values). */
function routeName(method: string, url: string): string {
  const pathname = new URL(url, 'http://api.local').pathname.replace(/^\/v1(?=\/)/, '');
  if (pathname.startsWith('/mcp')) return 'mcp';
  return match(method, pathname)?.route.operationId ?? 'unmatched';
}

/**
 * `log` receives one `request` line per response: request id, method, operation, status and duration. Never the URL, query,
 * headers or body, and no member or account id: the logger cannot carry them (T-0052). The request id is the caller's
 * `x-request-id` (the load balancer sets one) when it has the strict id shape, else a new UUID; it is returned in `X-Request-Id`.
 */
export function createServer(app: App, log?: Logger): http.Server {
  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
    const requestId = headers['x-request-id'] !== undefined && ID_SHAPE.test(headers['x-request-id']) ? headers['x-request-id'] : randomUUID();
    headers['x-request-id'] = requestId;
    const method = req.method ?? 'GET';
    const finish = (status: number): void => {
      let route = 'unmatched';
      try {
        route = routeName(method, req.url ?? '/');
      } catch {
        // an unparsable URL is logged as unmatched
      }
      try {
        log?.('request', { requestId, method, route, status, durationMs: Date.now() - startedAt });
      } catch {
        // a logging failure never fails the response, which has already been sent
      }
    };
    // The body is kept as the bytes that arrived: a signature is over them, and decoding them first would change them.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      chunks.push(buf);
      size += buf.length;
      if (size > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'application/problem+json', 'x-request-id': requestId }).end(JSON.stringify({ type: 'about:blank', title: 'Body too large', status: 413, code: 'VALIDATION_FAILED' }));
        finish(413);
        return;
      }
    }
    const rawBytes = Buffer.concat(chunks);
    let out: HttpResponse;
    try {
      out = await dispatch(app, { method, url: req.url ?? '/', headers, rawBody: rawBytes.toString('utf8'), rawBytes });
    } catch (e) {
      out = toProblem(e, requestId);
    }
    const contentType = out.headers?.['content-type'] ?? 'application/json; charset=utf-8';
    res.writeHead(out.status, { ...out.headers, 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId });
    res.end(out.body === undefined ? '' : JSON.stringify(out.body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
    finish(out.status);
  });
}
