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
