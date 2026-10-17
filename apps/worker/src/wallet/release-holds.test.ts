// ReleaseHoldsJob (T-0502, REQ-WAL-003). TST-WAL-003: a Monday ACH load with a 3-day hold posts to the
// member's pending purse with holdUntil Thursday and shows on hold until then; the job leaves it alone
// before Thursday and on Thursday moves it to the wallet exactly once, however often it runs. An ACH
// return during the hold reverses the hold and settles nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, FundingSimulator, fixedClock } from '@kesher/ports';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { MembershipService } from '@kesher/api/billing/memberships';
import { PlanService } from '@kesher/api/billing/plans';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { TransferService } from '@kesher/api/transfers/service';
import { holdKey, LoadService, releaseKey, runLoad, settleKey, type LoadInput } from '@kesher/api/wallet/loads';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { ReleaseHoldsJob } from './release-holds.ts';

let db: TestDatabase;
const MONDAY = new Date('2026-11-02T09:00:00Z');
const THURSDAY = new Date('2026-11-05T09:00:00Z');
let now = MONDAY;
let accounts: AccountService;
let transfers: TransferService;
let loads: LoadService;
let sim: FundingSimulator;
let job: ReleaseHoldsJob;

const ach = (party: string, amountMinor: bigint): LoadInput => ({ payerPartyId: party, memberPartyId: party, method: 'ach', amount: money(amountMinor, 'USD'), paymentMethodId: 'pm_bank' });
const purse = async (party: string) => {
  const p = (await accounts.purses(party)).find((x) => x.currency === 'USD')!;
  return { available: p.available.minor, holds: p.holds.minor, settled: p.settled.minor };
};
const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase();
  const ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  transfers = new TransferService(db);
  sim = new FundingSimulator(fixedClock(MONDAY.toISOString()));
  loads = new LoadService({ db, port: sim, ledger, accounts, transfers, memberships: new MembershipService(db, new PlanService(db), new BillingSimulator()), flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'funding.ach': true }), provider: 'simulator' });
  job = new ReleaseHoldsJob(transfers, loads, () => now);
}, 60_000);
afterAll(async () => db.close());

