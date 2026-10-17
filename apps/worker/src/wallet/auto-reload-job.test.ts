// AutoReloadJob (T-0503, REQ-WAL-004). TST-WAL-004: threshold $50, target $200, balance $45 → one
// $155 load; a second pass within 24 h creates nothing; a failed load does not retry inside the window.
// Over the API's services, the funding simulator and PGlite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, FundingSimulator, fixedClock } from '@kesher/ports';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { MembershipService } from '@kesher/api/billing/memberships';
import { PlanService } from '@kesher/api/billing/plans';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { TransferService } from '@kesher/api/transfers/service';
import { AutoReloadService, WINDOW_MS } from '@kesher/api/wallet/auto-reload';
import { LoadService, runLoad } from '@kesher/api/wallet/loads';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { AutoReloadJob } from './auto-reload-job.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-02T09:00:00Z');
let now = NOW;
let accounts: AccountService;
let transfers: TransferService;
let loads: LoadService;
let rules: AutoReloadService;
let job: AutoReloadJob;

const usd = (minor: string) => ({ minor, currency: 'USD' });
const RULE = { threshold: usd('5000'), target: usd('20000'), method: 'card', paymentMethodId: 'pm_saved' };
const wallet = async (party: string) => (await accounts.purses(party)).find((p) => p.currency === 'USD')!;
const seed = async (party: string, minor: bigint) => runLoad(loads, { payerPartyId: party, memberPartyId: party, method: 'card', amount: money(minor, 'USD'), paymentMethodId: 'pm_ok' }, `seed-${party}-${minor}`, now);
const loadsOf = async (party: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where kind = 'load' and to_party_id = $1 and idempotency_key like 'auto-reload:%'`, [party])).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase();
  const ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  transfers = new TransferService(db);
  const flags = new StaticFlags(undefined, { 'wallet.enabled': true });
  loads = new LoadService({ db, port: new FundingSimulator(fixedClock(NOW.toISOString())), ledger, accounts, transfers, memberships: new MembershipService(db, new PlanService(db), new BillingSimulator()), flags, provider: 'simulator' });
  rules = new AutoReloadService(db, accounts, loads, flags);
  job = new AutoReloadJob(rules, () => now);
}, 60_000);
afterAll(async () => db.close());

describe('TST-WAL-004', () => {
  it('$45 under a $50 threshold loads $155 once; the next pass inside 24 h creates nothing; after the window it tops up again', async () => {
    const party = uuidv7(NOW);
    now = NOW;
    await rules.set(party, (await wallet(party)).id, RULE, now);
    await seed(party, 4_500n);

    const first = await job.run();
    expect(first).toMatchObject({ checked: 1, loaded: 1, failed: 0, errors: [] });
    expect((await wallet(party)).available.minor).toBe(20_000n);
    const t = (await transfers.byKey(`auto-reload:${(await rules.byAccount((await wallet(party)).id))!.id}:${now.getTime()}`))!;
    expect(t).toMatchObject({ kind: 'load', state: 'settled', amount: money(15_500n, 'USD'), fromPartyId: party, toPartyId: party });
    expect((await rules.byAccount((await wallet(party)).id))!).toMatchObject({ lastAttemptAt: now.toISOString(), lastTransferId: t.id });

    // Spent down to $20 inside the window: the rule is not even due.
    await db.query(`update ops.account_balance set balance_minor = balance_minor + 18000 where account_id = $1`, [(await wallet(party)).id]);
    expect((await wallet(party)).available.minor).toBe(2_000n);
    now = new Date(NOW.getTime() + WINDOW_MS - 1);
    expect(await job.run()).toMatchObject({ checked: 0, loaded: 0 });
    expect(await loadsOf(party)).toBe(1);

    now = new Date(NOW.getTime() + WINDOW_MS);
    expect(await job.run()).toMatchObject({ checked: 1, loaded: 1 });
    expect((await wallet(party)).available.minor).toBe(20_000n);
    expect(await loadsOf(party)).toBe(2);
  });

  it('a declined load counts as the attempt: no retry inside the window, one retry after it; above the threshold nothing is claimed', async () => {
    const declined = uuidv7(NOW);
    const flush = uuidv7(NOW);
    const off = uuidv7(NOW);
    now = new Date(NOW.getTime() + 10 * WINDOW_MS);
    const start = now;
    await rules.set(declined, (await wallet(declined)).id, { ...RULE, paymentMethodId: 'pm_declined' }, now);
    await rules.set(flush, (await wallet(flush)).id, RULE, now);
    await rules.set(off, (await wallet(off)).id, { ...RULE, enabled: false }, now);
    await seed(declined, 1_000n);
    await seed(flush, 9_000n);
    await seed(off, 100n);

    const first = await job.run();
    expect(first).toMatchObject({ failed: 1, loaded: 0, errors: [] });
    expect(first.aboveThreshold).toBeGreaterThanOrEqual(1); // flush, plus any earlier test's rule now due and comfortable
    expect(first.checked).toBeGreaterThanOrEqual(2);
    expect((await wallet(declined)).available.minor).toBe(1_000n);
    expect((await wallet(off)).available.minor).toBe(100n);
    const rule = (await rules.byAccount((await wallet(declined)).id))!;
    expect(rule.lastAttemptAt).toBe(now.toISOString());
    expect((await transfers.get(rule.lastTransferId!))!).toMatchObject({ state: 'failed', failureCode: 'DECLINED' });
    expect((await rules.byAccount((await wallet(flush)).id))!.lastAttemptAt).toBeUndefined();

    now = new Date(start.getTime() + WINDOW_MS - 60_000);
    const second = await job.run();
    expect(second).toMatchObject({ failed: 0, loaded: 0 });
    expect(await loadsOf(declined)).toBe(1);

    // Flush spends below the threshold: loaded on the next pass, its window untouched until then.
    await db.query(`update ops.account_balance set balance_minor = balance_minor + 8000 where account_id = $1`, [(await wallet(flush)).id]);
    expect(await job.run()).toMatchObject({ loaded: 1 });
    expect((await wallet(flush)).available.minor).toBe(20_000n);

    now = new Date(start.getTime() + WINDOW_MS);
    const third = await job.run();
    expect(third).toMatchObject({ failed: 1 });
    expect(await loadsOf(declined)).toBe(2);
  });

  it('a vendor outage is reported, claims the window all the same, and leaves the other rules running', async () => {
    const outage = uuidv7(NOW);
    const fine = uuidv7(NOW);
    now = new Date(NOW.getTime() + 20 * WINDOW_MS);
    await rules.set(outage, (await wallet(outage)).id, { ...RULE, paymentMethodId: 'pm_outage' }, now);
    await rules.set(fine, (await wallet(fine)).id, RULE, now);
    await seed(outage, 500n);
    await seed(fine, 600n);
    const r = await job.run();
    expect(r.loaded).toBeGreaterThanOrEqual(1);
    expect(r.errors).toEqual([{ ruleId: (await rules.byAccount((await wallet(outage)).id))!.id, error: expect.stringContaining('unavailable') }]);
    expect((await wallet(fine)).available.minor).toBe(20_000n);
    expect((await wallet(outage)).available.minor).toBe(500n);
    expect((await rules.byAccount((await wallet(outage)).id))!.lastAttemptAt).toBe(now.toISOString());
    now = new Date(now.getTime() + 60_000);
    expect((await job.run()).errors).toEqual([]);
    expect((await wallet(outage)).available.minor).toBe(500n);
  });
});
