// Test seeding shared by the transfer, load and payout suites.

/** Inserts a bare ops.transfer row (USD 1.00) in `f.state`, created and updated at `f.at`, so a sweep test can age it. */
export const seedTransfer = (db: { query: (t: string, p?: readonly unknown[]) => Promise<unknown> }, f: { id: string; kind: string; state: string; market: string; at: Date }) =>
  db.query(
    `insert into ops.transfer (id, idempotency_key, kind, to_party_id, amount_minor, currency, state, hold_releases_at, market, created_at, updated_at) values ($1, $2, $3, $4, 100, 'USD', $5, $6, $7, $6, $6)`,
    [f.id, `seed-${f.id}`, f.kind, f.id, f.state, f.at, f.market],
  );
