// T-0020: the node-postgres binding against a real wire-protocol server. PGlite serves the migrated
// schema over its socket server, so the driver, the protocol and the ledger's triggers are all real.
// The socket server multiplexes clients over PGlite's one session, so the pool is one connection wide:
// that keeps commit and rollback unambiguous.
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { uuidv7 } from '@kesher/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPgError, PG } from './db.ts';
import { createPgDatabase, type PgDatabase } from './pg.ts';
import { createMigratedPGlite } from './test-db.ts';

/** Migrating a fresh PGlite takes seconds, and well over vitest's 10 s hook default when every package tests at once. */
const MIGRATED_PGLITE_MS = 60_000;
let lite: PGlite;
let server: PGLiteSocketServer;
let db: PgDatabase;

beforeAll(async () => {
  lite = await createMigratedPGlite();
  // Room beyond the shared pool for the idle-timeout test's pools: the server frees a closed client's slot
  // a tick late, so a pool that connects right after another closes would be refused at a tight limit.
  server = new PGLiteSocketServer({ db: lite, host: '127.0.0.1', port: 0, maxConnections: 4 });
  await server.start();
  db = createPgDatabase(`postgres://postgres@${server.getServerConn()}/postgres?sslmode=disable`, { max: 1 });
}, MIGRATED_PGLITE_MS);

afterAll(async () => {
  await db.close();
  await server.stop();
  await lite.close();
});

const account = async (currency: 'USD' | 'ILS'): Promise<string> => {
  const id = uuidv7();
  await db.query(`insert into ledger.account (id, type, currency, normal_side) values ($1, 'fee_income', $2, 'C')`, [id, currency]);
  return id;
};

describe('createPgDatabase (T-0020)', () => {
  it('binds parameters and keeps bigint columns as strings, never JS numbers', async () => {
    const r = await db.query<{ big: string; n: number; t: Date }>(`select $1::bigint as big, 7::int as n, now() as t`, [9_007_199_254_740_993n]);
    expect(r.rows).toEqual([{ big: '9007199254740993', n: 7, t: expect.any(Date) }]);
    expect(r.rowCount).toBe(1);
  });

  it('commits a transaction on return and reports write counts', async () => {
    const id = uuidv7();
    await db.transaction(async (tx) => {
      const w = await tx.query(`insert into ledger.account (id, type, currency, normal_side) values ($1, 'fee_income', 'USD', 'C')`, [id]);
      expect(w.rowCount).toBe(1);
    });
    expect((await db.query(`select 1 from ledger.account where id = $1`, [id])).rowCount).toBe(1);
  });

  it('rolls back on a throw and re-throws the error with its Postgres code intact', async () => {
    const a = await account('ILS');
    const id = uuidv7();
    const err = await db
      .transaction(async (tx) => {
        await tx.query(`insert into ledger.account (id, type, currency, normal_side) values ($1, 'fee_income', 'ILS', 'C')`, [id]);
        await tx.query(`insert into ledger.account (id, type, currency, normal_side) values ($1, 'fee_income', 'ILS', 'C')`, [a]);
      })
      .catch((e: unknown) => e);
    expect(isPgError(err, PG.UNIQUE_VIOLATION)).toBe(true);
    expect((await db.query(`select 1 from ledger.account where id = $1`, [id])).rowCount).toBe(0);
  });

  it('rolls back writes that succeeded when the code throws afterwards: nothing half-done survives', async () => {
    const id = uuidv7();
    const err = await db
      .transaction(async (tx) => {
        await tx.query(`insert into ledger.account (id, type, currency, normal_side) values ($1, 'fee_income', 'USD', 'C')`, [id]);
        throw new Error('vendor said no after the write');
      })
      .catch((e: unknown) => e);
    expect(err).toEqual(new Error('vendor said no after the write'));
    expect((await db.query(`select 1 from ledger.account where id = $1`, [id])).rowCount).toBe(0);
  });

  it('surfaces the ledger trigger as P0001, even when it fires at commit: an unbalanced journal writes nothing', async () => {
    const [a, b] = [await account('USD'), await account('USD')];
    const journal = uuidv7();
    const err = await db
      .transaction(async (tx) => {
        await tx.query(`insert into ledger.journal (id, idempotency_key, kind, effective_at) values ($1, $2, 'test', now())`, [journal, `pg-test:${journal}`]);
        await tx.query(`insert into ledger.posting (journal_id, account_id, currency, amount_minor) values ($1, $2, 'USD', 100), ($1, $3, 'USD', -99)`, [journal, a, b]);
      })
      .catch((e: unknown) => e);
    expect(isPgError(err, PG.RAISE_EXCEPTION)).toBe(true);
    expect((await db.query(`select 1 from ledger.journal where id = $1`, [journal])).rowCount).toBe(0);
  });

  it('keeps working after a failed transaction: the connection went back clean', async () => {
    await db.transaction(async () => Promise.reject(new Error('boom'))).catch(() => undefined);
    expect((await db.query<{ ok: number }>(`select 1 as ok`)).rows).toEqual([{ ok: 1 }]);
  });

  it('reaps an idle connection after idleTimeoutMs, and with 0 keeps it, so session state such as an advisory lock survives', async () => {
    const url = `postgres://postgres@${server.getServerConn()}/postgres?sslmode=disable`;
    const opened = async (idleTimeoutMs: number): Promise<number> => {
      let n = 0;
      const count = (): void => void (n += 1);
      server.addEventListener('connection', count);
      const pool = createPgDatabase(url, { max: 1, idleTimeoutMs });
      await pool.query('select 1');
      await new Promise((r) => setTimeout(r, 150));
      await pool.query('select 1');
      await pool.close();
      server.removeEventListener('connection', count);
      return n;
    };
    expect(await opened(20)).toBe(2);
    expect(await opened(0)).toBe(1);
  });
});
