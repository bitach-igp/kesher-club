// T-0687: the outbox is drained safely by two publishers at once: each message reaches the sink once, a failing sink
// leaves the row pending with an attempt count, and the claim is `for update skip locked` in one transaction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { enqueue, OutboxPublisher, type OutboxMessage } from './outbox.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);
afterAll(async () => db.close());

const AGG = '00000000-0000-7000-8000-000000000687';
const drain = async () => {
  await db.query('update ops.outbox set published_at = now() where published_at is null');
};
const queue = async (n: number, tag: string) => {
  for (let i = 0; i < n; i += 1) await enqueue(db, 'test', AGG, `${tag}.${i}`, { i });
};

describe('OutboxPublisher (T-0687)', () => {
  it('delivers each of three queued messages exactly once when two publishers run at the same time', async () => {
    await drain();
    await queue(3, 'once');
    const seen: string[] = [];
    // A slow sink keeps each claim open long enough for the other publisher to try to claim the same rows.
    const sink = { publish: async (m: OutboxMessage) => { await new Promise((r) => setTimeout(r, 20)); seen.push(m.type); } };
    const [a, b] = await Promise.all([new OutboxPublisher(db, sink).publishBatch(), new OutboxPublisher(db, sink).publishBatch()]);
    expect(a.published + b.published).toBe(3);
    expect(a.failed + b.failed).toBe(0);
    expect([...seen].sort()).toEqual(['once.0', 'once.1', 'once.2']);
    expect(await new OutboxPublisher(db, sink).backlog()).toBe(0);
  });

  it('leaves a message the sink refuses pending with an attempt count, and retries it on the next run', async () => {
    await drain();
    await queue(2, 'retry');
    let down = true;
    const seen: string[] = [];
    const publisher = new OutboxPublisher(db, {
      publish: async (m) => {
        if (down && m.type === 'retry.0') throw new TypeError('sink down: secret payload');
        seen.push(m.type);
      },
    });
    expect(await publisher.publishBatch()).toEqual({ published: 1, failed: 1 });
    const row = await db.query<{ attempts: number; last_error_class: string; published_at: string | null }>(`select attempts, last_error_class, published_at from ops.outbox where type = 'retry.0'`);
    expect(row.rows[0]).toMatchObject({ attempts: 1, last_error_class: 'TypeError', published_at: null });
    expect(await publisher.backlog()).toBe(1);
    down = false;
    expect(await publisher.publishBatch()).toEqual({ published: 1, failed: 0 });
    expect(seen).toEqual(['retry.1', 'retry.0']);
    const after = await db.query<{ attempts: number; published_at: string | null }>(`select attempts, published_at from ops.outbox where type = 'retry.0'`);
    expect(after.rows[0]!.attempts).toBe(1);
    expect(after.rows[0]!.published_at).not.toBeNull();
  });

  it('claims with for update skip locked inside one transaction', async () => {
    const statements: string[] = [];
    let depth = 0;
    let claimedInTx = false;
    const spy = {
      ...db,
      query: (text: string, params?: readonly unknown[]) => db.query(text, params),
      transaction: <T,>(fn: Parameters<typeof db.transaction<T>>[0]) =>
        db.transaction((tx) => {
          depth += 1;
          return fn({ query: (text: string, params?: readonly unknown[]) => { statements.push(text); if (/for update skip locked/i.test(text) && depth > 0) claimedInTx = true; return tx.query(text, params); } } as typeof tx).finally(() => { depth -= 1; });
        }),
    } as unknown as TestDatabase;
    await drain();
    await queue(1, 'claim');
    await new OutboxPublisher(spy, { publish: async () => undefined }).publishBatch();
    expect(claimedInTx).toBe(true);
    expect(statements.some((s) => /update ops\.outbox/i.test(s))).toBe(true);
  });
});
