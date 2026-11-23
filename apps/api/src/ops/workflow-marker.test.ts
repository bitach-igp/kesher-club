import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { clearMarker, findByClaim, getMarker, getMarkers, putMarker } from './workflow-marker.ts';

// TST-WAL-003: our own workflow markers are write-once rows in ops.workflow_marker (T-0768).
describe('ops.workflow_marker store', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const now = new Date('2026-03-01T10:00:00Z');

  it('inserts once, then reports false and keeps the first value', async () => {
    const id = uuidv7(now);
    expect(await putMarker(db, { kind: 'credit_began', subjectId: id, seq: 1, value: 'key-first' })).toBe(true);
    expect(await putMarker(db, { kind: 'credit_began', subjectId: id, seq: 1, value: 'key-second' })).toBe(false);
    expect(await getMarker(db, 'credit_began', id, 1)).toBe('key-first');
  });

  it('defaults seq to 0 and reads undefined when absent', async () => {
    const id = uuidv7(now);
    expect(await getMarker(db, 'subaccount_purpose', id)).toBeUndefined();
    expect(await putMarker(db, { kind: 'subaccount_purpose', subjectId: id, value: 'purpose-a' })).toBe(true);
    expect(await getMarker(db, 'subaccount_purpose', id)).toBe('purpose-a');
    expect(await getMarker(db, 'subaccount_purpose', id, 0)).toBe('purpose-a');
    expect(await getMarker(db, 'subaccount_purpose', id, 1)).toBeUndefined();
  });

  it('isolates attempts of one subject and reads several at once', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: 'credit_outcome', subjectId: id, seq: 1, value: 'refused' });
    await putMarker(db, { kind: 'credit_outcome', subjectId: id, seq: 3, value: 'credited' });
    const got = await getMarkers(db, 'credit_outcome', id, [1, 2, 3]);
    expect([...got.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, 'refused'], [3, 'credited']]);
    expect((await getMarkers(db, 'credit_outcome', id, [])).size).toBe(0);
    expect((await getMarkers(db, 'credit_outcome', uuidv7(now), [1, 3])).size).toBe(0);
  });

  it('isolates subjects and lets two kinds coexist for one subject', async () => {
    const a = uuidv7(now);
    const b = uuidv7(now);
    expect(await putMarker(db, { kind: 'kind_one', subjectId: a, value: 'iso-a1' })).toBe(true);
    expect(await putMarker(db, { kind: 'kind_two', subjectId: a, value: 'iso-a2' })).toBe(true);
    expect(await putMarker(db, { kind: 'kind_one', subjectId: b, value: 'iso-b1' })).toBe(true);
    expect(await getMarker(db, 'kind_one', a)).toBe('iso-a1');
    expect(await getMarker(db, 'kind_two', a)).toBe('iso-a2');
    expect(await getMarker(db, 'kind_one', b)).toBe('iso-b1');
    expect(await getMarker(db, 'kind_two', b)).toBeUndefined();
  });

  it('finds a subject by (kind, claim) and nothing under another kind or an unclaimed value', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: 'membership_lost_key', subjectId: id, value: 'lost', claim: 'lost-key-1234' });
    expect(await findByClaim(db, 'membership_lost_key', 'lost-key-1234')).toBe(id);
    expect(await findByClaim(db, 'other_kind', 'lost-key-1234')).toBeUndefined();
    expect(await findByClaim(db, 'membership_lost_key', 'no-such-key')).toBeUndefined();
    expect(await findByClaim(db, 'membership_lost_key', 'lost')).toBeUndefined();
  });

  it('lets two subjects hold the same value under one kind, and one subject the same value at two seqs', async () => {
    const a = uuidv7(now);
    const b = uuidv7(now);
    expect(await putMarker(db, { kind: 'credit_outcome', subjectId: a, seq: 1, value: 'credited' })).toBe(true);
    expect(await putMarker(db, { kind: 'credit_outcome', subjectId: b, seq: 1, value: 'credited' })).toBe(true);
    expect(await putMarker(db, { kind: 'credit_outcome', subjectId: a, seq: 2, value: 'credited' })).toBe(true);
    expect(await getMarker(db, 'credit_outcome', b, 1)).toBe('credited');
    expect((await getMarkers(db, 'credit_outcome', a, [1, 2])).size).toBe(2);
  });

  it('refuses a claim taken by another subject (false, nothing written), and a repeat of subject and seq (false)', async () => {
    const first = uuidv7(now);
    const second = uuidv7(now);
    expect(await putMarker(db, { kind: 'claim_kind', subjectId: first, value: 'v1', claim: 'dup-claim' })).toBe(true);
    expect(await putMarker(db, { kind: 'claim_kind', subjectId: second, value: 'v2', claim: 'dup-claim' })).toBe(false);
    expect(await getMarker(db, 'claim_kind', second)).toBeUndefined();
    expect(await findByClaim(db, 'claim_kind', 'dup-claim')).toBe(first);
    expect(await putMarker(db, { kind: 'claim_kind', subjectId: first, value: 'v3', claim: 'other-claim' })).toBe(false);
    expect(await getMarker(db, 'claim_kind', first)).toBe('v1');
    // The same claim under another kind is fine.
    expect(await putMarker(db, { kind: 'claim_kind_b', subjectId: second, value: 'v2', claim: 'dup-claim' })).toBe(true);
    // The table itself refuses a duplicate claim.
    await expect(db.query(`insert into ops.workflow_marker (kind, subject_id, value, claim) values ('claim_kind', $1, 'x', 'dup-claim')`, [uuidv7(now)])).rejects.toThrow(/unique|duplicate/i);
  });

  it('never collides on NULL claims', async () => {
    const kind = 'null_claim_kind';
    expect(await putMarker(db, { kind, subjectId: uuidv7(now), value: 'same' })).toBe(true);
    expect(await putMarker(db, { kind, subjectId: uuidv7(now), value: 'same' })).toBe(true);
    await db.query(`insert into ops.workflow_marker (kind, subject_id, value, claim) values ($1, $2, 'x', null), ($1, $3, 'x', null)`, [kind, uuidv7(now), uuidv7(now)]);
  });

  it('defaults seq to 0 at the table', async () => {
    const id = uuidv7(now);
    await db.query(`insert into ops.workflow_marker (kind, subject_id, value) values ('default_seq_kind', $1, 'v')`, [id]);
    expect(await getMarker(db, 'default_seq_kind', id, 0)).toBe('v');
    const r = await db.query<{ seq: number }>(`select seq from ops.workflow_marker where kind = 'default_seq_kind' and subject_id = $1`, [id]);
    expect(r.rows[0]?.seq).toBe(0);
  });

  it('rejects a negative seq', async () => {
    await expect(putMarker(db, { kind: 'seq_kind', subjectId: uuidv7(now), seq: -1, value: 'neg' })).rejects.toThrow(/check/i);
  });

  it('rejects null columns and a non-uuid subject at the table', async () => {
    await expect(db.query(`insert into ops.workflow_marker (kind, subject_id, value) values ('k', null, 'v')`)).rejects.toThrow(/null/i);
    await expect(db.query(`insert into ops.workflow_marker (kind, subject_id, value) values ('k', $1, null)`, [uuidv7(now)])).rejects.toThrow(/null/i);
    await expect(db.query(`insert into ops.workflow_marker (kind, subject_id, value) values ('k', 'not-a-uuid', 'v')`)).rejects.toThrow();
  });

  it('stamps created_at as timestamptz', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: 'stamp_kind', subjectId: id, value: 'stamp-v' });
    const r = await db.query<{ t: string; age_s: number }>(
      `select pg_typeof(created_at)::text as t, abs(extract(epoch from (now() - created_at)))::float8 as age_s from ops.workflow_marker where kind = 'stamp_kind' and subject_id = $1`, [id]);
    expect(r.rows[0]?.t).toBe('timestamp with time zone');
    expect(r.rows[0]?.age_s).toBeLessThan(5);
  });

  it('grants club_app select, insert and (guarded, see below) delete: no update, no truncate', async () => {
    const id = uuidv7(now);
    await db.asRole('club_app', (c) => putMarker(c, { kind: 'grant_kind', subjectId: id, value: 'grant-v' }));
    expect(await db.asRole('club_app', (c) => getMarker(c, 'grant_kind', id))).toBe('grant-v');
    for (const sql of [
      `update ops.workflow_marker set value = 'changed' where kind = 'grant_kind'`,
      `update ops.workflow_marker set kind = 'subaccount_owner:x' where kind = 'grant_kind'`,
      `truncate ops.workflow_marker`,
    ]) {
      await expect(db.asRole('club_app', (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
    expect(await getMarker(db, 'grant_kind', id)).toBe('grant-v');
  });
});

// T-0787: a failed-owner marker can be cleared; every other marker stays write-once (the grant is table-wide, the trigger narrows it).
describe('ops.workflow_marker delete (failed-owner markers only)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  const now = new Date('2026-03-01T10:00:00Z');
  const OWNER = 'subaccount_owner:crowded';
  const WRITE_ONCE = ['credit_began', 'credit_outcome', 'payout_payee', 'membership_lost_key', 'subaccount_purpose:crowded', 'subaccount_owner', 'subaccount_ownerx:crowded', 'Subaccount_owner:crowded', 'subaccountXowner:crowded', 'x_subaccount_owner:crowded', ''];
  const count = async (kind: string, id: string): Promise<number> => (await db.query<{ n: number }>('select count(*)::int as n from ops.workflow_marker where kind = $1 and subject_id = $2', [kind, id])).rows[0]!.n;

  it('lets club_app delete an owner marker, and a later put can write it again', async () => {
    const id = uuidv7(now);
    await db.asRole('club_app', (c) => putMarker(c, { kind: OWNER, subjectId: id, value: `o:${id}:failed` }));
    expect(await db.asRole('club_app', (c) => clearMarker(c, { kind: OWNER, subjectId: id }))).toBe(true);
    expect(await getMarker(db, OWNER, id)).toBeUndefined();
    expect(await putMarker(db, { kind: OWNER, subjectId: id, value: 'o:again' })).toBe(true);
  });

  it('deletes through plain SQL for club_app too (the grant is real), and any provider suffix is clearable', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: 'subaccount_owner:other', subjectId: id, value: 'v' });
    const r = await db.asRole('club_app', (c) => c.query(`delete from ops.workflow_marker where kind = 'subaccount_owner:other' and subject_id = $1`, [id]));
    expect(r.rowCount).toBe(1);
  });

  it('deletes only the named subject, kind and seq', async () => {
    const a = uuidv7(now);
    const b = uuidv7(now);
    await putMarker(db, { kind: OWNER, subjectId: a, value: 'va' });
    await putMarker(db, { kind: OWNER, subjectId: a, seq: 1, value: 'va1' });
    await putMarker(db, { kind: OWNER, subjectId: b, value: 'vb' });
    await putMarker(db, { kind: 'subaccount_owner:other', subjectId: a, value: 'vo' });
    expect(await clearMarker(db, { kind: OWNER, subjectId: a })).toBe(true);
    expect(await getMarker(db, OWNER, a, 1)).toBe('va1');
    expect(await getMarker(db, OWNER, b)).toBe('vb');
    expect(await getMarker(db, 'subaccount_owner:other', a)).toBe('vo');
    expect(await clearMarker(db, { kind: OWNER, subjectId: a, seq: 1 })).toBe(true);
    expect(await getMarker(db, OWNER, a, 1)).toBeUndefined();
  });

  it('returns false for a marker that is not there, and for a second clear', async () => {
    const id = uuidv7(now);
    expect(await clearMarker(db, { kind: OWNER, subjectId: id })).toBe(false);
    await putMarker(db, { kind: OWNER, subjectId: id, value: 'v' });
    expect(await clearMarker(db, { kind: OWNER, subjectId: id })).toBe(true);
    expect(await clearMarker(db, { kind: OWNER, subjectId: id })).toBe(false);
  });

  it('refuses at the table every other kind, for club_app and for the superuser, and keeps the row', async () => {
    for (const kind of WRITE_ONCE) {
      const id = uuidv7(now);
      await putMarker(db, { kind, subjectId: id, value: 'keep-me' });
      await expect(db.asRole('club_app', (c) => c.query('delete from ops.workflow_marker where kind = $1 and subject_id = $2', [kind, id]))).rejects.toThrow('only a failed-owner marker may be deleted');
      await expect(db.query('delete from ops.workflow_marker where kind = $1 and subject_id = $2', [kind, id])).rejects.toThrow('only a failed-owner marker may be deleted');
      expect(await getMarker(db, kind, id)).toBe('keep-me');
    }
  });

  it('the refusal is the trigger, not a missing grant, and its message leaks no kind, subject or value', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: 'credit_outcome', subjectId: id, seq: 1, value: 'secret-value-123' });
    const err = await db.asRole('club_app', (c) => c.query('delete from ops.workflow_marker where subject_id = $1', [id])).then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeDefined();
    expect(err!.message).not.toMatch(/permission denied/);
    for (const leak of ['credit_outcome', id, 'secret-value-123']) expect(err!.message).not.toContain(leak);
  });

  it('one statement that mixes an owner marker and a write-once marker deletes neither', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: OWNER, subjectId: id, value: 'o' });
    await putMarker(db, { kind: 'credit_began', subjectId: id, seq: 1, value: 'k' });
    await expect(db.asRole('club_app', (c) => c.query('delete from ops.workflow_marker where subject_id = $1', [id]))).rejects.toThrow('only a failed-owner marker');
    expect(await count(OWNER, id)).toBe(1);
    expect(await count('credit_began', id)).toBe(1);
  });

  it('an unrelated bulk delete is refused as soon as it reaches a write-once row', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: 'payout_payee', subjectId: id, value: 'p' });
    await expect(db.asRole('club_app', (c) => c.query('delete from ops.workflow_marker'))).rejects.toThrow('only a failed-owner marker');
    expect(await getMarker(db, 'payout_payee', id)).toBe('p');
  });

  it('keeps update and truncate denied to club_app, and grants it nothing on the other columns', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: OWNER, subjectId: id, value: 'v' });
    await expect(db.asRole('club_app', (c) => c.query(`update ops.workflow_marker set value = 'x' where subject_id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query(`update ops.workflow_marker set kind = 'credit_began' where subject_id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.asRole('club_app', (c) => c.query('truncate ops.workflow_marker'))).rejects.toThrow(/permission denied/);
    expect(await getMarker(db, OWNER, id)).toBe('v');
    const g = await db.query<{ p: string }>(`select privilege_type as p from information_schema.role_table_grants where grantee = 'club_app' and table_schema = 'ops' and table_name = 'workflow_marker' order by 1`);
    expect(g.rows.map((r) => r.p)).toEqual(['DELETE', 'INSERT', 'SELECT']);
  });

  it('defines the guard as SECURITY INVOKER with a fixed search_path, before delete, per row', async () => {
    const f = await db.query<{ secdef: boolean; cfg: string[] | null }>(`select prosecdef as secdef, proconfig as cfg from pg_proc where proname = 'workflow_marker_delete_guard'`);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.secdef).toBe(false);
    expect(f.rows[0]!.cfg).toEqual(['search_path=pg_catalog']);
    const t = await db.query<{ type: number; enabled: string }>(`select tgtype::int as type, tgenabled as enabled from pg_trigger where tgname = 'workflow_marker_delete_guard' and not tgisinternal`);
    expect(t.rows).toHaveLength(1);
    // tgtype bits: 1 row, 2 before, 8 delete.
    expect(t.rows[0]!.type & 1).toBe(1);
    expect(t.rows[0]!.type & 2).toBe(2);
    expect(t.rows[0]!.type & 8).toBe(8);
    expect(t.rows[0]!.type & (4 | 16 | 32)).toBe(0);
    expect(t.rows[0]!.enabled).toBe('O');
  });

  it('lets a superuser clean up inside a transaction with session_replication_role = replica (documented path for tests and desktop steps)', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: 'payout_payee', subjectId: id, value: 'p' });
    await db.transaction(async (tx) => {
      await tx.query('set local session_replication_role = replica');
      await tx.query(`delete from ops.workflow_marker where kind = 'payout_payee' and subject_id = $1`, [id]);
    });
    expect(await getMarker(db, 'payout_payee', id)).toBeUndefined();
  });

  it('clearMarker rejects any other kind before touching the database', async () => {
    let touched = 0;
    const spy = { query: () => { touched += 1; return Promise.reject(new Error('db touched')); } } as unknown as Parameters<typeof clearMarker>[0];
    for (const kind of WRITE_ONCE) await expect(clearMarker(spy, { kind, subjectId: uuidv7(now) })).rejects.toThrow('only a failed-owner marker may be cleared');
    expect(touched).toBe(0);
  });

  it('clearMarker sends parameterised SQL: a hostile subject id or kind is data, not SQL', async () => {
    const calls: { text: string; params: readonly unknown[] | undefined }[] = [];
    const spy = { query: (text: string, params?: readonly unknown[]) => { calls.push({ text, params }); return Promise.resolve({ rows: [], rowCount: 0 }); } } as unknown as Parameters<typeof clearMarker>[0];
    expect(await clearMarker(spy, { kind: "subaccount_owner:x'; drop table ops.workflow_marker; --", subjectId: "' or 1=1 --", seq: 2 })).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).not.toMatch(/drop|1=1|x'/);
    expect(calls[0]!.params).toEqual(["subaccount_owner:x'; drop table ops.workflow_marker; --", "' or 1=1 --", 2]);
  });
});

