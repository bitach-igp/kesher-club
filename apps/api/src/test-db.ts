// Test database: PGlite with db/roles.sql and every migration under db/migrations applied in the
// order atlas.hcl lists the schemas. `asRole('club_app')` runs a query under the service role so
// grant tests (REQ-LED-002) are real.
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Database, QueryResult, SqlClient } from './db.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const SCHEMA_ORDER = ['ledger', 'identity', 'org', 'billing', 'addons', 'notify', 'audit', 'agent'];

export interface TestDatabase extends Database {
  /** Runs `fn` with `set role` applied, then resets. */
  asRole<T>(role: string, fn: (db: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'db/roles.sql'), 'utf8'));
  for (const schema of SCHEMA_ORDER) {
    const dir = path.join(ROOT, 'db/migrations', schema);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  }
  const wrap = (q: PGlite | { query: PGlite['query'] }): SqlClient => ({
    async query<R>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
      const r = await q.query<R>(text, params ? [...params] : undefined);
      // PGlite reports affectedRows for writes only; a SELECT's count is its row array.
      return { rows: r.rows, rowCount: r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0) };
    },
  });
  const base = wrap(pg);
  return {
    query: base.query,
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    asRole: async (role, fn) => {
      await pg.exec(`set role ${role}`);
      try {
        return await fn(base);
      } finally {
        await pg.exec('reset role');
      }
    },
    close: () => pg.close(),
  };
}
