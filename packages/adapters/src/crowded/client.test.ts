// T-0648 client tests (REQ-INS-022): the base URL and token are required, the `data` envelope is unwrapped, lists page to
// their total, Crowded's errors keep their status, and a token never appears in an error.
import { describe, expect, it, vi } from 'vitest';
import { CrowdedApiError, CrowdedClient, CrowdedTransportError } from './client.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const client = (fetch: typeof globalThis.fetch, onAuthFailure?: (s: number) => void) =>
  new CrowdedClient({ baseUrl: 'https://sandbox.fake.invalid/api/v1/', token: 'tok_secret_value', fetch, ...(onAuthFailure ? { onAuthFailure } : {}) });

describe('CrowdedClient', () => {
  it('needs an https base URL and a token', () => {
    expect(() => new CrowdedClient({ baseUrl: 'http://x.test', token: 't' })).toThrow(/https/);
    expect(() => new CrowdedClient({ baseUrl: '', token: 't' })).toThrow(/https/);
    expect(() => new CrowdedClient({ baseUrl: 'https://x.test', token: '' })).toThrow(/token/);
  });

  it('sends the bearer token, wraps a body in data and unwraps the answer', async () => {
    const f = vi.fn(async () => json(201, { data: { id: 7 }, meta: { x: 1 } }));
    const r = await client(f).post('/organizations', { name: 'A' });
    expect(r).toEqual({ status: 201, data: { id: 7 }, meta: { x: 1 } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sandbox.fake.invalid/api/v1/organizations');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok_secret_value');
    expect(JSON.parse(init.body as string)).toEqual({ data: { name: 'A' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('pages to meta.pagination.total, and stops at a short page when there is no total', async () => {
    const rows = [1, 2, 3, 4, 5];
    const withTotal = vi.fn(async (u: string | URL | Request) => {
      const q = new URL(String(u)).searchParams;
      const off = Number(q.get('pagination[offset]'));
      return json(200, { data: rows.slice(off, off + 2), meta: { pagination: { total: 5 } } });
    });
    const got: unknown[] = [];
    for await (const x of client(withTotal).list('/things', {}, 100)) got.push(x);
    expect(got).toEqual(rows);
    expect(withTotal).toHaveBeenCalledTimes(3);

    const noTotal = vi.fn(async (u: string | URL | Request) => {
      const off = Number(new URL(String(u)).searchParams.get('pagination[offset]'));
      return json(200, { data: rows.slice(off, off + 2) });
    });
    const again: unknown[] = [];
    for await (const x of client(noTotal).list('/things', {}, 2)) again.push(x);
    expect(again).toEqual(rows);
  });

  it('keeps the status and code of an error, flags outages and credentials, and never carries the token', async () => {
    const seen: number[] = [];
    const f = vi.fn(async () => json(403, { type: 'ForbiddenError', statusCode: 403, message: 'No access', requestId: 'r1' }));
    const e = await client(f, (s) => seen.push(s)).get('/x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CrowdedApiError);
    expect(e).toMatchObject({ status: 403, isAuth: true, isOutage: false, requestId: 'r1' });
    expect(seen).toEqual([403]);
    expect(String((e as Error).message) + JSON.stringify(e)).not.toContain('tok_secret_value');

    for (const [status, flag] of [[429, 'isOutage'], [503, 'isOutage'], [404, 'isMissing']] as const) {
      expect(await client(async () => json(status, { message: 'm' })).get('/x').catch((x: unknown) => x)).toMatchObject({ status, [flag]: true });
    }
    expect(await client(async () => json(400, { message: 'm', code: 'CANNOT_CANCEL' })).get('/x').catch((x: unknown) => x)).toMatchObject({ code: 'CANNOT_CANCEL' });
  });

  it('a network failure or a non-JSON success is a transport error', async () => {
    expect(await client(async () => Promise.reject(new Error('boom tok_secret_value'))).get('/x').catch((x: unknown) => x)).toBeInstanceOf(CrowdedTransportError);
    const e = await client(async () => new Response('<html>', { status: 200 })).get('/x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CrowdedTransportError);
    expect(String((e as Error).message)).not.toContain('tok_secret_value');
  });
});
