// Club rates (T-0512, REQ-FX-003, REQ-ADM-003). TST-FX-003: one active, versioned rate per pair; the
// worker's port rate is valid for 15 minutes and is superseded by the next; the direction asked gets the
// rate or its exact inverse; without a valid rate a conversion is refused with PROVIDER_UNAVAILABLE.
// TST-ADM-003: finance proposes a manual rate through the admin API, one approval leaves the active
// rate unchanged, a second distinct finance approver activates it with an audit entry, a manual rate
// outlives the port window and blocks port publishing, a proposal can be rejected, and the role is
// checked at the door.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { formatRate, invert, parseRate, PORT_RATE_TTL_MS, type RateService } from './rates.ts';

let db: TestDatabase;
let app: App;
let rates: RateService;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const staffToken = async (sub: string, roles: string[]) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(now.getTime() / 1000)).setExpirationTime(Math.floor(now.getTime() / 1000) + 3600).sign(privateKey);
const call = async (method: string, url: string, token: string, body?: unknown) => dispatch(app, { method, url, headers: { authorization: `Bearer ${token}` }, rawBody: body === undefined ? '' : JSON.stringify(body), now });
let finA = '';
let finB = '';
let ops = '';

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => now });
  rates = app.services.rates;
  finA = await staffToken('auth0|finance-a', ['finance']);
  finB = await staffToken('auth0|finance-b', ['finance']);
  ops = await staffToken('auth0|ops-1', ['ops']);
}, 60_000);
afterAll(async () => db.close());

describe('rate arithmetic', () => {
  it('parses decimals to fixed point, formats them back, and inverts half-up', () => {
    expect(parseRate('3.7')).toBe(3_700_000n);
    expect(parseRate('3.7000')).toBe(3_700_000n);
    expect(parseRate('3.710000')).toBe(3_710_000n);
    expect(parseRate('4')).toBe(4_000_000n);
    expect(() => parseRate('3.7000001')).toThrow(/six places/);
    expect(() => parseRate('0')).toThrow(/positive/);
    expect(() => parseRate('abc')).toThrow(/decimal/);
    expect(formatRate(3_700_000n)).toBe('3.700000');
    expect(invert(3_710_000n)).toBe(269_542n); // 1 / 3.71 = 0.26954177…
    expect(invert(4_000_000n)).toBe(250_000n);
  });
});

