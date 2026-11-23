// The name others see when paying a member (T-0531, REQ-PAY-008). TST-PAY-008: a member sets it under the bearer
// alone; "Avi" and "Example" read back as "Avi E."; the stored row holds sealed bytes, neither plaintext, and
// nothing else of the last name; a Hebrew name with a gershayim is kept; digits, a URL or an emoji answer 422
// naming the field; a second PATCH replaces the first; one member never reads another's name.
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
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

// T-0776: a funder's membership list reads the names of the members they pay for in one query, and answers
// byte for byte what it answered when it read them one by one. Expectations are written out, not computed by
// the code under test (the old code's own `get` is the oracle for `getMany`).
describe('listMemberships and getMany read funder-visible names together (T-0776)', () => {
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  const [funder, other, avi2, noa2, bare, hebrew, twice, nobody] = Array.from({ length: 8 }, () => uuidv7(NOW)) as [string, string, string, string, string, string, string, string];
  const memberOnly = uuidv7(NOW); // no membership at all
  const ghost = uuidv7(NOW); // has no name row at all
  const nameQueries = (calls: readonly unknown[][]) => calls.filter((c) => /identity\.member_display_name/.test(String(c[0])));
  const memberships = async (who: string) => dispatch(app, { method: 'GET', url: '/v1/memberships', headers: { authorization: `Bearer ${tokens[who]}` }, rawBody: '', now: NOW });
  const items = (r: { body?: unknown }) => (r.body as { items: { memberPartyId: string; role: string; memberName?: string }[] }).items;

  beforeAll(async () => {
    const s = app.services;
    await s.plans.ensurePlan('club', 'Kesher Club');
    await s.plans.createVersion({ planCode: 'club', price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    for (const [k, id] of [['funder', funder], ['other', other], ['memberOnly', memberOnly], ['nobody', nobody]] as const) tokens[k] = (await s.tokens.issue({ partyId: id!, deviceId: `phone-${k}`, roles: ['member'] })).accessToken;
    await s.displayNames.set(avi2!, { firstName: 'Avi', lastName: 'Example' }, NOW);
    await s.displayNames.set(noa2!, { firstName: 'Noa' }, NOW);
    await s.displayNames.set(hebrew!, { firstName: 'נועה', lastName: 'כ״ץ' }, NOW);
    await s.displayNames.set(twice!, { firstName: 'Twice', lastName: 'Tester' }, NOW);
    await s.displayNames.set(nobody!, { firstName: 'Nobody', lastName: 'Nameless' }, NOW);
    // oldest first: avi2, noa2, bare, hebrew, twice (cancelled), twice again, then a membership the funder is the member of
    const make = (key: string, member: string, funderId: string, minutes: number) => s.memberships.create({ idempotencyKey: `k-${key}-${funderId.slice(-8)}`, memberPartyId: member, funderPartyId: funderId, funderEmail: 'funder@example.com', planCode: 'club' }, at(minutes));
    await make('avi2', avi2!, funder!, 1);
    await make('noa2', noa2!, funder!, 2);
    await make('bare', bare!, funder!, 3);
    await make('hebrew', hebrew!, funder!, 4);
    const first = await make('twice-1', twice!, funder!, 5);
    await db.query(`update billing.membership set status = 'cancelled' where id = $1`, [first.id]);
    await make('twice-2', twice!, funder!, 6);
    await make('funder-is-member', funder!, other!, 7);
    // a funder whose only membership has a member with no name row, and a party with no membership
    await make('nobody', nobody!, other!, 8);
  });

  it('shows the funder the first name and initial of each member they pay for, "Member" where there is no name, none for the membership they receive', async () => {
    const r = await memberships('funder');
    expect(r.status).toBe(200);
    // newest first: created_at desc
    expect(items(r).map((m) => [m.memberPartyId, m.role, m.memberName])).toEqual([
      [funder, 'member', undefined],
      [twice, 'funder', 'Twice T.'],
      [twice, 'funder', 'Twice T.'],
      [hebrew, 'funder', 'נועה כ.'],
      [bare, 'funder', 'Member'],
      [noa2, 'funder', 'Noa'],
      [avi2, 'funder', 'Avi E.'],
    ]);
    expect(Object.keys(items(r)[0]!)).not.toContain('memberName');
    expect(r.body).toEqual({ items: expect.arrayContaining([expect.objectContaining({ role: 'funder', memberName: 'Avi E.', memberPartyId: avi2 })]) });
  });

  it('shows each member the name get answers for them (the one-by-one read is the oracle)', async () => {
    const r = await memberships('funder');
    for (const m of items(r).filter((x) => x.role === 'funder')) expect(m.memberName).toBe((await app.services.displayNames.get(m.memberPartyId)).displayName ?? 'Member');
  });

  it('puts no part of a name outside first name and initial on the wire, and prints nothing', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const r = await memberships('funder');
    const printed = logs.reduce((n, l) => n + l.mock.calls.length, 0);
    logs.forEach((l) => l.mockRestore());
    expect(printed).toBe(0);
    expect(JSON.stringify(r.body)).not.toMatch(/Example|Tester|כ״ץ|first_name|last_initial/);
  });

  it('answers an empty list for a party with no membership and reads no name for it', async () => {
    const spy = vi.spyOn(db, 'query');
    const r = await memberships('memberOnly');
    const n = nameQueries(spy.mock.calls).length;
    spy.mockRestore();
    expect(r.body).toEqual({ items: [] });
    expect(n).toBe(0);
  });

  it('reads no name for a party that is only ever the member, and shows no memberName', async () => {
    const spy = vi.spyOn(db, 'query');
    const r = await memberships('nobody');
    const n = nameQueries(spy.mock.calls).length;
    spy.mockRestore();
    expect(items(r).map((m) => [m.memberPartyId, m.role, m.memberName])).toEqual([[nobody, 'member', undefined]]);
    expect(n).toBe(0);
  });

  it('shows another funder the name of a member who has one and "Member" for one who has none', async () => {
    const r = await memberships('other');
    expect(items(r).map((m) => [m.memberPartyId, m.role, m.memberName])).toEqual([
      [nobody, 'funder', 'Nobody N.'],
      [funder, 'funder', 'Member'],
    ]);
  });

  it('reads the names of that funder\'s 2 members in one query', async () => {
    const spy = vi.spyOn(db, 'query');
    await memberships('other');
    const n = nameQueries(spy.mock.calls).length;
    spy.mockRestore();
    expect(n).toBe(1);
  });

  it('get answers a first name with an initial, a first name alone, a Hebrew name, and {} for no row', async () => {
    const svc = app.services.displayNames;
    expect(await svc.get(avi2!)).toEqual({ displayName: 'Avi E.', firstName: 'Avi', lastInitial: 'E', updatedAt: NOW.toISOString() });
    expect(await svc.get(noa2!)).toEqual({ displayName: 'Noa', firstName: 'Noa', updatedAt: NOW.toISOString() });
    expect(await svc.get(hebrew!)).toEqual({ displayName: 'נועה כ.', firstName: 'נועה', lastInitial: 'כ', updatedAt: NOW.toISOString() });
    expect(await svc.get(ghost)).toEqual({});
  });

  it('reads the names of the 6 memberships a funder pays for in one query, not one per membership', async () => {
    const spy = vi.spyOn(db, 'query');
    await memberships('funder');
    const n = nameQueries(spy.mock.calls).length;
    spy.mockRestore();
    expect(n).toBe(1);
  });

  it('getMany answers what get answers for each id, in the order first asked, once for a repeat, {} for no row, in one query', async () => {
    const svc = app.services.displayNames;
    const ids = [hebrew!, ghost, avi2!, noa2!, avi2!, bare!];
    const spy = vi.spyOn(db, 'query');
    const many = await svc.getMany(ids);
    const n = nameQueries(spy.mock.calls).length;
    spy.mockRestore();
    expect(n).toBe(1);
    expect([...many.keys()]).toEqual([hebrew, ghost, avi2, noa2, bare]);
    for (const id of new Set(ids)) expect(many.get(id)).toEqual(await svc.get(id));
    expect(many.get(ghost)).toEqual({});
    expect(many.get(avi2!)).toMatchObject({ displayName: 'Avi E.', firstName: 'Avi', lastInitial: 'E' });
    expect(many.get(noa2!)).toEqual({ displayName: 'Noa', firstName: 'Noa', updatedAt: NOW.toISOString() });
  });

  it('getMany sends each distinct id once, as one uuid array', async () => {
    const spy = vi.spyOn(db, 'query');
    await app.services.displayNames.getMany([avi2!, noa2!, avi2!, noa2!]);
    const calls = nameQueries(spy.mock.calls);
    spy.mockRestore();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toMatch(/party_id = any\(\$1::uuid\[\]\)/);
    expect(calls[0]![1]).toEqual([[avi2, noa2]]);
  });

  it('getMany reads nothing for an empty list', async () => {
    const spy = vi.spyOn(db, 'query');
    const many = await app.services.displayNames.getMany([]);
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(many.size).toBe(0);
    expect(calls).toBe(0);
  });

  it('getMany equals the one-by-one reads for any list of named, unnamed and repeated ids (differential)', async () => {
    const svc = app.services.displayNames;
    const pool = [avi2!, noa2!, hebrew!, twice!, bare, ghost, uuidv7(NOW)];
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...pool), { maxLength: 20 }), async (ids) => {
        const old = new Map<string, Awaited<ReturnType<typeof svc.get>>>();
        for (const id of ids) if (!old.has(id)) old.set(id, await svc.get(id));
        expect([...(await svc.getMany(ids))]).toEqual([...old]);
      }),
      { numRuns: 30 },
    );
  });
});
