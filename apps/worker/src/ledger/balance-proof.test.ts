// T-0203: balance materialisation + nightly proof (ledger invariant 2). account_balance must
// equal the sum of postings for every account; a drift opens an ops case and never self-heals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { BalanceProof, rebuildBalanceCache } from './balance-proof.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
let accounts: AccountService;

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
}, 60_000);
afterAll(async () => db.close());

async function seed() {
  const party = uuidv7();
  await accounts.provisionMember(party);
  const wallet = await accounts.memberAccount(party, 'wallet', 'USD');
  const partner = await accounts.systemAccount('partner_settlement', 'USD');
  await ledger.post({ idempotencyKey: `l:${party}`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: 5_000n }, { accountId: wallet, currency: 'USD', amountMinor: -5_000n }] });
  return { party, wallet, partner };
}

describe('nightly balance proof', () => {
  it('passes when every cached balance equals its postings and system totals are zero', async () => {
    await seed();
    const report = await new BalanceProof(db).run(new Date('2026-11-02T03:00:00Z'));
    expect(report.ok).toBe(true);
    expect(report.breaks).toEqual([]);
    expect(report.accountsChecked).toBeGreaterThan(0);
    expect([...report.systemTotals.values()].every((t) => t === 0n)).toBe(true);
  });

  it('detects a tampered cache row, reports the exact delta, and opens an ops case (THR-03)', async () => {
    const { wallet } = await seed();
    // Simulate an insider edit under the migrator role (the app role cannot do this: TST-LED-002).
    await db.query('update ops.account_balance set balance_minor = balance_minor + 1 where account_id = $1', [wallet]);
    const report = await new BalanceProof(db).run(new Date('2026-11-02T03:00:00Z'));
    expect(report.ok).toBe(false);
    expect(report.breaks).toEqual([{ accountId: wallet, cachedMinor: -4_999n, postedMinor: -5_000n, deltaMinor: 1n }]);
    const cases = await db.query<{ kind: string; payload: { accountId: string } }>(`select kind, payload from ops.case where kind = 'balance_break'`);
    expect(cases.rows.some((c) => c.payload.accountId === wallet)).toBe(true);
    // A second run on the same night does not open a second case for the same account.
    await new BalanceProof(db).run(new Date('2026-11-02T03:30:00Z'));
    expect((await db.query(`select count(*)::int as n from ops.case where kind = 'balance_break' and payload->>'accountId' = $1`, [wallet])).rows[0]).toEqual({ n: 1 });
  });

  it('rebuildBalanceCache restores the cache from postings (used only by the restore runbook, RUN-08)', async () => {
    const { wallet } = await seed();
    await db.query('update ops.account_balance set balance_minor = 123 where account_id = $1', [wallet]);
    const rebuilt = await rebuildBalanceCache(db);
    expect(rebuilt).toBeGreaterThan(0);
    const report = await new BalanceProof(db).run(new Date('2026-11-03T03:00:00Z'));
    expect(report.breaks.find((b) => b.accountId === wallet)).toBeUndefined();
  });

  it('flags a system-wide non-zero total as a break even when every account reconciles', async () => {
    // Force a one-sided posting under the migrator role, bypassing the trigger by disabling it.
    const stray = uuidv7();
    const partner = await accounts.systemAccount('partner_settlement', 'USD');
    await db.query(`alter table ledger.posting disable trigger posting_balanced`);
    await db.query(`insert into ledger.journal (id, idempotency_key, kind, effective_at) values ($1, 'stray', 'x', now())`, [stray]);
    await db.query(`insert into ledger.posting (journal_id, account_id, currency, amount_minor) values ($1, $2, 'USD', 7)`, [stray, partner]);
    await db.query(`alter table ledger.posting enable trigger posting_balanced`);
    await rebuildBalanceCache(db);
    const report = await new BalanceProof(db).run(new Date('2026-11-04T03:00:00Z'));
    expect(report.ok).toBe(false);
    expect(report.systemTotals.get('USD')).toBe(7n);
    expect(report.unbalancedJournals).toEqual([stray]);
  });
});
