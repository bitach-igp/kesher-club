import { describe, expect, it } from 'vitest';
import { fromWire, toWire, money } from '@kesher/domain';
import { ApiError, createClient, operationHeaders } from './client.ts';
import fs from 'node:fs';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (c: Call) => { status: number; body?: unknown; problem?: boolean }) {
  const calls: Call[] = [];
  const f = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} };
    calls.push(c);
    const r = handler(c);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : text, { status: r.status, headers: { 'content-type': r.problem ? 'application/problem+json' : 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const headersOf = (c: Call) => Object.fromEntries(Object.entries((c.init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));

describe('sdk client', () => {
  it('sends the bearer token, JSON body, path and query params', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { items: [], nextCursor: undefined } }));
    const api = createClient({ baseUrl: 'https://api.kesher.example/v1/', fetch, getAccessToken: () => 'tok' });
    const page = await api.get('/accounts/{id}/transactions', { path: { id: '11111111-1111-4111-8111-111111111111' }, query: { limit: 10 } });
    expect(page.items).toEqual([]);
    expect(calls[0]!.url).toBe('https://api.kesher.example/v1/accounts/11111111-1111-4111-8111-111111111111/transactions?limit=10');
    expect(headersOf(calls[0]!)['authorization']).toBe('Bearer tok');
  });

  it('adds Idempotency-Key and X-Step-Up exactly where the contract declares them', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: { id: 'x', state: 'created', amount: toWire(money(5000n, 'ILS')) } }));
    const api = createClient({ baseUrl: 'https://api.kesher.example/v1', fetch, getAccessToken: () => 'tok', getStepUpToken: () => 'su', newIdempotencyKey: () => 'generated-key' });
    const t = await api.post('/transfers', { body: { toPartyId: '11111111-1111-4111-8111-111111111111', amount: toWire(money(5000n, 'ILS')) } });
    expect(fromWire(t.amount)).toEqual(money(5000n, 'ILS'));
    const h = headersOf(calls[0]!);
    expect(h['idempotency-key']).toBe('generated-key');
    expect(h['x-step-up']).toBe('su');
    expect(h['content-type']).toBe('application/json');
    await api.get('/me/capabilities');
    const h2 = headersOf(calls[1]!);
    expect(h2['idempotency-key']).toBeUndefined();
    expect(h2['x-step-up']).toBeUndefined();
  });

  it('reuses the caller-supplied idempotency key on retry (REQ-PAY-005)', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n === 1 ? { status: 503, problem: true, body: { type: 'x', title: 'x', status: 503, code: 'PROVIDER_UNAVAILABLE' } } : { status: 201, body: { id: 'x', state: 'created', amount: toWire(money(1n, 'USD')) } }));
    const api = createClient({ baseUrl: 'https://api.kesher.example/v1', fetch, getAccessToken: () => 'tok', getStepUpToken: () => 'su' });
    const body = { toPartyId: '11111111-1111-4111-8111-111111111111', amount: toWire(money(1n, 'USD')) };
    await expect(api.post('/transfers', { body, idempotencyKey: 'client-key-1' })).rejects.toBeInstanceOf(ApiError);
    await api.post('/transfers', { body, idempotencyKey: 'client-key-1' });
    expect(calls.map((c) => headersOf(c)['idempotency-key'])).toEqual(['client-key-1', 'client-key-1']);
  });

  it('maps problem+json to ApiError with the closed code set', async () => {
    const { fetch } = fakeFetch(() => ({ status: 422, problem: true, body: { type: 'https://api.kesher.example/errors/limit-exceeded', title: 'Limit exceeded', status: 422, code: 'LIMIT_EXCEEDED', detail: 'Remaining ₪1,000', traceId: 't-1' } }));
    const api = createClient({ baseUrl: 'https://api.kesher.example/v1', fetch, getAccessToken: () => 'tok', getStepUpToken: () => 'su' });
    try {
      await api.post('/transfers', { body: { toPartyId: '11111111-1111-4111-8111-111111111111', amount: toWire(money(120_000n, 'ILS')) } });
      throw new Error('unreachable');
    } catch (e) {
      const err = e as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('LIMIT_EXCEEDED');
      expect(err.status).toBe(422);
      expect(err.problem.traceId).toBe('t-1');
      expect(err.message).toBe('Remaining ₪1,000');
    }
  });

  it('turns a non-problem failure (gateway HTML) into a typed error too', async () => {
    const f = (async () => new Response('<html>bad gateway</html>', { status: 503 })) as typeof fetch;
    const api = createClient({ baseUrl: 'https://api.kesher.example/v1', fetch: f });
    await expect(api.get('/me/capabilities')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
  });

  it('refuses to call a money operation without a step-up provider', async () => {
    const { fetch } = fakeFetch(() => ({ status: 201 }));
    const api = createClient({ baseUrl: 'https://api.kesher.example/v1', fetch, getAccessToken: () => 'tok' });
    await expect(api.post('/loads', { body: { memberPartyId: '11111111-1111-4111-8111-111111111111', amount: toWire(money(1n, 'USD')), method: 'card' } })).rejects.toThrow(/step-up/);
  });

  it('204 responses resolve to undefined', async () => {
    const { fetch } = fakeFetch(() => ({ status: 204 }));
    const api = createClient({ baseUrl: 'https://api.kesher.example/v1', fetch, getAccessToken: () => 'tok' });
    await expect(api.delete('/agent-grants/{id}', { path: { id: '11111111-1111-4111-8111-111111111111' } })).resolves.toBeUndefined();
  });

  it('the header table matches the contract: every op with Idempotency-Key / X-Step-Up is listed, and nothing else', () => {
    const yaml = fs.readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8');
    const ops = new Map<string, { idempotency: boolean; stepUp: boolean }>();
    let path = '';
    let method = '';
    for (const line of yaml.split('\n')) {
      const p = /^ {2}(\/[^:]+):\s*$/.exec(line);
      if (p) path = p[1]!;
      const m = /^ {4}(get|post|patch|delete):\s*$/.exec(line);
      if (m) {
        method = m[1]!;
        ops.set(`${method} ${path}`, { idempotency: false, stepUp: false });
      }
      if (line.includes('#/components/parameters/IdempotencyKey')) ops.get(`${method} ${path}`)!.idempotency = true;
      if (line.includes('#/components/parameters/StepUp')) ops.get(`${method} ${path}`)!.stepUp = true;
    }
    const expected = Object.fromEntries([...ops].filter(([, v]) => v.idempotency || v.stepUp));
    expect(operationHeaders).toEqual(expected);
  });

  it('regenerated types are in sync with the contract (run `pnpm --filter @kesher/sdk generate`)', () => {
    const generated = fs.readFileSync(new URL('./schema.generated.ts', import.meta.url), 'utf8');
    const yaml = fs.readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8');
    for (const op of yaml.matchAll(/operationId: (\w+)/g)) expect(generated, `missing ${op[1]}`).toContain(`${op[1]}:`);
  });
});
