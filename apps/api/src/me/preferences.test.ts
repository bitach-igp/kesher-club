// Receiving currency preference (T-0514, REQ-PAY-007) and appearance (T-1020, REQ-UX-002). TST-PAY-007: a member's preference is as sent by
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
    expect(first.body).toEqual({ receiveCurrency: 'as_sent', theme: 'system' });
    const set = await call('PATCH', '/v1/me/preferences', { receiveCurrency: 'ILS' });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ receiveCurrency: 'ILS', theme: 'system', updatedAt: NOW.toISOString() });
    expect((await call('GET', '/v1/me/preferences')).body).toEqual({ receiveCurrency: 'ILS', theme: 'system', updatedAt: NOW.toISOString() });
    expect((await call('PATCH', '/v1/me/preferences', { receiveCurrency: 'EUR' })).body).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((await call('PATCH', '/v1/me/preferences', {})).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await call('GET', '/v1/me/preferences')).body).toMatchObject({ receiveCurrency: 'ILS' });
    expect((await call('PATCH', '/v1/me/preferences', { receiveCurrency: 'as_sent' })).body).toMatchObject({ receiveCurrency: 'as_sent' });
  });

  it('resolves the purse a send lands in: the preference, or the sender\'s currency when as sent', async () => {
    const prefs = app.services.preferences;
    expect(await prefs.receiveCurrencyOf(dan, 'USD')).toBe('USD');
    await prefs.set(dan, { receiveCurrency: 'ILS' }, NOW);
    expect(await prefs.receiveCurrencyOf(dan, 'USD')).toBe('ILS');
    expect(await prefs.receiveCurrencyOf(dan, 'ILS')).toBe('ILS');
    await prefs.set(dan, { receiveCurrency: 'USD' }, NOW);
    expect(await prefs.receiveCurrencyOf(dan, 'ILS')).toBe('USD');
    expect(await prefs.receiveCurrencyOf(uuidv7(NOW), 'ILS')).toBe('ILS'); // a member who never set one
    await expect(prefs.set(dan, { receiveCurrency: 'GBP' as never }, NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('TST-UX-002: the appearance preference', () => {
  const fresh = async () => {
    const id = uuidv7(NOW);
    const token = (await app.services.tokens.issue({ partyId: id, deviceId: 'iphone-9', roles: ['member'] })).accessToken;
    return { id, token, patch: (body: unknown) => call('PATCH', '/v1/me/preferences', body, token), get: () => call('GET', '/v1/me/preferences', undefined, token) };
  };
  const stored = async (id: string) => (await db.query<{ theme: string; receive_currency: string }>('select theme, receive_currency from identity.member_preference where party_id = $1', [id])).rows;

  it('reads system and as sent for a member with no row, and always carries theme', async () => {
    const m = await fresh();
    const r = await m.get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ receiveCurrency: 'as_sent', theme: 'system' });
    expect(await stored(m.id)).toEqual([]);
  });

  it('round-trips all three values; a theme-only first PATCH inserts as sent', async () => {
    const m = await fresh();
    const first = await m.patch({ theme: 'dark' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ receiveCurrency: 'as_sent', theme: 'dark', updatedAt: NOW.toISOString() });
    expect(await stored(m.id)).toEqual([{ theme: 'dark', receive_currency: 'as_sent' }]);
    expect((await m.get()).body).toMatchObject({ theme: 'dark', receiveCurrency: 'as_sent' });
    for (const theme of ['light', 'system', 'dark'] as const) {
      expect((await m.patch({ theme })).body).toMatchObject({ theme });
      expect((await m.get()).body).toMatchObject({ theme });
    }
  });

  it('a patch changes only the fields it carries, and both can travel together', async () => {
    const m = await fresh();
    await m.patch({ theme: 'dark' });
    expect((await m.patch({ receiveCurrency: 'ILS' })).body).toMatchObject({ receiveCurrency: 'ILS', theme: 'dark' });
    expect((await m.get()).body).toMatchObject({ receiveCurrency: 'ILS', theme: 'dark' });
    const other = await fresh();
    await other.patch({ receiveCurrency: 'USD' });
    expect((await other.get()).body).toMatchObject({ receiveCurrency: 'USD', theme: 'system' });
    expect((await other.patch({ theme: 'light' })).body).toMatchObject({ receiveCurrency: 'USD', theme: 'light' });
    expect((await other.get()).body).toMatchObject({ receiveCurrency: 'USD', theme: 'light' });
    expect((await other.patch({ receiveCurrency: 'as_sent', theme: 'dark' })).body).toMatchObject({ receiveCurrency: 'as_sent', theme: 'dark' });
  });

  it('refuses an empty patch, an unknown or non-string theme, and writes nothing', async () => {
    const m = await fresh();
    await m.patch({ theme: 'light' });
    for (const body of [{}, { theme: 'sepia' }, { theme: 3 }, { theme: null }, { theme: 'dark', receiveCurrency: 'EUR' }, { theme: 'Dark' }, { receiveCurrency: 7 }, { theme: null, receiveCurrency: 'ILS' }, { receiveCurrency: 'ILS', theme: 3 }]) {
      const r = await m.patch(body);
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await stored(m.id)).toEqual([{ theme: 'light', receive_currency: 'as_sent' }]);
    expect((await m.get()).body).toMatchObject({ theme: 'light' });
    const none = await fresh();
    expect((await none.patch({ theme: 'sepia' })).status).toBe(422);
    expect(await stored(none.id)).toEqual([]);
    await expect(app.services.preferences.set(none.id, {}, NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a later PATCH advances updatedAt, and a key it does not know is ignored beside a valid field', async () => {
    const m = await fresh();
    await m.patch({ theme: 'dark' });
    const later = new Date(NOW.getTime() + 60_000);
    const r = await dispatch(app, { method: 'PATCH', url: '/v1/me/preferences', headers: { authorization: `Bearer ${m.token}` }, rawBody: JSON.stringify({ theme: 'light', foo: 1 }), now: later });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ receiveCurrency: 'as_sent', theme: 'light', updatedAt: later.toISOString() });
    expect((await m.get()).body).toMatchObject({ theme: 'light', updatedAt: later.toISOString() });
  });

  it('is keyed by the signed-in party: another member is unaffected', async () => {
    const a = await fresh();
    const b = await fresh();
    await a.patch({ theme: 'dark' });
    expect((await b.get()).body).toMatchObject({ theme: 'system' });
    expect((await call('GET', '/v1/me/preferences', undefined, 'not-a-token')).status).toBe(401);
  });

  it('the migration: default system, a NOT VALID check, and sepia refused', async () => {
    const c = await db.query<{ convalidated: boolean }>("select convalidated from pg_constraint where conname = 'member_preference_theme_check'");
    expect(c.rows).toEqual([{ convalidated: false }]);
    const d = await db.query<{ column_default: string; is_nullable: string }>("select column_default, is_nullable from information_schema.columns where table_schema = 'identity' and table_name = 'member_preference' and column_name = 'theme'");
    expect(d.rows).toEqual([{ column_default: "'system'::text", is_nullable: 'NO' }]);
    const id = uuidv7(NOW);
    await db.query('insert into identity.member_preference (party_id, receive_currency) values ($1, $2)', [id, 'USD']);
    expect((await stored(id))[0]?.theme).toBe('system');
    await expect(db.query("insert into identity.member_preference (party_id, receive_currency, theme) values ($1, 'USD', 'sepia')", [uuidv7(NOW)])).rejects.toThrow(/member_preference_theme_check/);
    await expect(db.query("update identity.member_preference set theme = 'sepia' where party_id = $1", [id])).rejects.toThrow(/member_preference_theme_check/);
  });
});
