// End to end over the composition root and the HTTP dispatcher: sign up, capabilities, a route
// table that matches the contract, problem+json everywhere, FEATURE_OFF for gated operations.
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_OTP_CODE, SimPasskeyDevice, type PasskeyRegistrationOptions } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from './auth/tokens.ts';
import { createApp, type App } from './app.ts';
import { ROUTES, match } from './routes.ts';
import { dispatch } from './server.ts';
import { createTestDatabase, type TestDatabase } from './test-db.ts';

let db: TestDatabase;
let app: App;
const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => dispatch(app, { method, url, headers, rawBody: body === undefined ? '' : JSON.stringify(body) });

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example' });
}, 60_000);
afterAll(async () => db.close());

describe('route table', () => {
  it('covers exactly the operations in contracts/openapi.yaml, with the same methods and paths', () => {
    const yaml = fs.readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8');
    const ops = new Set<string>();
    let path = '';
    for (const line of yaml.split('\n')) {
      const p = /^ {2}(\/[^:]+):\s*$/.exec(line);
      if (p) path = p[1]!;
      const m = /^ {4}(get|post|patch|delete):\s*$/.exec(line);
      if (m) ops.add(`${m[1]!.toUpperCase()} ${path}`);
    }
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`))).toEqual(ops);
    for (const op of yaml.matchAll(/operationId: (\w+)/g)) expect(ROUTES.map((r) => r.operationId)).toContain(op[1]);
  });

  it('matches paths with params and ignores others', () => {
    expect(match('POST', '/transfers/11111111-1111-4111-8111-111111111111/cancel')).toMatchObject({ route: { operationId: 'cancelTransfer' }, params: { id: '11111111-1111-4111-8111-111111111111' } });
    expect(match('GET', '/transfers')).toBeUndefined();
  });
});

describe('API end to end (simulators)', () => {
  it('404s unknown routes, 401s protected routes, and never leaks a stack', async () => {
    expect((await call('GET', '/v1/nope')).status).toBe(404);
    const r = await call('GET', '/v1/me/capabilities');
    expect(r.status).toBe(401);
    expect(r.headers?.['content-type']).toBe('application/problem+json');
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts:/);
  });

  it('signs a member up over HTTP and reads capabilities with registry flags', async () => {
    const otp = await call('POST', '/v1/auth/otp', { phone: '+972501234567' });
    expect(otp.status).toBe(201);
    const { otpId } = otp.body as { otpId: string };
    const v = await call('POST', '/v1/auth/otp/verify', { otpId, code: SIM_OTP_CODE });
    const { otpSessionToken } = v.body as { otpSessionToken: string };
    const device = new SimPasskeyDevice();
    const o = await call('POST', '/v1/auth/passkeys/register', { deviceId: 'd1', deviceName: 'Noa' }, { authorization: `Bearer ${otpSessionToken}` });
    const options = (o.body as { options: PasskeyRegistrationOptions }).options;
    const done = await call('POST', '/v1/auth/passkeys/register', { deviceId: 'd1', deviceName: 'Noa', response: await device.register(options) }, { authorization: `Bearer ${otpSessionToken}` });
    const { tokens } = done.body as { tokens: { accessToken: string } };
    const caps = await call('GET', '/v1/me/capabilities', undefined, { authorization: `Bearer ${tokens.accessToken}` });
    expect(caps.status).toBe(200);
    expect((caps.body as { features: Record<string, boolean> }).features['auth.passkey.primary']).toBe(true);
    const accounts = await call('GET', '/v1/accounts', undefined, { authorization: `Bearer ${tokens.accessToken}` });
    expect((accounts.body as { items: { currency: string }[] }).items.map((a) => a.currency).sort()).toEqual(['ILS', 'USD']);
    // Money behind a flag that is off answers FEATURE_OFF, not 500; step-up is checked first.
    const t = await call('POST', '/v1/transfers', { toPartyId: '11111111-1111-4111-8111-111111111111', amount: { minor: '100', currency: 'ILS' } }, { authorization: `Bearer ${tokens.accessToken}`, 'idempotency-key': 'k-12345678' });
    expect(t.status).toBe(401);
    expect((t.body as { code: string }).code).toBe('STEP_UP_REQUIRED');
    const load = await call('POST', '/v1/loads', {}, { authorization: `Bearer ${tokens.accessToken}` });
    expect((load.body as { code: string }).code).toBe('FEATURE_OFF');
    const bad = await call('POST', '/v1/auth/otp', '{not json');
    expect(bad.status).toBe(422);
  });
});
