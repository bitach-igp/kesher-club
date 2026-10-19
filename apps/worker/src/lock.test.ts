// The advisory lock against PGlite's real SQL. PGlite is one session and advisory locks are re-entrant
// within a session, so contention between two tasks is shown with a session that reports the lock taken;
// the Postgres side of that (a second session's try-lock answers false) is Postgres's own guarantee.
import type { SqlClient } from '@kesher/api/db';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advisoryLock, lockKey } from './lock.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);
afterAll(async () => db.close());

const held = async (name: string, scope = 'IL'): Promise<number> =>
  (
    await db.query<{ n: number }>(
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and granted
         and ((classid::bigint << 32) | objid::bigint) = ($1::bigint & x'ffffffffffffffff'::bigint)`,
      [lockKey(scope, name).toString()],
    )
  ).rows[0]!.n;

describe('advisoryLock (T-0022)', () => {
  it('holds the lock for the length of the run and gives it back after', async () => {
    const lock = advisoryLock(db, 'IL');
    const during = await lock.withLock({ name: 'load-sweep', scope: 'market' }, async () => [await held('load-sweep'), await held('load-sweep', 'US')]);
    expect(during).toEqual({ ran: true, value: [1, 0] });
    expect(await held('load-sweep')).toBe(0);
  });

  it('gives the lock back when the run throws, and passes the error on', async () => {
    const lock = advisoryLock(db, 'IL');
    await expect(lock.withLock({ name: 'send-sweep', scope: 'market' }, () => Promise.reject(new RangeError('boom')))).rejects.toThrow(RangeError);
    expect(await held('send-sweep')).toBe(0);
  });

  it('skips the run, without calling it or unlocking, when another task holds the lock', async () => {
    const sql: string[] = [];
    const taken: SqlClient = {
      query: async <R>(text: string) => {
        sql.push(text);
        return { rows: [{ locked: false }] as R[], rowCount: 1 };
      },
    };
    let called = false;
    const out = await advisoryLock(taken, 'IL').withLock({ name: 'payout-sweep', scope: 'market' }, async () => (called = true));
    expect(out).toEqual({ ran: false });
    expect(called).toBe(false);
    expect(sql).toEqual(['select pg_try_advisory_lock($1::bigint) as locked']);
  });

  it('keeps the run when the unlock fails: a lost session has already let the lock go', async () => {
    let calls = 0;
    const dropping: SqlClient = {
      query: async <R>() => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('Connection terminated'), { code: '57P01' });
        return { rows: [{ locked: true }] as R[], rowCount: 1 };
      },
    };
    expect(await advisoryLock(dropping, 'IL').withLock({ name: 'fx-void-stale', scope: 'market' }, async () => 42)).toEqual({ ran: true, value: 42 });
  });

  it('keys each job and each market apart, stably, in signed 64-bit range: the IL sweep never blocks the US one', () => {
    expect(lockKey('IL', 'load-sweep')).toBe(lockKey('IL', 'load-sweep'));
    expect(lockKey('IL', 'load-sweep')).not.toBe(lockKey('IL', 'send-sweep'));
    expect(lockKey('IL', 'load-sweep')).not.toBe(lockKey('US', 'load-sweep'));
    for (const n of ['a', 'load-sweep', 'esim-usage']) {
      expect(lockKey('US', n) >= -(2n ** 63n) && lockKey('US', n) < 2n ** 63n).toBe(true);
    }
  });

  it('a club job takes one lock across the club; a market job one per market (T-0028)', async () => {
    const keys: string[] = [];
    const recording: SqlClient = {
      query: async <R>(text: string, params?: readonly unknown[]) => {
        if (text.includes('pg_try_advisory_lock')) keys.push(String(params![0]));
        return { rows: [{ locked: true }] as R[], rowCount: 1 };
      },
    };
    for (const market of ['IL', 'US']) {
      const lock = advisoryLock(recording, market);
      await lock.withLock({ name: 'monitoring', scope: 'club' }, async () => undefined);
      await lock.withLock({ name: 'load-sweep', scope: 'market' }, async () => undefined);
    }
    const [ilClub, ilMarket, usClub, usMarket] = keys;
    expect(ilClub).toBe(usClub);
    expect(ilClub).toBe(lockKey('club', 'monitoring').toString());
    expect(ilMarket).not.toBe(usMarket);
    expect(new Set(keys).size).toBe(3);
  });
});
