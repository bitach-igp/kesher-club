import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from './test-db.ts';
import { seedTransfer } from './test-seed.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe('seedTransfer', () => {
  it('inserts a transfer in the given state, market and age', async () => {
    const id = uuidv7();
    const at = new Date('2026-01-02T03:04:05Z');
    await seedTransfer(db, { id, kind: 'load', state: 'pending_hold', market: 'IL', at });
    const r = await db.query<{ state: string; market: string; kind: string; amount_minor: string; idempotency_key: string; created_at: Date | string }>(
      'select state, market, kind, amount_minor::text, idempotency_key, created_at from ops.transfer where id = $1',
      [id],
    );
    expect(r.rows[0]).toMatchObject({ state: 'pending_hold', market: 'IL', kind: 'load', amount_minor: '100', idempotency_key: `seed-${id}` });
    expect(new Date(r.rows[0]!.created_at).toISOString()).toBe(at.toISOString());
  });
});
