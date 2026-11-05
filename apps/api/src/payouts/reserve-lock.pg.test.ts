// T-0550 on real Postgres (REQ-INS-021, F13): two institution payouts race for the last of one master. The guard is the one
// `PayoutService.reserveInstitution` passes to `postNoOverdraft` (master balance re-read under the master's advisory lock). Runs only
// when TEST_PG_URL names a migrated Postgres 16 (see handoff/desktop/T-0550-institution-payout-reserve.md); elsewhere it is skipped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, DomainError, type Posting } from '@kesher/domain';
import { PostgresLedger } from '../ledger/post.ts';
import { createPgDatabase, type PgDatabase } from '../pg.ts';

const url = process.env['TEST_PG_URL'];
const run = url ? describe : describe.skip;

run('an institution payout reserve on real Postgres (several connections)', () => {
  let db: PgDatabase;
  let ledger: PostgresLedger;
  const mk = async (type: 'institution_master' | 'payout_reserve' | 'partner_settlement'): Promise<string> => {
    const id = uuidv7();
    await db.query(`insert into ledger.account (id, owner_party_id, type, currency, normal_side) values ($1, $2, $3, 'ILS', $4)`, [id, type === 'partner_settlement' ? null : uuidv7(), type, type === 'partner_settlement' ? 'D' : 'C']);
    return id;
  };
  const p = (accountId: string, amountMinor: bigint): Posting => ({ accountId, currency: 'ILS', amountMinor });

  beforeAll(() => {
    db = createPgDatabase(url!, { max: 20 });
    ledger = new PostgresLedger(db);
  });
  afterAll(async () => db.close());

  it('ten simultaneous reserves of 1,000 against 6,000: exactly six succeed, the master ends at zero and the reserve holds 6,000', async () => {
    const partner = await mk('partner_settlement');
    const master = await mk('institution_master');
    const reserve = await mk('payout_reserve');
    await ledger.post({ idempotencyKey: `pg-res-fund-${master}`, kind: 'deposit', postings: [p(partner, 6_000n), p(master, -6_000n)] });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        ledger.postNoOverdraft({ idempotencyKey: `pg-res-${i}-${master}`, kind: 'payout_reserve', postings: [p(master, 1_000n), p(reserve, -1_000n)] }, async (tx) => {
          const b = await tx.query<{ balance: string }>('select coalesce(balance_minor, 0)::text as balance from ops.account_balance where account_id = $1', [master]);
          if (BigInt(b.rows[0]?.balance ?? '0') + 1_000n > 0n) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the institution account for this payout');
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'INSUFFICIENT_FUNDS')).toHaveLength(4);
    expect(await ledger.balance(master, 'ILS')).toBe(0n);
    expect(await ledger.balance(reserve, 'ILS')).toBe(-6_000n);
  });
});
