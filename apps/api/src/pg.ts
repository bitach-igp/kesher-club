// node-postgres binding for `Database` (T-0020). Production and staging run on it; tests keep PGlite
// (test-db.ts), and this binding's own tests reach PGlite over the wire protocol, so both clients see the
// same migrations, triggers and grants. Results keep the contract db.ts sets: bigint and numeric columns
// stay strings (node-postgres never parses int8 to a JS number unless told to, and nothing here tells it),
// errors keep their Postgres `code`, and `rowCount` is a number, never null.
import pg from 'pg';
import type { Database, QueryResult, SqlClient } from './db.ts';

export interface PgDatabase extends Database {
  /** Ends every pooled connection; in-flight queries finish first. */
  close(): Promise<void>;
}

export interface PgOptions {
  /** Pool size per process (default 10). */
  max?: number;
  /** Abandon a query after this long, server side (default 30 s): a stuck statement must not pin a connection. */
  statementTimeoutMs?: number;
}

const wrap = (q: pg.Pool | pg.PoolClient): SqlClient => ({
  async query<R>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
    const r = await q.query(text, params ? [...params] : undefined);
    return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
  },
});

export function createPgDatabase(url: string, opts: PgOptions = {}): PgDatabase {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10, statement_timeout: opts.statementTimeoutMs ?? 30_000 });
  // An idle client that loses its connection emits here; without a listener Node would crash the process.
  // The pool drops the client and opens a fresh one on the next query.
  pool.on('error', () => undefined);
  const base = wrap(pool);
  return {
    query: base.query,
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(wrap(client));
        await client.query('commit');
        client.release();
        return out;
      } catch (e) {
        // A failed rollback means the connection is in an unknown state: destroy it rather than return it.
        await client.query('rollback').then(
          () => client.release(),
          (rollbackError: unknown) => client.release(rollbackError instanceof Error ? rollbackError : true),
        );
        throw e;
      }
    },
    close: () => pool.end(),
  };
}