describe('TST-FX-003: the club rate table', () => {
  it('starts empty: no current rate, and a conversion is refused with PROVIDER_UNAVAILABLE', async () => {
    expect(await rates.current('USD/ILS', now)).toBeUndefined();
    await expect(rates.rateFor('USD', 'ILS', now)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const r = await call('GET', '/v1/admin/fx/rates', ops);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pair: 'USD/ILS', items: [] });
  });

  it('the worker publishes a port rate valid for 15 minutes; the next one supersedes it; both directions come from one row', async () => {
    const v1 = (await rates.publishFromPort('USD/ILS', 3_710_000n, now))!;
    expect(v1).toMatchObject({ version: 1, source: 'port', status: 'active', midScaled: 3_710_000n, validFrom: NOW.toISOString(), validUntil: at(PORT_RATE_TTL_MS).toISOString(), proposedBy: 'worker' });
    expect((await rates.current('USD/ILS', at(14 * 60_000)))?.version).toBe(1);
    expect(await rates.current('USD/ILS', at(PORT_RATE_TTL_MS))).toBeUndefined(); // the window is [from, until)
    await expect(rates.rateFor('USD', 'ILS', at(16 * 60_000))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await rates.rateFor('USD', 'ILS', now)).toEqual({ rateId: v1.id, pair: 'USD/ILS', version: 1, rateScaled: 3_710_000n });
    expect(await rates.rateFor('ILS', 'USD', now)).toEqual({ rateId: v1.id, pair: 'USD/ILS', version: 1, rateScaled: 269_542n });
    await expect(rates.rateFor('USD', 'USD', now)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    now = at(5 * 60_000);
    const v2 = (await rates.publishFromPort('USD/ILS', 3_720_000n, now))!;
    expect(v2.version).toBe(2);
    expect((await rates.current('USD/ILS', now))?.version).toBe(2);
    expect((await rates.history('USD/ILS')).map((r) => [r.version, r.status])).toEqual([
      [2, 'active'],
      [1, 'superseded'],
    ]);
    const list = await call('GET', '/v1/admin/fx/rates?pair=USD%2FILS', ops);
    expect(list.body).toMatchObject({ pair: 'USD/ILS', current: { version: 2, mid: '3.720000', source: 'port' } });
    expect((list.body as { items: unknown[] }).items).toHaveLength(2);
    expect((await call('GET', '/v1/admin/fx/rates?pair=EUR%2FILS', ops)).body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('TST-ADM-003: finance publishes manual rates with two approvers', () => {
  let proposed = '';

  it('a finance user proposes 3.7000 with a reason: the proposer is the first approver and the active rate is unchanged', async () => {
    expect((await call('POST', '/v1/admin/fx/rates', ops, { mid: '3.7000', reason: 'Bank of Israel fixing' })).body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await call('POST', '/v1/admin/fx/rates', finA, { mid: '3.7000001', reason: 'x' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await call('POST', '/v1/admin/fx/rates', finA, { mid: '3.7000' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    const r = await call('POST', '/v1/admin/fx/rates', finA, { pair: 'USD/ILS', mid: '3.7000', reason: 'Bank of Israel fixing, Tuesday' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ version: 3, mid: '3.700000', source: 'manual', status: 'proposed', proposedBy: 'auth0|finance-a', reason: 'Bank of Israel fixing, Tuesday', approval: { kind: 'fx_rate', status: 'awaiting_second_approval', approvals: 1 } });
    proposed = (r.body as { id: string }).id;
    expect((await rates.current('USD/ILS', now))?.version).toBe(2);
    // The same person cannot be the second approver; an ops user is not finance.
    expect((await call('POST', `/v1/admin/fx/rates/${proposed}/approve`, finA)).body).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect((await call('POST', `/v1/admin/fx/rates/${proposed}/approve`, ops)).body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await rates.current('USD/ILS', now))?.version).toBe(2);
  });

  it('a second, distinct finance user activates it: the port rate is superseded, the audit chain has the entry, and quotes would use 3.7000', async () => {
    const r = await call('POST', `/v1/admin/fx/rates/${proposed}/approve`, finB);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: proposed, version: 3, status: 'active', validFrom: now.toISOString(), approval: { status: 'approved', approvals: 2 } });
    expect(await rates.rateFor('USD', 'ILS', now)).toEqual({ rateId: proposed, pair: 'USD/ILS', version: 3, rateScaled: 3_700_000n });
    expect((await rates.history('USD/ILS')).map((x) => [x.version, x.status])).toEqual([
      [3, 'active'],
      [2, 'superseded'],
      [1, 'superseded'],
    ]);
    const audit = await db.query<{ action: string; subject: string; actor_role: string; payload: Record<string, unknown> }>(`select action, subject, actor_role, payload from audit.entry where action = 'fx_rate.activate'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ subject: 'USD/ILS', actor_role: 'finance', payload: { rateId: proposed } });
    expect((await call('POST', `/v1/admin/fx/rates/${proposed}/approve`, finB)).body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('a manual rate holds past the port window and keeps the worker from publishing; a rejected proposal changes nothing', async () => {
    now = at(50 * 60_000); // well past the 15-minute port window; staff tokens are short-lived, so mint fresh ones
    finA = await staffToken('auth0|finance-a', ['finance']);
    finB = await staffToken('auth0|finance-b', ['finance']);
    expect((await rates.current('USD/ILS', now))?.version).toBe(3);
    expect(await rates.publishFromPort('USD/ILS', 3_750_000n, now)).toBeUndefined();
    expect((await rates.current('USD/ILS', now))?.version).toBe(3);
    const p = await call('POST', '/v1/admin/fx/rates', finA, { mid: '3.80', reason: 'Fat finger test' });
    const id = (p.body as { id: string }).id;
    expect((await call('POST', `/v1/admin/fx/rates/${id}/reject`, finB, {})).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    const rej = await call('POST', `/v1/admin/fx/rates/${id}/reject`, finB, { reason: 'Not the fixing' });
    expect(rej.body).toMatchObject({ id, status: 'rejected', approval: { status: 'rejected' } });
    expect((await call('POST', `/v1/admin/fx/rates/${id}/approve`, finB)).body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await rates.current('USD/ILS', now))?.version).toBe(3);
    expect((await call('GET', '/v1/admin/fx/rates', finA)).body).toMatchObject({ current: { version: 3, mid: '3.700000', source: 'manual' } });
    expect((await call('POST', `/v1/admin/fx/rates/${crypto.randomUUID()}/approve`, finB)).body).toMatchObject({ status: 404 });
  });
});
