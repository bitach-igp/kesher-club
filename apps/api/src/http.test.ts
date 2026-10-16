import { describe, expect, it } from 'vitest';
import { DomainError } from '@kesher/domain';
import { HttpError, makeRequest, ok, requireIdempotencyKey, requireRole, route } from './http.ts';

describe('http core', () => {
  it('maps DomainError to problem+json with the trace id and no stack', async () => {
    const h = route(async () => {
      throw new DomainError('LIMIT_EXCEEDED', 'Remaining ₪1,000', { remaining: { minor: '100000', currency: 'ILS' } });
    });
    const res = await h(makeRequest({ method: 'POST', path: '/transfers', traceId: 't-1' }));
    expect(res.status).toBe(422);
    expect(res.headers).toMatchObject({ 'content-type': 'application/problem+json', 'x-trace-id': 't-1' });
    expect(res.body).toMatchObject({ code: 'LIMIT_EXCEEDED', traceId: 't-1', remaining: { minor: '100000' } });
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });

  it('hides unknown errors behind a generic 500', async () => {
    const h = route(async () => {
      throw new TypeError('secret internal detail');
    });
    const res = await h(makeRequest({ method: 'GET', path: '/x' }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('HttpError carries custom headers (for WWW-Authenticate challenges)', async () => {
    const h = route(async () => {
      throw new HttpError(401, 'invalid_token', 'nope', { 'www-authenticate': 'Bearer realm="x"' });
    });
    const res = await h(makeRequest({ method: 'GET', path: '/mcp' }));
    expect(res.headers?.['www-authenticate']).toBe('Bearer realm="x"');
  });

  it('role and idempotency guards throw typed domain errors', () => {
    const req = makeRequest({ method: 'POST', path: '/x', headers: { 'Idempotency-Key': 'short' } });
    expect(() => requireRole(req, 'admin')).toThrow(DomainError);
    expect(() => requireIdempotencyKey(req)).toThrow(/Idempotency-Key/);
    const good = makeRequest({ method: 'POST', path: '/x', headers: { 'Idempotency-Key': 'k-12345678' }, principal: { partyId: 'p', roles: ['member'], sessionId: 's', deviceId: 'd' } });
    expect(requireIdempotencyKey(good)).toBe('k-12345678');
    expect(requireRole(good, 'member').partyId).toBe('p');
    expect(() => requireRole(good, 'admin')).toThrow(/Needs one of/);
  });

  it('passes successful responses through with the trace header', async () => {
    const res = await route(async () => ok({ hello: 'world' }))(makeRequest({ method: 'GET', path: '/', traceId: 't' }));
    expect(res).toMatchObject({ status: 200, body: { hello: 'world' }, headers: { 'x-trace-id': 't' } });
  });
});
