import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { findByValue, getMarker, getMarkers, putMarker } from './workflow-marker.ts';

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

  it('finds a subject by (kind, value) and nothing under another kind', async () => {
    const id = uuidv7(now);
    await putMarker(db, { kind: 'membership_lost_key', subjectId: id, value: 'lost-key-1234' });
    expect(await findByValue(db, 'membership_lost_key', 'lost-key-1234')).toBe(id);
    expect(await findByValue(db, 'other_kind', 'lost-key-1234')).toBeUndefined();
    expect(await findByValue(db, 'membership_lost_key', 'no-such-key')).toBeUndefined();
  });

  it('refuses a second subject with the same value under the same kind, and leaves no row', async () => {
    const first = uuidv7(now);
    const second = uuidv7(now);
    expect(await putMarker(db, { kind: 'unique_kind', subjectId: first, value: 'dup-value' })).toBe(true);
    // on conflict do nothing: the (kind, value) unique index answers false, same as a repeat of the primary key.
    expect(await putMarker(db, { kind: 'unique_kind', subjectId: second, value: 'dup-value' })).toBe(false);
    expect(await getMarker(db, 'unique_kind', second)).toBeUndefined();
    expect(await findByValue(db, 'unique_kind', 'dup-value')).toBe(first);
    // The same value under another kind is fine.
    expect(await putMarker(db, { kind: 'unique_kind_b', subjectId: second, value: 'dup-value' })).toBe(true);
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
    const r = await db.query<{ t: string; created: boolean }>(
      `select pg_typeof(created_at)::text as t, created_at is not null as created from ops.workflow_marker where kind = 'stamp_kind' and subject_id = $1`, [id]);
    expect(r.rows[0]).toEqual({ t: 'timestamp with time zone', created: true });
  });

  it('grants club_app select and insert only: markers are write-once', async () => {
    const id = uuidv7(now);
    await db.asRole('club_app', (c) => putMarker(c, { kind: 'grant_kind', subjectId: id, value: 'grant-v' }));
    expect(await db.asRole('club_app', (c) => getMarker(c, 'grant_kind', id))).toBe('grant-v');
    for (const sql of [
      `update ops.workflow_marker set value = 'changed' where kind = 'grant_kind'`,
      `delete from ops.workflow_marker where kind = 'grant_kind'`,
      `truncate ops.workflow_marker`,
    ]) {
      await expect(db.asRole('club_app', (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
    expect(await getMarker(db, 'grant_kind', id)).toBe('grant-v');
  });
});
