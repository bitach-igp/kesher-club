// Receiving currency preference (T-0514, REQ-PAY-007). TST-PAY-007: a member's preference is as sent by
// default, reads and sets through /me/preferences under the bearer alone, refuses unknown values, and
// resolves the purse a send lands in for the send path (USD, ILS, or the sender's currency).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const dan = uuidv7(NOW);
let access = '';

const call = (method: string, url: string, body?: unknown, token = access) => dispatch(app, { method, url, headers: { authorization: `Bearer ${token}` }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  access = (await app.services.tokens.issue({ partyId: dan, deviceId: 'iphone-1', roles: ['member'] })).accessToken;
}, 60_000);
afterAll(async () => db.close());

describe('TST-PAY-007: the receiving currency', () => {
  it('is as sent by default, is set and read under the bearer, and refuses anything else', async () => {
    expect((await dispatch(app, { method: 'GET', url: '/v1/me/preferences', headers: {}, rawBody: '', now: NOW })).status).toBe(401);
    const first = await call('GET', '/v1/me/preferences');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ receiveCurrency: 'as_sent' });
    const set = await call('PATCH', '/v1/me/preferences', { receiveCurrency: 'ILS' });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ receiveCurrency: 'ILS', updatedAt: NOW.toISOString() });
    expect((await call('GET', '/v1/me/preferences')).body).toEqual({ receiveCurrency: 'ILS', updatedAt: NOW.toISOString() });
    expect((await call('PATCH', '/v1/me/preferences', { receiveCurrency: 'EUR' })).body).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((await call('PATCH', '/v1/me/preferences', {})).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await call('GET', '/v1/me/preferences')).body).toMatchObject({ receiveCurrency: 'ILS' });
    expect((await call('PATCH', '/v1/me/preferences', { receiveCurrency: 'as_sent' })).body).toMatchObject({ receiveCurrency: 'as_sent' });
  });

  it('resolves the purse a send lands in: the preference, or the sender\'s currency when as sent', async () => {
    const prefs = app.services.preferences;
    expect(await prefs.receiveCurrencyOf(dan, 'USD')).toBe('USD');
    await prefs.set(dan, 'ILS', NOW);
    expect(await prefs.receiveCurrencyOf(dan, 'USD')).toBe('ILS');
    expect(await prefs.receiveCurrencyOf(dan, 'ILS')).toBe('ILS');
    await prefs.set(dan, 'USD', NOW);
    expect(await prefs.receiveCurrencyOf(dan, 'ILS')).toBe('USD');
    expect(await prefs.receiveCurrencyOf(uuidv7(NOW), 'ILS')).toBe('ILS'); // a member who never set one
    await expect(prefs.set(dan, 'GBP' as never, NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
