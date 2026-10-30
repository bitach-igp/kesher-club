// The name others see when paying a member (T-0531, REQ-PAY-008). TST-PAY-008: a member sets it under the bearer
// alone; "Avi" and "Example" read back as "Avi E."; the stored row holds sealed bytes, neither plaintext, and
// nothing else of the last name; a Hebrew name with a gershayim is kept; digits, a URL or an emoji answer 422
// naming the field; a second PATCH replaces the first; one member never reads another's name.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { formatDisplayName, parseName } from './display-name.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const avi = uuidv7(NOW);
const noa = uuidv7(NOW);
const tokens: Record<string, string> = {};

const call = (who: string, method: string, body?: unknown) => dispatch(app, { method, url: '/v1/me/display-name', headers: { authorization: `Bearer ${tokens[who]}` }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  for (const [k, id] of [['avi', avi], ['noa', noa]] as const) tokens[k] = (await app.services.tokens.issue({ partyId: id, deviceId: `phone-${k}`, roles: ['member'] })).accessToken;
}, 60_000);
afterAll(async () => db.close());

describe('TST-PAY-008: the name others see', () => {
  it('is empty until set; "Avi" and "Example" read "Avi E."; the row holds sealed bytes and nothing more of the last name', async () => {
    expect((await dispatch(app, { method: 'GET', url: '/v1/me/display-name', headers: {}, rawBody: '', now: NOW })).status).toBe(401);
    expect((await call('avi', 'GET')).body).toEqual({});
    const set = await call('avi', 'PATCH', { firstName: '  Avi ', lastName: 'Example' });
    expect(set).toMatchObject({ status: 200, body: { displayName: 'Avi E.', firstName: 'Avi', lastInitial: 'E', updatedAt: NOW.toISOString() } });
    expect((await call('avi', 'GET')).body).toEqual(set.body);
    const row = (await db.query<{ first_name: Uint8Array; last_initial: Uint8Array }>('select first_name, last_initial from identity.member_display_name where party_id = $1', [avi])).rows[0]!;
    const stored = Buffer.concat([Buffer.from(row.first_name), Buffer.from(row.last_initial)]).toString('latin1');
    expect(stored).not.toContain('Avi');
    expect(stored).not.toContain('Example');
    expect(row.last_initial.length).toBeLessThan(40);
    // One member never reads another's.
    expect((await call('noa', 'GET')).body).toEqual({});
  });

  it('keeps Hebrew with a gershayim and a first name alone; a second PATCH replaces the first', async () => {
    expect((await call('noa', 'PATCH', { firstName: 'נועה', lastName: 'כ״ץ' })).body).toMatchObject({ displayName: 'נועה כ.', lastInitial: 'כ' });
    expect((await call('noa', 'PATCH', { firstName: "D'Arcy-Lee" })).body).toEqual({ displayName: "D'Arcy-Lee", firstName: "D'Arcy-Lee", updatedAt: NOW.toISOString() });
    expect((await db.query('select 1 from identity.member_display_name where party_id = $1', [noa])).rowCount).toBe(1);
  });

  it('refuses digits, a URL, an emoji, an empty or overlong name, naming the field, and changes nothing', async () => {
    for (const [body, field] of [
      [{ firstName: 'Avi2' }, 'firstName'],
      [{ firstName: 'https://kesher.example' }, 'firstName'],
      [{ firstName: 'Avi 🙂' }, 'firstName'],
      [{ firstName: '   ' }, 'firstName'],
      [{ firstName: 'A'.repeat(41) }, 'firstName'],
      [{ firstName: 'Avi', lastName: 'Ex4mple' }, 'lastName'],
      [{}, 'firstName'],
    ] as const) {
      expect((await call('avi', 'PATCH', body)).body).toMatchObject({ status: 422, code: 'VALIDATION_FAILED', field });
    }
    expect((await call('avi', 'GET')).body).toMatchObject({ displayName: 'Avi E.' });
  });

  it('formats and parses without the database', () => {
    expect([formatDisplayName('Avi', 'E'), formatDisplayName('Avi', undefined)]).toEqual(['Avi E.', 'Avi']);
    expect(parseName({ firstName: 'avi', lastName: 'example' })).toEqual({ firstName: 'avi', lastInitial: 'E' });
    expect(parseName({ firstName: 'Ava   Rose', lastName: '  ' })).toEqual({ firstName: 'Ava Rose' });
  });
});
