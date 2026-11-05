// VoidStaleConversionsJob (T-0520, SEQ-08): conversions left submitted by a vendor outage are failed once
// no quote can still be alive for them, nothing younger is touched, and a second run finds nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, FxSimulator, fixedClock } from '@kesher/ports';
import { ApprovalService } from '@kesher/api/approvals/service';
import { AuditService } from '@kesher/api/audit/service';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { MembershipService } from '@kesher/api/billing/memberships';
import { PlanService } from '@kesher/api/billing/plans';
import { RateService } from '@kesher/api/fx/rates';
import { FxService, reserveKey, settleKey, STALE_CONVERSION_MS, unreserveKey } from '@kesher/api/fx/service';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { TransferService } from '@kesher/api/transfers/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { VoidStaleConversionsJob } from './void-stale.ts';

let db: TestDatabase;
let transfers: TransferService;
let ledgerSvc: PostgresLedger;
let accountsSvc: AccountService;
let job: VoidStaleConversionsJob;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;

beforeAll(async () => {
  db = await createTestDatabase();
  const ledger = new PostgresLedger(db);
  const accounts = new AccountService(db, ledger);
  ledgerSvc = ledger;
  accountsSvc = accounts;
  transfers = new TransferService(db);
  const plans = new PlanService(db);
  const fx = new FxService({
    db,
    port: new FxSimulator(fixedClock(NOW.toISOString())),
    rates: new RateService(db, new ApprovalService(db), new AuditService(db)),
    ledger,
    accounts,
    transfers,
    memberships: new MembershipService(db, plans, new BillingSimulator()),
    plans,
    flags: new StaticFlags(undefined, { 'fx.enabled': true }),
  });
  job = new VoidStaleConversionsJob(fx, () => now);
}, 60_000);
afterAll(async () => db.close());

/** A conversion its vendor call left submitted at `at`. */
const stuck = async (key: string, at: Date) => {
  const party = uuidv7(at);
  const t = await transfers.create({ idempotencyKey: key, kind: 'fx', fromPartyId: party, toPartyId: party, amount: money(1_000n, 'USD') }, at);
  return transfers.apply(t.id, 'submit', at);
};

describe('VoidStaleConversionsJob (T-0520)', () => {
  it('fails what outlived its quote, leaves younger conversions alone, and finds nothing the second time', async () => {
    const old = await stuck('fx-stuck-old', NOW);
    const young = await stuck('fx-stuck-young', new Date(NOW.getTime() + STALE_CONVERSION_MS - 60_000));
    now = new Date(NOW.getTime() + STALE_CONVERSION_MS + 1_000);
    const first = await job.run();
    expect(first).toEqual({ ranAt: now.toISOString(), voided: [old.id] });
    expect(await transfers.get(old.id)).toMatchObject({ state: 'failed', failureCode: 'QUOTE_EXPIRED' });
    expect((await transfers.get(young.id))!.state).toBe('submitted');
    expect((await job.run()).voided).toEqual([]);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal`)).rows[0]).toEqual({ n: 0 });
  });
  it('a conversion whose settle journal posted before the sweep is settled, not failed, and the report does not list it', async () => {
    const at = new Date(NOW.getTime() + 3_600_000);
    const t = await stuck('fx-settle-posted', at);
    const partner = await accountsSvc.systemAccount('partner_settlement', 'USD');
    const fee = await accountsSvc.systemAccount('fee_income', 'USD');
    await ledgerSvc.post({ idempotencyKey: settleKey('fx-settle-posted'), kind: 'fx', transferId: t.id, postings: [{ accountId: partner, currency: 'USD', amountMinor: 100n }, { accountId: fee, currency: 'USD', amountMinor: -100n }] });
    now = new Date(at.getTime() + STALE_CONVERSION_MS + 1_000);
    // (An earlier test's younger conversion is stale by now and is voided too; this one must not be listed.)
    expect((await job.run()).voided).not.toContain(t.id);
    expect((await transfers.get(t.id))!.state).toBe('settled');
  });

  it('a voided conversion that had a reserve returns it once (the expired-quote path with a reserve)', async () => {
    const at = new Date(NOW.getTime() + 7_200_000);
    const party = uuidv7(at);
    await accountsSvc.provisionMember(party);
    const wallet = await accountsSvc.memberAccount(party, 'wallet', 'USD');
    const pending = await accountsSvc.memberAccount(party, 'pending', 'USD');
    const partner = await accountsSvc.systemAccount('partner_settlement', 'USD');
    await ledgerSvc.post({ idempotencyKey: `fund-${party}`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: 1_000n }, { accountId: wallet, currency: 'USD', amountMinor: -1_000n }] });
    const t0 = await transfers.create({ idempotencyKey: 'fx-with-reserve', kind: 'fx', fromPartyId: party, toPartyId: party, amount: money(1_000n, 'USD') }, at);
    const t = await transfers.apply(t0.id, 'submit', at);
    await ledgerSvc.post({ idempotencyKey: reserveKey('fx-with-reserve'), kind: 'fx', transferId: t.id, postings: [{ accountId: wallet, currency: 'USD', amountMinor: 1_000n }, { accountId: pending, currency: 'USD', amountMinor: -1_000n }] });
    const purse = async () => (await accountsSvc.purses(party)).find((p) => p.currency === 'USD')!;
    expect((await purse()).available.minor).toBe(0n);
    now = new Date(at.getTime() + STALE_CONVERSION_MS + 1_000);
    expect((await job.run()).voided).toContain(t.id);
    expect((await purse()).available.minor).toBe(1_000n);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [unreserveKey('fx-with-reserve')])).rows[0]).toEqual({ n: 1 });
    expect((await job.run()).voided).not.toContain(t.id);
    expect((await purse()).available.minor).toBe(1_000n);
  });
});
