// T-0035: a request through the node:http binding runs on the app's clock, not the wall clock, so the demo's
// shared clock (advanced by the panel) reaches every handler and the MCP endpoint alike. A caller may still pin
// `now`, as the API tests do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from './auth/tokens.ts';
import { createApp, type App } from './app.ts';
import { ok } from './http.ts';
import { createServer, dispatch } from './server.ts';
import { createLogger } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from './test-db.ts';

const APP_NOW = new Date('2026-11-04T08:00:00Z');
let db: TestDatabase;
let app: App;
let base: string;
let close: () => Promise<void>;
const seen: { rest?: Date; mcp?: Date } = {};

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => APP_NOW });
  app.handlers['startOtp'] = async (req) => {
    seen.rest = req.now;
    return ok({});
  };
  app.mcp.handle = async (input) => {
    seen.mcp = input.now;
    return { status: 200, body: {} };
  };
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
}, 60_000);
afterAll(async () => {
  await close();
  await db.close();
});

describe('request time follows the app clock (T-0035)', () => {
  it('a REST request and an MCP request through the server carry the app clock', async () => {
    expect((await fetch(`${base}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect(seen.rest).toEqual(APP_NOW);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect(seen.mcp).toEqual(APP_NOW);
  });

  it('a caller that pins now still wins', async () => {
    const pinned = new Date('2027-01-01T00:00:00Z');
    await dispatch(app, { method: 'POST', url: '/v1/auth/otp', headers: {}, rawBody: '{}', now: pinned });
    expect(seen.rest).toEqual(pinned);
  });
});

describe('the access line and the request id (T-0052)', () => {
  const logged: string[] = [];
  let logBase: string;
  let closeLogged: () => Promise<void>;
  beforeAll(async () => {
    const server = createServer(app, createLogger({ service: 'api', market: 'IL', write: (l) => logged.push(l) }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    logBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeLogged = () => new Promise((resolve) => server.close(() => resolve()));
  });
  afterAll(async () => closeLogged());

  const last = () => JSON.parse(logged.at(-1)!) as Record<string, unknown>;

  it('logs one request line: id, method, operation, status and duration; returns the id', async () => {
    const res = await fetch(`${logBase}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"+972501234567"}' });
    const id = res.headers.get('x-request-id')!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(last()).toMatchObject({ event: 'request', level: 'info', service: 'api', market: 'IL', requestId: id, method: 'POST', route: 'startOtp', status: 200 });
    expect(typeof last()['durationMs']).toBe('number');
  });

  it('keeps a well-formed x-request-id from the load balancer and replaces a malformed one', async () => {
    const kept = await fetch(`${logBase}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'lb-abcdefghij' }, body: '{}' });
    expect(kept.headers.get('x-request-id')).toBe('lb-abcdefghij');
    expect(last()['requestId']).toBe('lb-abcdefghij');
    const replaced = await fetch(`${logBase}/v1/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'bad id; drop' }, body: '{}' });
    expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never logs the URL, query, headers or body: a token in the query and a phone number in the body are not in any line', async () => {
    await fetch(`${logBase}/v1/auth/otp?token=eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln&code=123456`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret-bearer-value' }, body: '{"phone":"+972501234567"}' });
    await fetch(`${logBase}/v1/nope/4242424242424242`);
    const all = logged.join('\n');
    expect(all).not.toMatch(/eyJ|123456|972501234567|secret-bearer|4242424242424242|nope/);
    expect(last()).toMatchObject({ route: 'unmatched', status: 404 });
  });

  it('the MCP endpoint is logged as mcp, not by path', async () => {
    await fetch(`${logBase}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(last()).toMatchObject({ route: 'mcp', status: 200 });
  });
});
