// T-0659 (REQ-INS-022): the Crowded adapter's idempotency ledger in Postgres (ops.vendor_idempotency). A restart must not
// lose a key, or a retry creates a second organization or payment; the same key with another body is refused; the table is
// insert-only for the app role.
import { CrowdedClient, CrowdedInstitutionBankingAdapter, FakeCrowded } from '@kesher/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { PostgresVendorKeyLedger } from './crowded-keys.ts';

const NOW = new Date('2026-11-03T10:00:00Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);
afterAll(async () => db.close());

const ledger = (provider = 'crowded') => new PostgresVendorKeyLedger(db, provider, () => NOW);
const count = async (provider: string, key: string) => Number((await db.query<{ n: string }>('select count(*)::text as n from ops.vendor_idempotency where provider = $1 and key = $2', [provider, key])).rows[0]!.n);

describe('PostgresVendorKeyLedger (T-0659)', () => {
  it('remembers a result by key, and a missing key is undefined', async () => {
    const l = ledger();
    expect(await l.get('entity:remember-1')).toBeUndefined();
    await l.put('entity:remember-1', { body: HASH_A, result: { entityRef: 'ch000001' } });
    expect(await l.get('entity:remember-1')).toEqual({ body: HASH_A, result: { entityRef: 'ch000001' } });
    await l.put('holder:ch000001', { body: '', result: 'institution' });
    expect(await l.get('holder:ch000001')).toEqual({ body: '', result: 'institution' });
    await l.put('nothing', { body: HASH_A, result: undefined });
    expect(await l.get('nothing')).toEqual({ body: HASH_A, result: undefined });
  });

  it('stores a result holding bigints and reads them back as bigints, nested too', async () => {
    const l = ledger();
    const result = { amount: { minor: 12_345_678_901_234_567_890n, currency: 'USD' }, lines: [1n, -2n, { n: 0n }], plain: 'text', count: 3 };
    await l.put('entity:bigint-1', { body: HASH_A, result });
    expect(await l.get('entity:bigint-1')).toEqual({ body: HASH_A, result });
    await l.put('entity:bigint-2', { body: HASH_A, result: 9_007_199_254_740_993n });
    expect((await l.get('entity:bigint-2'))?.result).toBe(9_007_199_254_740_993n);
    // Checked through jsonb operators, not the text form (whose spacing is Postgres's to choose): the digits are stored as a string.
    const raw = await db.query<{ digits: string }>(`select result->'amount'->'minor'->>'$bigint' as digits from ops.vendor_idempotency where key = 'entity:bigint-1'`);
    expect(raw.rows[0]!.digits).toBe('12345678901234567890');
  });

  it('round-trips a stored null as null, and an undefined result as undefined', async () => {
    const l = ledger();
    await l.put('entity:null-1', { body: HASH_A, result: null });
    const stored = await l.get('entity:null-1');
    expect(stored).toBeDefined();
    expect(stored!.result).toBeNull();
    await l.put('entity:undefined-1', { body: HASH_A, result: undefined });
    expect((await l.get('entity:undefined-1'))!.result).toBeUndefined();
    await l.put('entity:nested-null-1', { body: HASH_A, result: { a: null } });
    expect((await l.get('entity:nested-null-1'))!.result).toEqual({ a: null });
  });

  it('reads a malformed $bigint value back as the plain object it is, not a bigint', async () => {
    const l = ledger();
    for (const [i, result] of [{ $bigint: '1.5' }, { $bigint: 5 }, { $bigint: '5', extra: 1 }, { $bigint: 'abc' }].entries()) {
      await l.put(`entity:malformed-${i}`, { body: HASH_A, result });
      expect((await l.get(`entity:malformed-${i}`))!.result).toEqual(result);
    }
  });

  // Known limit, pinned so a change is deliberate: the encoder does not escape the $bigint key, so a real result shaped exactly like it
  // reads back as a bigint. Results are the adapter's own output (plain data), so no port result has that shape today.
  it('reads a result shaped exactly like { $bigint: "5" } back as 5n (known limit, not escaped)', async () => {
    await ledger().put('entity:collision-1', { body: HASH_A, result: { $bigint: '5' } });
    expect((await ledger().get('entity:collision-1'))!.result).toBe(5n);
  });

  it('stamps the row with the clock it was given', async () => {
    await ledger().put('entity:stamped-1', { body: HASH_A, result: 1 });
    const r = await db.query<{ created_at: string | Date }>(`select created_at from ops.vendor_idempotency where key = 'entity:stamped-1'`);
    expect(new Date(r.rows[0]!.created_at).toISOString()).toBe(NOW.toISOString());
  });

  it('refuses a second put for the same key with another body hash, and keeps the first entry', async () => {
    const l = ledger();
    await l.put('entity:conflict-1', { body: HASH_A, result: { entityRef: 'ch000001' } });
    await expect(l.put('entity:conflict-1', { body: HASH_B, result: { entityRef: 'ch000002' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await l.get('entity:conflict-1')).toEqual({ body: HASH_A, result: { entityRef: 'ch000001' } });
    expect(await count('crowded', 'entity:conflict-1')).toBe(1);
  });

  it('accepts a repeat of the same key and body hash without a second row, and the first result wins', async () => {
    const l = ledger();
    await l.put('entity:repeat-1', { body: HASH_A, result: { entityRef: 'ch000001' } });
    await l.put('entity:repeat-1', { body: HASH_A, result: { entityRef: 'ch000002' } });
    expect(await l.get('entity:repeat-1')).toEqual({ body: HASH_A, result: { entityRef: 'ch000001' } });
    expect(await count('crowded', 'entity:repeat-1')).toBe(1);
  });

  // PGlite is one connection and runs the statements one after another, so this is not a race at the database; it checks that two
  // puts issued together settle the same way as two in sequence.
  it('of two puts issued together with different bodies, one wins and the other is refused (PGlite serialises them, so no true race)', async () => {
    const settled = await Promise.allSettled([ledger().put('entity:race-1', { body: HASH_A, result: 'a' }), ledger().put('entity:race-1', { body: HASH_B, result: 'b' })]);
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await count('crowded', 'entity:race-1')).toBe(1);
  });

  it('a new instance on the same database finds the first entry (a restart)', async () => {
    await ledger().put('entity:restart-1', { body: HASH_A, result: { entityRef: 'ch000009' } });
    const afterRestart = ledger();
    expect(await afterRestart.get('entity:restart-1')).toEqual({ body: HASH_A, result: { entityRef: 'ch000009' } });
    await expect(afterRestart.put('entity:restart-1', { body: HASH_B, result: 'x' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('keeps one provider\'s keys apart from another\'s', async () => {
    await ledger('crowded').put('entity:scoped-1', { body: HASH_A, result: 'crowded' });
    expect(await ledger('other').get('entity:scoped-1')).toBeUndefined();
    await ledger('other').put('entity:scoped-1', { body: HASH_B, result: 'other' });
    expect(await ledger('crowded').get('entity:scoped-1')).toEqual({ body: HASH_A, result: 'crowded' });
    expect(await ledger('other').get('entity:scoped-1')).toEqual({ body: HASH_B, result: 'other' });
  });

  it('keeps the first note for a key: the adapter\'s holder note for a chapter is not overwritten (the in-memory ledger let the last write win)', async () => {
    const note = { body: '', result: 'institution' };
    const l = ledger();
    await l.put('holder:ch-first-wins', note);
    await l.put('holder:ch-first-wins', { body: '', result: 'platform' });
    expect(await l.get('holder:ch-first-wins')).toEqual(note);

    // Through the adapter: the same legal name under two keys reuses the chapter, and the second holder is dropped, so the
    // sub-account rule still reads the first one ('institution' has no sub-accounts).
    const fake = new FakeCrowded({ token: 't-0659' });
    const adapter = new CrowdedInstitutionBankingAdapter({ client: new CrowdedClient({ baseUrl: 'https://crowded.test/api/v1', token: 't-0659', fetch: fake.fetch }), ledger: ledger(), subAccountEmail: 'ops@kesher.test' });
    const base = { institutionId: 'inst-note', legalName: 'American Friends of First Wins', ein: '12-3456789' };
    const a = await adapter.createEntity({ ...base, holder: 'institution', idempotencyKey: 'key-note-first' });
    const b = await adapter.createEntity({ ...base, holder: 'platform', idempotencyKey: 'key-note-second' });
    expect(b).toEqual(a);
    await expect(adapter.createSubAccount({ entityRef: a.entityRef, institutionId: 'inst-note', idempotencyKey: 'key-note-sub-1' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fake.calls.filter((c) => c.path.includes('subaccounts'))).toHaveLength(0);
  });

  it('the adapter on a restarted process answers a retry from the ledger: no second organization, and a changed body is refused before anything is sent', async () => {
    const fake = new FakeCrowded({ token: 't-0659' });
    const adapter = () => new CrowdedInstitutionBankingAdapter({ client: new CrowdedClient({ baseUrl: 'https://crowded.test/api/v1', token: 't-0659', fetch: fake.fetch }), ledger: ledger() });
    const input = { holder: 'institution' as const, institutionId: 'inst-1', legalName: 'American Friends of Amuta', ein: '12-3456789', idempotencyKey: 'key-0659-entity' };
    const first = await adapter().createEntity(input);
    const posts = fake.calls.filter((c) => c.method === 'POST').length;
    expect(posts).toBeGreaterThan(0);

    const restarted = adapter();
    expect(await restarted.createEntity(input)).toEqual(first);
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);
    await expect(restarted.createEntity({ ...input, legalName: 'American Friends of Another' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);
  });
});

describe('ops.vendor_idempotency (club-ddl, migration 0026)', () => {
  it('is unique on (provider, key)', async () => {
    await db.query(`insert into ops.vendor_idempotency (provider, key, body_hash, result, created_at) values ('crowded', 'entity:unique-1', $1, null, $2)`, [HASH_A, NOW]);
    await expect(db.query(`insert into ops.vendor_idempotency (provider, key, body_hash, result, created_at) values ('crowded', 'entity:unique-1', $1, null, $2)`, [HASH_A, NOW])).rejects.toMatchObject({ code: '23505' });
  });

  it('the app role can read and insert, and gets permission denied on UPDATE and DELETE', async () => {
    await db.asRole('club_app', (c) => c.query(`insert into ops.vendor_idempotency (provider, key, body_hash, result, created_at) values ('crowded', 'entity:grant-1', $1, '{"a":1}', $2)`, [HASH_A, NOW]));
    const read = await db.asRole('club_app', (c) => c.query(`select body_hash from ops.vendor_idempotency where key = 'entity:grant-1'`));
    expect(read.rows).toHaveLength(1);
    for (const sql of [`update ops.vendor_idempotency set body_hash = 'x' where key = 'entity:grant-1'`, `update ops.vendor_idempotency set result = null`, `delete from ops.vendor_idempotency where key = 'entity:grant-1'`, 'delete from ops.vendor_idempotency']) {
      await expect(db.asRole('club_app', (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
    expect(await count('crowded', 'entity:grant-1')).toBe(1);
  });

  it('club_readonly gets permission denied on both read and write (no grant)', async () => {
    await expect(db.asRole('club_readonly', (c) => c.query('select provider, key, body_hash from ops.vendor_idempotency'))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_readonly', (c) => c.query(`insert into ops.vendor_idempotency (provider, key, body_hash, result, created_at) values ('crowded', 'entity:ro-1', 'h', null, now())`))).rejects.toThrow(/permission denied/);
    expect(await count('crowded', 'entity:ro-1')).toBe(0);
  });
});
