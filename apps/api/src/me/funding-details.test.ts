// The member's funding details (T-0738, REQ-WAL-002, ADR-018 option 2). TST-WAL-002: legal first and last name, email and an optional date of
// birth (or an invitation email only) are asked once and kept sealed; only the caller reads them back; the reader gives SubAccountService
// `{ owner }` (the mobile unsealed from the account row) or `{ inviteEmail }`, and nothing when no row exists. Fixture data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { parseFundingDetails } from './funding-details.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-18T09:00:00Z');
const sarah = uuidv7(NOW);
const dana = uuidv7(NOW);
const lone = uuidv7(NOW);
const tokens: Record<string, string> = {};
const MOBILE = '+14155550123';
const OWNER = { firstName: 'Sarah', lastName: 'Cohen', email: 'sarah.cohen@example.test', dateOfBirth: '1991-04-17' };

const call = (who: string | undefined, method: string, body?: unknown) =>
  dispatch(app, { method, url: '/v1/me/funding-details', headers: who ? { authorization: `Bearer ${tokens[who]}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const stored = async (id: string) => (await db.query<Record<string, Uint8Array | null>>('select first_name, last_name, email, date_of_birth from identity.member_funding_details where party_id = $1', [id])).rows[0]!;
const bytes = (row: Record<string, Uint8Array | null>) => Object.values(row).map((v) => (v ? Buffer.from(v).toString('latin1') : '')).join('|');

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
  for (const [k, id] of [['sarah', sarah], ['dana', dana], ['lone', lone]] as const) {
    tokens[k] = (await app.services.tokens.issue({ partyId: id, deviceId: `phone-${k}`, roles: ['member'] })).accessToken;
  }
  await app.services.identity.createUser({ partyId: sarah, phone: MOBILE, status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
  await app.services.identity.createUser({ partyId: dana, phone: '+14155550124', status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
}, 60_000);
afterAll(async () => db.close());

describe('TST-WAL-002: the funding details', () => {
  it('is 401 without a bearer, and 404 on GET until something is stored', async () => {
    expect((await call(undefined, 'GET')).status).toBe(401);
    expect((await call(undefined, 'PATCH', OWNER)).status).toBe(401);
    expect(await call('sarah', 'GET')).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  });

  it('stores the four values sealed, answers them back to the caller only, and a second PATCH replaces', async () => {
    const set = await call('sarah', 'PATCH', { firstName: ' Sarah ', lastName: 'Cohen', email: 'sarah.cohen@example.test', dateOfBirth: '1991-04-17' });
    expect(set).toMatchObject({ status: 200, body: { ...OWNER, updatedAt: NOW.toISOString() } });
    expect((await call('sarah', 'GET')).body).toEqual(set.body);
    const raw = bytes(await stored(sarah));
    for (const v of ['Sarah', 'Cohen', 'example.test', '1991']) expect(raw).not.toContain(v);
    expect((await call('dana', 'GET')).status).toBe(404);

    expect((await call('sarah', 'PATCH', { firstName: 'Sara', lastName: 'Levi', email: 'sara.levi@example.test' })).body).toEqual({ firstName: 'Sara', lastName: 'Levi', email: 'sara.levi@example.test', updatedAt: NOW.toISOString() });
    expect((await db.query('select 1 from identity.member_funding_details where party_id = $1', [sarah])).rowCount).toBe(1);
    expect(await app.services.fundingDetails.read(sarah)).toEqual({ owner: { firstName: 'Sara', lastName: 'Levi', email: 'sara.levi@example.test', mobile: MOBILE } });
  });

  it('does not need T1 KYC, and the member can restore the date of birth', async () => {
    expect((await call('sarah', 'PATCH', OWNER)).status).toBe(200);
    expect(await app.services.fundingDetails.read(sarah)).toEqual({ owner: { ...OWNER, mobile: MOBILE } });
  });

  it('reads `undefined` when nothing is stored, and an invitation email alone as `{ inviteEmail }`', async () => {
    expect(await app.services.fundingDetails.read(dana)).toBeUndefined();
    const set = await call('dana', 'PATCH', { inviteEmail: 'dana.parent@example.test' });
    expect(set).toMatchObject({ status: 200, body: { inviteEmail: 'dana.parent@example.test' } });
    expect(Object.keys(set.body as object).sort()).toEqual(['inviteEmail', 'updatedAt']);
    expect((await call('dana', 'GET')).body).toEqual(set.body);
    expect(await app.services.fundingDetails.read(dana)).toEqual({ inviteEmail: 'dana.parent@example.test' });
    expect(bytes(await stored(dana))).not.toContain('example.test');
    // Owner details then replace the invitation, and the invitation no longer reads.
    await call('dana', 'PATCH', { firstName: 'Dana', lastName: 'Mizrahi', email: 'dana.m@example.test' });
    expect(await app.services.fundingDetails.read(dana)).toEqual({ owner: { firstName: 'Dana', lastName: 'Mizrahi', email: 'dana.m@example.test', mobile: '+14155550124' } });
  });

  it('reads nothing for owner details when the account row is gone (no phone to give)', async () => {
    await call('lone', 'PATCH', OWNER);
    expect(await app.services.fundingDetails.read(lone)).toBeUndefined();
  });

  it('refuses bad input naming the field, changes nothing, and echoes no value', async () => {
    const ok = { firstName: 'Sarah', lastName: 'Cohen', email: 'sarah.cohen@example.test' };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...ok, firstName: '   ' }, 'firstName'],
      [{ ...ok, firstName: 'A'.repeat(81) }, 'firstName'],
      [{ ...ok, firstName: 'Sa\u0000rah' }, 'firstName'],
      [{ ...ok, lastName: '' }, 'lastName'],
      [{ ...ok, lastName: 'Co‮hen' }, 'lastName'],
      [{ ...ok, email: 'not-an-email' }, 'email'],
      [{ ...ok, email: `${'a'.repeat(250)}@example.test` }, 'email'],
      [{ ...ok, dateOfBirth: '1899-12-31' }, 'dateOfBirth'],
      [{ ...ok, dateOfBirth: '2026-11-19' }, 'dateOfBirth'],
      [{ ...ok, dateOfBirth: '2021-02-30' }, 'dateOfBirth'],
      [{ ...ok, dateOfBirth: '17/04/1991' }, 'dateOfBirth'],
      [{ ...ok, inviteEmail: 'x@example.test' }, 'firstName'],
      [{ inviteEmail: 'bad' }, 'inviteEmail'],
      [{ inviteEmail: 'x@example.test', dateOfBirth: '1991-04-17' }, 'dateOfBirth'],
      [{ firstName: 'Sarah', email: 'sarah.cohen@example.test' }, 'lastName'],
      [{}, 'firstName'],
    ];
    for (const [body, field] of cases) {
      const r = await call('sarah', 'PATCH', body);
      expect(r, JSON.stringify(Object.keys(body))).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED', field } });
      expect(JSON.stringify(r.body)).not.toMatch(/Cohen|example\.test|1991|2021/);
    }
    expect((await call('sarah', 'GET')).body).toMatchObject({ ...OWNER });
  });

  it('NFC-normalises and trims names', () => {
    const p = parseFundingDetails({ firstName: ' Zoé ', lastName: ' Bar ', email: 'z@example.test' });
    expect(p).toMatchObject({ firstName: 'Zoé', lastName: 'Bar' });
  });

  it('writes an audit entry naming the fields changed and no value', async () => {
    const rows = (await db.query<{ action: string; reason: string; payload: unknown }>(`select action, reason, payload from audit.entry where action = 'member.funding_details.update'`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/Sarah|Cohen|example\.test|1991|Dana|Mizrahi/);
    expect(rows[0]!.payload).toMatchObject({ fields: expect.any(Array) });
  });

  it('migration grants: club_app may select, insert and update the table and nothing else', async () => {
    const priv = async (p: string) => (await db.query<{ ok: boolean }>(`select has_table_privilege('club_app', 'identity.member_funding_details', $1) as ok`, [p])).rows[0]!.ok;
    expect([await priv('select'), await priv('insert'), await priv('update')]).toEqual([true, true, true]);
    expect([await priv('delete'), await priv('truncate'), await priv('references'), await priv('trigger')]).toEqual([false, false, false, false]);
  });

  describe('the member_funding_details_shape check', () => {
    // Raw bytea stand-ins (the check looks at null or not null only). Each insert is its own statement: a failing one aborts a PGlite transaction.
    const insert = (cols: { first?: boolean; last?: boolean; dob?: boolean }) =>
      db.query(
        'insert into identity.member_funding_details (party_id, first_name, last_name, email, date_of_birth, updated_at) values ($1, $2, $3, $4, $5, $6)',
        [uuidv7(NOW), cols.first ? Buffer.from([1]) : null, cols.last ? Buffer.from([1]) : null, Buffer.from([1]), cols.dob ? Buffer.from([1]) : null, NOW],
      );

    it('rejects a first name without a last name', async () => {
      await expect(insert({ first: true })).rejects.toThrow(/member_funding_details_shape/);
    });

    it('rejects a last name without a first name', async () => {
      await expect(insert({ last: true })).rejects.toThrow(/member_funding_details_shape/);
    });

    it('rejects a date of birth without an owner', async () => {
      await expect(insert({ dob: true })).rejects.toThrow(/member_funding_details_shape/);
    });

    it('accepts an email alone', async () => {
      await expect(insert({})).resolves.toBeDefined();
    });

    it('accepts a whole owner, with and without a date of birth', async () => {
      await expect(insert({ first: true, last: true })).resolves.toBeDefined();
      await expect(insert({ first: true, last: true, dob: true })).resolves.toBeDefined();
    });
  });
});

