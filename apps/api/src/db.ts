// Minimal SQL client contract shared by every module. Production binds node-postgres; tests and
// previews bind PGlite (in-process Postgres 16) with the real migrations, so SQL, triggers and
// grants are exercised, not mocked. Values go in as parameters; bigint columns come back as
// strings (never as JS numbers).
export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface Database extends SqlClient {
  /** Runs `fn` in one transaction; a thrown error rolls back and is re-thrown. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/** Postgres error shape we care about (both node-postgres and PGlite expose these). */
export interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

export const PG = {
  UNIQUE_VIOLATION: '23505',
  INSUFFICIENT_PRIVILEGE: '42501',
  RAISE_EXCEPTION: 'P0001',
  SERIALIZATION_FAILURE: '40001',
} as const;

export const isPgError = (e: unknown, code?: string): e is PgError =>
  typeof e === 'object' && e !== null && 'code' in e && (code === undefined || (e as PgError).code === code);
