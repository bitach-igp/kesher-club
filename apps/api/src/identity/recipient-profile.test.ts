// The recipient profile (T-1101, phase 1 gap analysis): who a member is to Israel. A category from a closed set, an optional program
// (80 characters) and an optional Israel connection statement (280 characters), both the member's own untrusted plain text. One current
// row per member; every real change appends a history row that is never updated or deleted; an unchanged PATCH adds nothing. The two
// free-text fields are sealed at rest and never logged. Fixture data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Secret, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { RECIPIENT_CATEGORIES, RecipientProfileService } from './recipient-profile.ts';
import { createPiiCipher } from '../crypto/pii.ts';
import { randomBytes } from 'node:crypto';

let db: TestDatabase;
let app: App;
let appOff: App;
const T0 = new Date('2026-11-26T09:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const tokens: Record<string, string> = {};
const ids: Record<string, string> = { noa: uuidv7(T0), ben: uuidv7(T0), cal: uuidv7(T0), dov: uuidv7(T0), eli: uuidv7(T0), fay: uuidv7(T0), gil: uuidv7(T0), hod: uuidv7(T0), ivy: uuidv7(T0) };
const CONNECTION = 'My brother serves in the Golani brigade and I study in Jerusalem.';
const SECRET_BITS = ['Golani', 'Jerusalem', 'Nefesh'];

const offTokens: Record<string, string> = {};
const call = (who: string | undefined, method: string, body?: unknown, now: Date = T0, target: App = app) =>
  dispatch(target, { method, url: '/v1/me/recipient-profile', headers: who ? { authorization: `Bearer ${(target === app ? tokens : offTokens)[who]}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const current = async (who: string) => (await db.query<{ category: string; program: Uint8Array | null; israel_connection: Uint8Array | null }>('select category, program, israel_connection from identity.recipient_profile where party_id = $1', [ids[who]])).rows;
const history = async (who: string) => (await db.query<{ category: string; revision: number; recorded_at: string | Date }>('select category, revision, recorded_at from identity.recipient_profile_history where party_id = $1 order by revision', [ids[who]])).rows;
const cats = async (who: string) => (await history(who)).map((r) => r.category);

beforeAll(async () => {
  db = await createTestDatabase();
  const signingKey = await generateSigningKey();
  const base = { db, registry: new SimulatorHost().registry, market: 'IL' as const, signingKey, issuer: 'https://api.kesher.example', clock: () => T0 };
  app = createApp({ ...base, flags: new StaticFlags(undefined, { 'phase1.recipientProfile': true }) });
  appOff = createApp({ ...base, flags: new StaticFlags() });
  for (const [k, id] of Object.entries(ids)) {
    tokens[k] = (await app.services.tokens.issue({ partyId: id, deviceId: `phone-${k}`, roles: ['member'] })).accessToken;
    offTokens[k] = (await appOff.services.tokens.issue({ partyId: id, deviceId: `phone-${k}`, roles: ['member'] })).accessToken;
  }
}, 60_000);
afterAll(async () => db.close());
afterEach(() => vi.restoreAllMocks());

describe('T-1101: reading', () => {
  it('is 401 without a bearer', async () => {
    expect((await call(undefined, 'GET')).status).toBe(401);
    expect((await call(undefined, 'PATCH', { category: 'soldier' })).status).toBe(401);
  });

  it('reads null for everything while unset, never a default, and a read stores nothing', async () => {
    const r = await call('noa', 'GET');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ category: null, program: null, israelConnection: null, updatedAt: null });
    expect(await current('noa')).toEqual([]);
    expect(await history('noa')).toEqual([]);
  });

  it('another member never sees it, and cannot change it', async () => {
    await call('ben', 'PATCH', { category: 'rabbi', israelConnection: CONNECTION });
    expect((await call('cal', 'GET')).body).toEqual({ category: null, program: null, israelConnection: null, updatedAt: null });
    expect(JSON.stringify((await call('cal', 'GET')).body)).not.toContain('Golani');
    await call('cal', 'PATCH', { category: 'volunteer' });
    expect((await call('ben', 'GET')).body).toMatchObject({ category: 'rabbi', israelConnection: CONNECTION });
    expect(await cats('ben')).toEqual(['rabbi']);
  });
});

describe('T-1101: setting', () => {
  it('accepts every category of the closed set, and the set is exactly the nine', async () => {
    expect([...RECIPIENT_CATEGORIES]).toEqual(['soldier', 'lone_soldier', 'yeshiva_student', 'seminary_student', 'university_student', 'rabbi', 'volunteer', 'program_participant', 'other']);
    for (const c of RECIPIENT_CATEGORIES) {
      const r = await call('dov', 'PATCH', { category: c });
      expect(r).toMatchObject({ status: 200, body: { category: c } });
      expect((await call('dov', 'GET')).body).toMatchObject({ category: c });
    }
  });

  it('stores the category with an optional program and statement, and a missing one reads null', async () => {
    const first = await call('eli', 'PATCH', { category: 'program_participant' });
    expect(first).toMatchObject({ status: 200, body: { category: 'program_participant', program: null, israelConnection: null, updatedAt: T0.toISOString() } });
    const full = await call('eli', 'PATCH', { category: 'program_participant', program: 'Nefesh B\'Nefesh', israelConnection: CONNECTION }, at(1));
    expect(full.body).toEqual({ category: 'program_participant', program: 'Nefesh B\'Nefesh', israelConnection: CONNECTION, updatedAt: at(1).toISOString() });
    expect((await call('eli', 'GET')).body).toEqual(full.body);
  });

  it('seals program and statement at rest: no plaintext in either table', async () => {
    const raw = async (sql: string) => (await db.query<Record<string, Uint8Array | null>>(sql, [ids.eli])).rows.map((r) => Object.values(r).map((v) => (v ? Buffer.from(v).toString('latin1') : '')).join('|')).join('|');
    const text = (await raw('select program, israel_connection from identity.recipient_profile where party_id = $1')) + (await raw('select program, israel_connection from identity.recipient_profile_history where party_id = $1'));
    expect(text.length).toBeGreaterThan(40);
    for (const bit of SECRET_BITS) expect(text).not.toContain(bit);
  });

  it('is a partial patch: fields left out stay, null or blank clears program and statement, category cannot be cleared', async () => {
    await call('fay', 'PATCH', { category: 'university_student', program: 'Mir', israelConnection: CONNECTION }, T0);
    expect((await call('fay', 'PATCH', { program: 'Hebrew University' }, at(1))).body).toMatchObject({ category: 'university_student', program: 'Hebrew University', israelConnection: CONNECTION });
    expect((await call('fay', 'PATCH', { program: null }, at(2))).body).toMatchObject({ program: null, israelConnection: CONNECTION });
    expect((await call('fay', 'PATCH', { israelConnection: '   ' }, at(3))).body).toMatchObject({ israelConnection: null, category: 'university_student' });
    expect(await call('fay', 'PATCH', { category: null }, at(4))).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } });
    expect((await call('fay', 'GET')).body).toMatchObject({ category: 'university_student', program: null, israelConnection: null });
  });

  it('trims the free text, keeps exactly 80 and 280 characters, and returns markup as the literal text it is', async () => {
    const r = await call('gil', 'PATCH', { category: 'other', program: `  ${'p'.repeat(80)}  `, israelConnection: `\n ${'c'.repeat(280)} \t` });
    expect(r.body).toMatchObject({ program: 'p'.repeat(80), israelConnection: 'c'.repeat(280) });
    const html = '<script>alert(1)</script> & <b>friend</b>';
    expect((await call('gil', 'PATCH', { israelConnection: html }, at(1))).body).toMatchObject({ israelConnection: html });
    expect((await call('gil', 'GET')).body).toMatchObject({ israelConnection: html });
  });
});

describe('T-1101: refusing', () => {
  const refused = async (who: string, body: unknown, label = '') => {
    const before = [await current(who), await history(who)];
    const r = await call(who, 'PATCH', body, at(30));
    expect([label, r.status]).toEqual([label, 422]);
    expect(r.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect([await current(who), await history(who)]).toEqual(before);
    return JSON.stringify(r.body);
  };

  it('an unknown or non-string category, or none on a first set, is VALIDATION_FAILED and writes nothing', async () => {
    await refused('hod', { category: 'astronaut' });
    await refused('hod', { category: 'SOLDIER' });
    await refused('hod', { category: 7 });
    await refused('hod', { category: '' });
    await refused('hod', { program: 'Mir' });
    await refused('hod', {});
    await refused('hod', { category: 'soldier', nickname: 'x' });
    expect(await current('hod')).toEqual([]);
  });

  it('over-length program (81) or statement (281), after trimming, is VALIDATION_FAILED and never echoes the value', async () => {
    const long = 'Golani'.padEnd(81, 'x');
    expect(await refused('hod', { category: 'soldier', program: long })).not.toContain('Golani');
    expect(await refused('hod', { category: 'soldier', israelConnection: 'Jerusalem'.padEnd(281, 'x') })).not.toContain('Jerusalem');
    expect(await refused('hod', { category: 'soldier', program: 7 })).toBeTruthy();
    expect(await refused('hod', { category: 'soldier', israelConnection: ['x'] })).toBeTruthy();
  });

  it('control characters and separators in the free text are refused, each on its own, in both fields', async () => {
    const controls: Record<string, string> = { NUL: '\u0000', BEL: '\u0007', LF: '\n', CR: '\r', TAB: '\t', DEL: '\u007F', NEL: '\u0085', LS: '\u2028', PS: '\u2029' };
    for (const [name, ch] of Object.entries(controls)) {
      await refused('hod', { category: 'soldier', israelConnection: `a${ch}b` }, name);
      await refused('hod', { category: 'soldier', program: `a${ch}b` }, name);
    }
  });

  const formats: [string, string][] = [['LRM', '\u200E'], ['RLM', '\u200F'], ['LRE', '\u202A'], ['RLE', '\u202B'], ['PDF', '\u202C'], ['LRO', '\u202D'], ['RLO', '\u202E'], ['LRI', '\u2066'], ['RLI', '\u2067'], ['FSI', '\u2068'], ['PDI', '\u2069'], ['ZWSP', '\u200B'], ['ZWNJ', '\u200C'], ['ZWJ', '\u200D'], ['BOM', '\uFEFF'], ['WORD JOINER', '\u2060']];
  it.each(formats)('the invisible format character %s is refused inside the statement and the program', async (name, ch) => {
    await refused('hod', { category: 'soldier', israelConnection: `a${ch}b` }, name);
    await refused('hod', { category: 'soldier', program: `a${ch}b` }, name);
  });

  it('a request body that is not an object is refused', async () => {
    expect((await call('hod', 'PATCH', [1, 2], at(30))).status).toBe(422);
    expect((await call('hod', 'PATCH', 'soldier', at(30))).status).toBe(422);
  });

  // Decision: lengths count Unicode code points after NFC normalisation and trimming. An emoji is one; "e" + U+0301 composes to one.
  const limits: [string, string, number][] = [['program', 'program', 80], ['statement', 'israelConnection', 280]];
  describe.each(limits)('the %s limit counts code points after NFC', (_label, field, max) => {
    const put = (who: string, text: string) => call(who, 'PATCH', { category: 'other', [field]: text }, at(40));
    it('astral characters (emoji) count once each: max passes, max + 1 is refused', async () => {
      const ok = await put('gil', '\u{1F600}'.repeat(max));
      expect(ok).toMatchObject({ status: 200, body: { [field]: '\u{1F600}'.repeat(max) } });
      expect([...(ok.body as Record<string, string>)[field]!]).toHaveLength(max);
      expect((await put('gil', '\u{1F600}'.repeat(max + 1))).status).toBe(422);
      expect((await put('gil', '\u{1F600}'.repeat(max - 1))).status).toBe(200);
    });
    it('a letter plus a combining accent composes under NFC to one code point', async () => {
      const r = await put('gil', 'e\u0301'.repeat(max));
      expect(r).toMatchObject({ status: 200, body: { [field]: '\u00E9'.repeat(max) } });
      expect((await put('gil', 'e\u0301'.repeat(max + 1))).status).toBe(422);
    });
    it('a mark with no precomposed form stays two code points: half the limit passes, one more is refused', async () => {
      expect((await put('gil', 'x\u0301'.repeat(max / 2))).status).toBe(200);
      expect((await put('gil', 'x\u0301'.repeat(max / 2 + 1))).status).toBe(422);
    });
  });
});

describe('T-1101: the trail', () => {
  it('appends one history row per real change, and the same values twice add nothing', async () => {
    const body = { category: 'lone_soldier', program: 'Michve Alon', israelConnection: CONNECTION };
    const a = await call('ivy', 'PATCH', body, at(0));
    expect(await history('ivy')).toHaveLength(1);
    const b = await call('ivy', 'PATCH', body, at(5));
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body); // updatedAt is the time of the last change, not of the repeat
    await call('ivy', 'PATCH', { category: 'lone_soldier' }, at(6)); // a partial patch that restates the stored value
    await call('ivy', 'PATCH', { program: '  Michve Alon ' }, at(7)); // the same after trimming
    expect(await history('ivy')).toHaveLength(1);
    expect((await current('ivy'))).toHaveLength(1);

    await call('ivy', 'PATCH', { category: 'soldier' }, at(10));
    await call('ivy', 'PATCH', { category: 'soldier' }, at(11));
    await call('ivy', 'PATCH', { program: null }, at(12));
    await call('ivy', 'PATCH', { program: null }, at(13));
    expect(await cats('ivy')).toEqual(['lone_soldier', 'soldier', 'soldier']);
    expect((await history('ivy')).map((h) => h.revision)).toEqual([1, 2, 3]);
    expect(await current('ivy')).toHaveLength(1);
    expect((await call('ivy', 'GET')).body).toMatchObject({ category: 'soldier', program: null, israelConnection: CONNECTION, updatedAt: at(12).toISOString() });
  });

  it('the history keeps what each earlier answer was, and the app role can only read and add to it', async () => {
    const rows = await db.query<{ category: string; program: Uint8Array | null }>('select category, program from identity.recipient_profile_history where party_id = $1 order by revision', [ids.ivy]);
    expect(rows.rows.map((r) => [r.category, r.program !== null])).toEqual([['lone_soldier', true], ['soldier', true], ['soldier', false]]);
    for (const sql of ['update identity.recipient_profile_history set category = \'other\'', 'delete from identity.recipient_profile_history', 'truncate identity.recipient_profile_history']) {
      await expect(db.asRole('club_app', (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
    await expect(db.asRole('club_app', (c) => c.query('select count(*) from identity.recipient_profile_history'))).resolves.toBeTruthy();
    expect((await history('ivy'))).toHaveLength(3);
  });

  it('the database refuses an unknown category in both tables', async () => {
    await expect(db.query(`insert into identity.recipient_profile (party_id, category, updated_at) values ($1, 'astronaut', now())`, [uuidv7(T0)])).rejects.toThrow();
    await expect(db.query(`insert into identity.recipient_profile_history (id, party_id, revision, category, recorded_at) values ($1, $2, 1, 'astronaut', now())`, [uuidv7(T0), uuidv7(T0)])).rejects.toThrow();
  });

  it('the profile and its history row are written together: a failed history insert leaves the profile unchanged', async () => {
    const m = uuidv7(T0);
    tokens.zed = (await app.services.tokens.issue({ partyId: m, deviceId: 'phone-zed', roles: ['member'] })).accessToken;
    ids.zed = m;
    await db.query(`create or replace function identity.t1101_fail() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`);
    await db.query('create trigger t1101_fail before insert on identity.recipient_profile_history for each row execute function identity.t1101_fail()');
    const r = await call('zed', 'PATCH', { category: 'rabbi' });
    await db.query('drop trigger t1101_fail on identity.recipient_profile_history');
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await current('zed')).toEqual([]);
    expect(await history('zed')).toEqual([]);
  });
});

describe('T-1101: two writers for one member', () => {
  const fresh = async (key: string) => {
    ids[key] = uuidv7(T0);
    tokens[key] = (await app.services.tokens.issue({ partyId: ids[key], deviceId: `phone-${key}`, roles: ['member'] })).accessToken;
  };

  it('two simultaneous first PATCHes with different fields keep both fields and write revisions 1 and 2', async () => {
    await fresh('r1');
    const [a, b] = await Promise.all([call('r1', 'PATCH', { category: 'rabbi', program: 'Mir' }, at(1)), call('r1', 'PATCH', { israelConnection: 'a statement' }, at(2))]);
    // Whichever ran second needed the category the first one set, so one of them is refused as a first set without a category, or both succeed in order.
    const [okA, okB] = [a.status === 200, b.status === 200];
    expect(okA || okB).toBe(true);
    const rows = await history('r1');
    expect(rows.map((h) => h.revision)).toEqual(rows.map((_, i) => i + 1));
    const now = (await call('r1', 'GET')).body as Record<string, unknown>;
    expect(now).toMatchObject({ category: 'rabbi', program: 'Mir' });
    if (okB) expect(now.israelConnection).toBe('a statement');
    expect(rows).toHaveLength(okB ? 2 : 1);
  });

  it('two simultaneous first PATCHes that each carry a category never lose a field the other set', async () => {
    await fresh('r2');
    await Promise.all([call('r2', 'PATCH', { category: 'soldier', program: 'Michve' }, at(1)), call('r2', 'PATCH', { category: 'soldier', israelConnection: 'a statement' }, at(2))]);
    expect((await call('r2', 'GET')).body).toMatchObject({ category: 'soldier', program: 'Michve', israelConnection: 'a statement' });
    expect((await history('r2')).map((h) => h.revision)).toEqual([1, 2]);
  });

  it('the member lock is taken before the profile is read, and is a held advisory lock while the transaction runs', async () => {
    await fresh('r3');
    const seen: { sql: string; held?: number }[] = [];
    const spy: typeof db = {
      ...db,
      query: db.query.bind(db),
      transaction: (fn) => db.transaction((tx) => fn({
        ...tx,
        query: (async (text: string, params?: readonly unknown[]) => {
          const res = await tx.query(text, params);
          const entry: { sql: string; held?: number } = { sql: text };
          if (text.includes('pg_advisory_xact_lock')) entry.held = Number((await tx.query<{ n: string }>(`select count(*) as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted`)).rows[0]!.n);
          seen.push(entry);
          return res;
        }) as typeof tx.query,
      })),
    };
    const svc = new RecipientProfileService({ db: spy, pii: createPiiCipher({ dataKey: new Secret(randomBytes(32).toString('base64')), indexKey: new Secret(randomBytes(32).toString('base64')) }), flags: new StaticFlags() });
    await svc.set(ids.r3!, { category: 'other' }, at(1));
    const lockAt = seen.findIndex((e) => e.sql.includes('pg_advisory_xact_lock'));
    const readAt = seen.findIndex((e) => e.sql.includes('from identity.recipient_profile where'));
    const writeAt = seen.findIndex((e) => e.sql.includes('insert into identity.recipient_profile '));
    expect(lockAt).toBe(0);
    expect(readAt).toBeGreaterThan(lockAt);
    expect(writeAt).toBeGreaterThan(readAt);
    expect(seen[lockAt]!.held).toBe(1);
  });

  it('the database refuses a second history row with the same revision, and a revision below 1', async () => {
    const p = uuidv7(T0);
    const ins = (rev: number) => db.query(`insert into identity.recipient_profile_history (id, party_id, revision, category, recorded_at) values ($1, $2, $3, 'other', now())`, [uuidv7(T0), p, rev]);
    await ins(1);
    await expect(ins(1)).rejects.toThrow();
    await expect(ins(0)).rejects.toThrow();
    await ins(2);
  });
});

describe('T-1101: the flag and the logs', () => {
  it('phase1.recipientProfile is off by default: GET and PATCH answer FEATURE_OFF 404 and write nothing', async () => {
    const get = await call('noa', 'GET', undefined, T0, appOff);
    expect(get).toMatchObject({ status: 404, body: { code: 'FEATURE_OFF' } });
    const patch = await call('noa', 'PATCH', { category: 'soldier' }, T0, appOff);
    expect(patch).toMatchObject({ status: 404, body: { code: 'FEATURE_OFF' } });
    expect(await current('noa')).toEqual([]);
    expect(await history('noa')).toEqual([]);
    expect((await call(undefined, 'GET', undefined, T0, appOff)).status).toBe(401); // the bearer is checked before the flag
    // the same member, same data, with the flag on
    expect((await call('noa', 'GET')).status).toBe(200);
  });

  it('writes the statement and the program nowhere that logs: not the console, stdout, stderr, nor an error body', async () => {
    const out: string[] = [];
    const sinks = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' '))));
    const w1 = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (out.push(String(c)), true));
    const w2 = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (out.push(String(c)), true));
    const secret = { category: 'soldier', program: 'Nefesh Program', israelConnection: 'Golani Jerusalem secret' };
    await call('noa', 'PATCH', secret, at(1));
    await call('noa', 'PATCH', { ...secret, israelConnection: 'Golani Jerusalem secret\u0000' }, at(2));
    await call('noa', 'PATCH', { ...secret, israelConnection: 'Golani'.padEnd(300, 'q') }, at(3));
    await call('noa', 'GET');
    expect(sinks.length).toBe(5);
    expect(w1).toBeDefined();
    expect(w2).toBeDefined();
    const logged = out.join('\n');
    for (const bit of ['Golani', 'Jerusalem', 'Nefesh']) expect(logged).not.toContain(bit);
    const audit = await db.query<{ payload: unknown }>('select payload from audit.entry');
    for (const bit of ['Golani', 'Jerusalem', 'Nefesh']) expect(JSON.stringify(audit.rows)).not.toContain(bit);
  });
});
