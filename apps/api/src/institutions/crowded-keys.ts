// The Crowded adapter's idempotency ledger in Postgres (T-0659, REQ-INS-022). Crowded's creates take no idempotency key, so the
// adapter remembers key -> result (and the SHA-256 of the request) itself; in memory that is lost on a restart, and a retry would
// create a second organization or payment. This `KeyLedger` keeps it in ops.vendor_idempotency, unique on (provider, key):
// first write wins, nothing is updated or deleted (club_app has select and insert only). A second put for the same key with
// another body hash is refused as IDEMPOTENCY_CONFLICT; the same hash is a no-op. Only the hash is stored, never the request.
// Results are stored as JSON with a bigint as {"$bigint":"123"}: JSON has no bigint and a plain JSON.stringify throws on one. An
// undefined result is SQL NULL and a null result is the JSON value null, so each reads back as what was written.
// Known limits of the encoding: it is plain JSON, so a result shaped exactly like {"$bigint":"5"} reads back as 5n (the key is not
// escaped), and an undefined inside an array becomes null and undefined fields, Dates and the like do not survive. Port results are
// plain data, so none has these shapes today. Only a top-level undefined (SQL NULL) and null are told apart.
// Known limit: get-then-put is not atomic, so two identical concurrent calls (same key, same body) can both miss `get` and both
// reach Crowded. KeyLedger returns no "who won", the loser's put is a no-op and its caller keeps its own result. The workflow id
// serialises retries, so this does not arise for retries that run one after another.
import type { KeyLedger } from '@kesher/adapters';
import { InstitutionBankingError } from '@kesher/ports';
import type { SqlClient } from '../db.ts';

/** JSON.stringify that writes a bigint as {"$bigint":"<digits>"}. */
export const encodeResult = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));

/** The inverse of `encodeResult`: an object whose only key is `$bigint` (a decimal string) becomes a bigint again. */
export const decodeResult = (text: string): unknown =>
  JSON.parse(text, (_k, v: unknown) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const digits = (v as Record<string, unknown>)['$bigint'];
      if (keys.length === 1 && keys[0] === '$bigint' && typeof digits === 'string' && /^-?\d+$/.test(digits)) return BigInt(digits);
    }
    return v;
  });

export class PostgresVendorKeyLedger implements KeyLedger {
  private readonly db: SqlClient;
  private readonly provider: string;
  private readonly clock: () => Date;

  constructor(db: SqlClient, provider: string, clock: () => Date = () => new Date()) {
    this.db = db;
    this.provider = provider;
    this.clock = clock;
  }

  async get(key: string): Promise<{ body: string; result: unknown } | undefined> {
    // result is read as text: the driver would give both SQL NULL and the JSON null as null, and decoding by hand keeps bigints.
    const r = await this.db.query<{ body_hash: string; result: string | null }>('select body_hash, result::text as result from ops.vendor_idempotency where provider = $1 and key = $2', [this.provider, key]);
    const row = r.rows[0];
    return row ? { body: row.body_hash, result: row.result === null ? undefined : decodeResult(row.result) } : undefined;
  }

  async put(key: string, entry: { body: string; result: unknown }): Promise<void> {
    const inserted = await this.db.query<{ key: string }>(
      'insert into ops.vendor_idempotency (provider, key, body_hash, result, created_at) values ($1, $2, $3, $4::jsonb, $5) on conflict (provider, key) do nothing returning key',
      [this.provider, key, entry.body, entry.result === undefined ? null : encodeResult(entry.result), this.clock()],
    );
    if (inserted.rows.length > 0) return;
    // Someone wrote this key first (an earlier attempt, or a concurrent one): the same request is a repeat, another is a conflict.
    const prior = await this.get(key);
    if (prior && prior.body !== entry.body) throw new InstitutionBankingError('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different body');
  }
}
