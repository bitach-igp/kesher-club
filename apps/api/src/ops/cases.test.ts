import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { openCase } from './cases.ts';

describe('openCase', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const now = new Date('2026-03-01T10:00:00Z');

  it('inserts an open case once per dedupe key and says so', async () => {
    const first = await openCase(db, { kind: 'unit_test', dedupeKey: 'unit:1', severity: 'high', payload: { a: 1, nested: { b: 'x' } }, now });
    const second = await openCase(db, { kind: 'unit_test', dedupeKey: 'unit:1', severity: 'low', payload: { a: 2 }, now });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = await db.query<{ kind: string; severity: string; status: string; payload: unknown; opened_at: Date }>('select kind, severity, status, payload, opened_at from ops.case where dedupe_key = $1', ['unit:1']);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ kind: 'unit_test', severity: 'high', status: 'open', payload: { a: 1, nested: { b: 'x' } } });
    expect(new Date(rows.rows[0]!.opened_at).toISOString()).toBe(now.toISOString());
  });

  it('keeps a resolved case as it is (no reopen)', async () => {
    await openCase(db, { kind: 'unit_test', dedupeKey: 'unit:2', severity: 'medium', payload: {}, now });
    await db.query(`update ops.case set status = 'resolved' where dedupe_key = 'unit:2'`);
    expect(await openCase(db, { kind: 'unit_test', dedupeKey: 'unit:2', severity: 'medium', payload: {}, now })).toBe(false);
    const r = await db.query<{ status: string }>(`select status from ops.case where dedupe_key = 'unit:2'`);
    expect(r.rows[0]?.status).toBe('resolved');
  });

  it('uses a caller-supplied id when given', async () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    expect(await openCase(db, { id, kind: 'unit_test', dedupeKey: 'unit:3', severity: 'medium', payload: {}, now })).toBe(true);
    const r = await db.query<{ id: string }>(`select id from ops.case where dedupe_key = 'unit:3'`);
    expect(r.rows[0]?.id).toBe(id);
  });
});