describe('TST-WAL-003', () => {
  it('a Monday ACH load is held in pending until Thursday, then released to the wallet exactly once', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 20_000n), key, now);
    expect(run.transfer).toMatchObject({ state: 'pending_hold', holdReleasesAt: THURSDAY.toISOString() });
    expect(loads.view(run)).toEqual({ id: run.transfer.id, state: 'on_hold', amount: { minor: '20000', currency: 'USD' }, holdUntil: '2026-11-05' });
    expect(await purse(party)).toEqual({ available: 0n, holds: 20_000n, settled: 20_000n });
    const hold = (await db.query<{ kind: string; transfer_id: string }>(`select kind, transfer_id from ledger.journal where idempotency_key = $1`, [holdKey(key)])).rows[0];
    expect(hold).toEqual({ kind: 'load_hold', transfer_id: run.transfer.id });
    expect(run.transfer.journalId).toBeDefined();

    // Wednesday: not yet.
    now = new Date('2026-11-04T23:59:00Z');
    expect(await job.run()).toMatchObject({ attempted: 0, released: 0, lagMs: 0, withinSla: true });
    expect(await purse(party)).toEqual({ available: 0n, holds: 20_000n, settled: 20_000n });

    // Thursday: released, once.
    now = THURSDAY;
    expect(await job.run()).toMatchObject({ attempted: 1, released: 1, errors: [], withinSla: true });
    expect(await purse(party)).toEqual({ available: 20_000n, holds: 0n, settled: 20_000n });
    const t = (await transfers.get(run.transfer.id))!;
    expect(t.state).toBe('settled');
    const release = (await db.query<{ id: string; kind: string }>(`select id, kind from ledger.journal where idempotency_key = $1`, [releaseKey(key)])).rows[0];
    expect(release).toEqual({ id: t.journalId, kind: 'load_release' });
    expect(await journals(settleKey(key))).toBe(0);
    expect((await transfers.history(t.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'pending_hold', 'pending', 'settled']);

    for (let i = 0; i < 3; i += 1) {
      now = new Date(now.getTime() + 60_000);
      expect(await job.run()).toMatchObject({ attempted: 0, released: 0 });
    }
    expect(await purse(party)).toEqual({ available: 20_000n, holds: 0n, settled: 20_000n });
    expect(await journals(releaseKey(key))).toBe(1);
    // A rerun of the workflow, and the vendor's own confirmation, change nothing more.
    expect(await runLoad(loads, ach(party, 20_000n), key, now)).toMatchObject({ replayed: true, transfer: { state: 'settled' } });
    await expect(loads.release(t, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('the vendor confirming during the hold leaves it held; an ACH return reverses the hold and fails the load', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-ret-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 5_000n), key, now);
    const loadId = (await loads.vendorLoadOf(run.transfer.id))!;
    const verifier = loads.webhookVerifier();
    const notice = async (status: 'succeeded' | 'failed') => {
      const w = sim.webhookFor(loadId, status);
      const v = await verifier.verify(w.headers, w.rawBody, now);
      return loads.applyWebhook({ provider: 'funding', eventId: v.eventId, receivedAt: now.toISOString(), signatureOk: true, payload: v.payload }, now);
    };
    expect(await notice('succeeded')).toMatchObject({ state: 'pending_hold' });
    expect(await purse(party)).toEqual({ available: 0n, holds: 5_000n, settled: 5_000n });

    expect(await notice('failed')).toMatchObject({ state: 'failed', failureCode: 'VENDOR_FAILED' });
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
    const reversal = (await db.query<{ kind: string; reverses_id: string }>(`select kind, reverses_id from ledger.journal where idempotency_key = $1`, [`${holdKey(key)}:reversal`])).rows[0];
    expect(reversal).toEqual({ kind: 'reversal', reverses_id: run.transfer.journalId });
    expect(await notice('failed')).toMatchObject({ state: 'failed' });
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);

    // Thursday: nothing to release for it.
    now = THURSDAY;
    const report = await job.run();
    expect(report.attempted).toBe(0);
  });

  it('a late hold shows as lag over the cycle, and one failing release does not stop the rest', async () => {
    const a = uuidv7(MONDAY);
    const b = uuidv7(MONDAY);
    now = MONDAY;
    const ra = await runLoad(loads, ach(a, 1_000n), `late-a-${a}`, now);
    const rb = await runLoad(loads, ach(b, 2_000n), `late-b-${b}`, now);
    // Simulate a release that cannot post: the member's wallet account is missing its row for a moment
    // (a transient DB failure stands in for anything the ledger refuses); b still releases.
    const original = loads.release.bind(loads);
    let failOnce = true;
    loads.release = async (t, at) => {
      if (t.id === ra.transfer.id && failOnce) {
        failOnce = false;
        throw new Error('ledger unavailable');
      }
      return original(t, at);
    };
    now = new Date(THURSDAY.getTime() + 10 * 60_000);
    const first = await job.run();
    expect(first).toMatchObject({ attempted: 2, released: 1, errors: [{ transferId: ra.transfer.id, error: 'ledger unavailable' }], lagMs: 10 * 60_000, withinSla: false });
    expect(await transfers.get(rb.transfer.id)).toMatchObject({ state: 'settled' });
    expect(await transfers.get(ra.transfer.id)).toMatchObject({ state: 'pending_hold' });
    const second = await job.run();
    expect(second).toMatchObject({ attempted: 1, released: 1, errors: [], lagMs: 0, withinSla: true });
    expect(await purse(a)).toEqual({ available: 1_000n, holds: 0n, settled: 1_000n });
    loads.release = original;
  });
});
