// ReleaseHoldsJob (T-0502, REQ-WAL-003). TST-WAL-003: a Monday ACH load with a 3-day hold posts to the
// member's pending purse with holdUntil Thursday and shows on hold until then; the job leaves it alone
// before Thursday and on Thursday moves it to the wallet exactly once, however often it runs. An ACH
// return during the hold reverses the hold and settles nothing. A US institution's ACH pull (T-0617) is held
// in its own hold account and released into its own account the same way.
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, FundingError, FundingSimulator, fixedClock } from '@kesher/ports';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { MembershipService } from '@kesher/api/billing/memberships';
import { PlanService } from '@kesher/api/billing/plans';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { TransferService } from '@kesher/api/transfers/service';
import { holdKey, LoadService, releaseKey, runLoad, settleKey, type LoadInput } from '@kesher/api/wallet/loads';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { LoadWorkflow, STALE_AFTER_MS } from './load-workflow.ts';
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

  it('an ACH returned on day 2 whose webhook never arrived is failed at the release date, never credited to the wallet (F05)', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-lost-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 7_000n), key, now);
    const loadId = (await loads.vendorLoadOf(run.transfer.id))!;
    // Tuesday: the bank returns the debit. The vendor knows; our webhook endpoint never hears of it.
    const w = sim.webhookFor(loadId, 'failed');
    await sim.parseWebhook(w.headers, w.rawBody);
    expect(await purse(party)).toEqual({ available: 0n, holds: 7_000n, settled: 7_000n });

    now = THURSDAY;
    const report = await job.run();
    expect(report).toMatchObject({ attempted: 1, released: 0, errors: [] });
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
    expect(await transfers.get(run.transfer.id)).toMatchObject({ state: 'failed', failureCode: 'VENDOR_FAILED' });
    expect(await journals(releaseKey(key))).toBe(0);
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    // The member is told through the transfer's failed event.
    expect((await transfers.history(run.transfer.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'pending_hold', 'failed']);

    // A second cycle, and a replayed release, post nothing more.
    now = new Date(now.getTime() + 60_000);
    expect(await job.run()).toMatchObject({ attempted: 0, released: 0 });
    await expect(loads.release((await transfers.get(run.transfer.id))!, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
  });

  it('the vendor saying the return during the hold, by webhook or by the sweep, reaches the same end state; a vendor outage at release credits nothing', async () => {
    const [a, b] = [uuidv7(MONDAY), uuidv7(MONDAY)];
    now = MONDAY;
    const [runA, runB] = [await runLoad(loads, ach(a, 3_000n), `ach-hook-${a}`, now), await runLoad(loads, ach(b, 3_000n), `ach-sweep-${b}`, now)];
    for (const r of [runA, runB]) {
      const id = (await loads.vendorLoadOf(r.transfer.id))!;
      const w = sim.webhookFor(id, 'failed');
      await sim.parseWebhook(w.headers, w.rawBody);
    }
    // A: the webhook reaches us. B: the sweep asks the vendor (what the worker's resume does).
    const idA = (await loads.vendorLoadOf(runA.transfer.id))!;
    const verifier = loads.webhookVerifier();
    const hook = sim.webhookFor(idA, 'failed');
    const v = await verifier.verify(hook.headers, hook.rawBody, now);
    const viaHook = await loads.applyWebhook({ provider: 'funding', eventId: v.eventId, receivedAt: now.toISOString(), signatureOk: true, payload: v.payload }, now);
    const wf = new LoadWorkflow(loads, sim, () => now);
    now = new Date(MONDAY.getTime() + STALE_AFTER_MS + 1); // the held load is past the stale window
    const swept = await wf.sweep();
    expect(swept.failed).toBeGreaterThanOrEqual(1);
    expect(swept.errors).toEqual([]);
    const viaSweep = (await transfers.get(runB.transfer.id))!;
    now = MONDAY;
    expect(viaHook).toMatchObject({ state: 'failed', failureCode: 'VENDOR_FAILED' });
    expect(viaSweep).toMatchObject({ state: 'failed', failureCode: 'VENDOR_FAILED' });
    expect(await purse(a)).toEqual(await purse(b));
    expect(await purse(a)).toEqual({ available: 0n, holds: 0n, settled: 0n });

    // The vendor cannot be asked on the release date: the hold stays, the money is not released blind.
    const c = uuidv7(MONDAY);
    now = MONDAY;
    const runC = await runLoad(loads, ach(c, 4_000n), `ach-out-${c}`, now);
    const realGet = sim.getLoad.bind(sim);
    sim.getLoad = async () => {
      throw new FundingError('PROVIDER_UNAVAILABLE', 'down');
    };
    now = THURSDAY;
    const report = await job.run();
    sim.getLoad = realGet;
    expect(report.released).toBe(0);
    expect(report.errors.some((e) => e.transferId === runC.transfer.id)).toBe(true);
    expect(await purse(c)).toEqual({ available: 0n, holds: 4_000n, settled: 4_000n });
    expect(await transfers.get(runC.transfer.id)).toMatchObject({ state: 'pending_hold' });
    // Back up: the next cycle releases it.
    expect(await job.run()).toMatchObject({ released: 1 });
    expect(await purse(c)).toEqual({ available: 4_000n, holds: 0n, settled: 4_000n });
  });

  it('a return that lands between the vendor check and the release does not leave money in the wallet (the release journal is reversed once)', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-race-a-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 6_000n), key, now);
    // The load is failed (webhook or sweep) just as the release gets to the row lock.
    const realApply = transfers.apply.bind(transfers);
    let injected = false;
    transfers.apply = async (id, event, at, extra) => {
      if (event === 'release_hold' && !injected) {
        injected = true;
        await loads.fail((await transfers.get(id))!, 'VENDOR_FAILED', at);
      }
      return realApply(id, event, at, extra);
    };
    now = THURSDAY;
    try {
      await expect(loads.release((await transfers.get(run.transfer.id))!, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    } finally {
      transfers.apply = realApply;
    }
    expect(await transfers.get(run.transfer.id)).toMatchObject({ state: 'failed' });
    expect(await journals(releaseKey(key))).toBe(1);
    expect(await journals(`${releaseKey(key)}:reversal`)).toBe(1);
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
  });

  it('a return handled from a stale read after the release has won leaves the released load alone', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-race-b-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 2_500n), key, now);
    const stale = (await transfers.get(run.transfer.id))!; // still pending_hold in this reader's hands
    now = THURSDAY;
    await loads.release(stale, now);
    expect(await purse(party)).toEqual({ available: 2_500n, holds: 0n, settled: 2_500n });
    await expect(loads.fail(stale, 'VENDOR_FAILED', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await transfers.get(run.transfer.id)).toMatchObject({ state: 'settled' });
    // It decided on the row as it is now (settled), so it reversed nothing and has nothing to undo.
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(0);
    expect(await journals(`${holdKey(key)}:reversal:undo`)).toBe(0);
    expect(await purse(party)).toEqual({ available: 2_500n, holds: 0n, settled: 2_500n });
  });

  it('a return that lands after the release moved the row to pending, before it settled, undoes both the hold and the release', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-race-c-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 5_500n), key, now);
    const realApply = transfers.apply.bind(transfers);
    let injected = false;
    transfers.apply = async (id, event, at, extra) => {
      if (event === 'settle' && !injected) {
        injected = true;
        await loads.fail((await transfers.get(id))!, 'VENDOR_FAILED', at); // the row is pending: the release journal is posted
      }
      return realApply(id, event, at, extra);
    };
    now = THURSDAY;
    try {
      await expect(loads.release((await transfers.get(run.transfer.id))!, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    } finally {
      transfers.apply = realApply;
    }
    expect(await transfers.get(run.transfer.id)).toMatchObject({ state: 'failed' });
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await journals(`${releaseKey(key)}:reversal`)).toBe(1);
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
  });

  it('a release journal orphaned by a crash is reversed when the vendor later reports the return', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-orphan-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 4_200n), key, now);
    const realApply = transfers.apply.bind(transfers);
    transfers.apply = async (id, event, at, extra) => {
      if (event === 'release_hold') throw new Error('process died');
      return realApply(id, event, at, extra);
    };
    now = THURSDAY;
    try {
      await expect(loads.release((await transfers.get(run.transfer.id))!, now)).rejects.toThrow('process died');
    } finally {
      transfers.apply = realApply;
    }
    expect(await transfers.get(run.transfer.id)).toMatchObject({ state: 'pending_hold' });
    expect(await journals(releaseKey(key))).toBe(1); // posted, the row never moved
    expect(await purse(party)).toEqual({ available: 4_200n, holds: 0n, settled: 4_200n }); // wallet credited by the orphan

    // The bank returns the debit; the next cycle finds out.
    const loadId = (await loads.vendorLoadOf(run.transfer.id))!;
    const w = sim.webhookFor(loadId, 'failed');
    await sim.parseWebhook(w.headers, w.rawBody);
    expect(await job.run()).toMatchObject({ attempted: 1, released: 0, errors: [] });
    expect(await transfers.get(run.transfer.id)).toMatchObject({ state: 'failed' });
    expect(await journals(`${releaseKey(key)}:reversal`)).toBe(1);
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
  });

  it('a transient error while a held load is being failed leaves the reversals in place, and the retry finishes the job', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-transient-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 3_300n), key, now);
    const realApply = transfers.apply.bind(transfers);
    let failed = false;
    transfers.apply = async (id, event, at, extra) => {
      if (event === 'fail' && !failed) {
        failed = true;
        throw new Error('connection reset');
      }
      return realApply(id, event, at, extra);
    };
    try {
      await expect(loads.fail((await transfers.get(run.transfer.id))!, 'VENDOR_FAILED', now)).rejects.toThrow('connection reset');
    } finally {
      transfers.apply = realApply;
    }
    // Still held, hold reversed, nothing undone.
    expect(await transfers.get(run.transfer.id)).toMatchObject({ state: 'pending_hold' });
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await journals(`${holdKey(key)}:reversal:undo`)).toBe(0);
    // The retry fails it; the money is gone from pending and nothing reached the wallet.
    expect(await loads.fail((await transfers.get(run.transfer.id))!, 'VENDOR_FAILED', now)).toMatchObject({ state: 'failed' });
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
  });

  it('a fail built from a stale read of the row (before the hold posted) still reverses the hold', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-stale-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 2_200n), key, now);
    const stale = { ...(await transfers.get(run.transfer.id))!, state: 'submitted' as const };
    expect(await loads.fail(stale, 'VENDOR_FAILED', now)).toMatchObject({ state: 'failed' });
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
  });

  it('a release is refused when the hold was already reversed: no release journal is posted behind a return', async () => {
    const party = uuidv7(MONDAY);
    const key = `ach-reversed-${party}`;
    now = MONDAY;
    const run = await runLoad(loads, ach(party, 1_700n), key, now);
    // The return reversed the hold but the row is still in its hold (the process died before the fail).
    await new PostgresLedger(db).reverse(run.transfer.journalId!, `${holdKey(key)}:reversal`);
    now = THURSDAY;
    await expect(loads.release((await transfers.get(run.transfer.id))!, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await journals(releaseKey(key))).toBe(0);
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
    // The fail that never happened is finished by the next pass, and nothing is posted twice.
    expect(await loads.fail((await transfers.get(run.transfer.id))!, 'VENDOR_FAILED', now)).toMatchObject({ state: 'failed' });
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect(await purse(party)).toEqual({ available: 0n, holds: 0n, settled: 0n });
  });

  it('an institution\'s ACH pull is held in its own hold account and released into its own account on Thursday (T-0617)', async () => {
    const institution = uuidv7(MONDAY);
    const key = `ach-pull:${institution}:monday`;
    now = MONDAY;
    const pull: LoadInput = { ...ach(institution, 1_000_000n), kind: 'deposit' };
    const run = await runLoad(loads, pull, key, now);
    expect(run.transfer).toMatchObject({ kind: 'deposit', state: 'pending_hold', holdReleasesAt: THURSDAY.toISOString() });
    const held = async () => ({ holds: (await accounts.institutionHolds(institution, 'USD')).minor, available: (await accounts.institutionBalance(institution, 'USD')).minor });
    expect(await held()).toEqual({ holds: 1_000_000n, available: 0n });
    now = new Date('2026-11-04T23:59:00Z');
    expect(await job.run()).toMatchObject({ attempted: 0 });
    now = THURSDAY;
    expect(await job.run()).toMatchObject({ attempted: 1, released: 1, errors: [] });
    expect(await held()).toEqual({ holds: 0n, available: 1_000_000n });
    const release = (await db.query<{ kind: string; metadata: Record<string, unknown> }>(`select kind, metadata from ledger.journal where idempotency_key = $1`, [releaseKey(key)])).rows[0];
    expect(release).toMatchObject({ kind: 'deposit', metadata: { institutionId: institution, rail: 'ach' } });
  });

  it('each sweep reports how many times it asked the vendor (T-0681): the release job for the held loads it reached, the load sweep for the loads it resumed', async () => {
    const party = uuidv7(MONDAY);
    now = MONDAY;
    await runLoad(loads, ach(party, 6_000n), `ach-reads-${party}`, now);
    const realGet = sim.getLoad.bind(sim);
    let calls = 0;
    sim.getLoad = async (id) => {
      calls += 1;
      return realGet(id);
    };
    try {
      // Before the release date nothing is due: no read.
      now = new Date('2026-11-04T23:59:00Z');
      expect(await job.run()).toMatchObject({ attempted: 0, vendorReads: 0 });
      expect(calls).toBe(0);
      // On the date each due hold is asked about once, and the report says how many.
      now = THURSDAY;
      const report = await job.run();
      expect(report.vendorReads).toBe(calls);
      expect(report.vendorReads).toBeGreaterThanOrEqual(1);
      // The load sweep counts what it asked too, equal to what the vendor saw.
      calls = 0;
      const swept = await new LoadWorkflow(loads, sim, () => now).sweep();
      expect(swept.vendorReads).toBe(calls);
    } finally {
      sim.getLoad = realGet;
    }
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

// T-0705, TST-WAL-003: the vendor credit comes before the release journal. Over the credit-capable funding simulator.
describe('the credit before the release journal (T-0705)', () => {
  let csim: FundingSimulator;
  let cledger: PostgresLedger;
  let cloads: LoadService;
  let cjob: ReleaseHoldsJob;
  let spy: MockInstance<Required<FundingSimulator>['creditWallet']>;

  beforeAll(() => {
    cledger = new PostgresLedger(db);
    csim = new FundingSimulator(fixedClock(MONDAY.toISOString()), { credit: true });
    cloads = new LoadService({ db, port: csim, credit: csim as Required<FundingSimulator>, ledger: cledger, accounts, transfers, memberships: new MembershipService(db, new PlanService(db), new BillingSimulator()), flags: new StaticFlags(undefined, { 'wallet.enabled': true, 'funding.ach': true }), provider: 'simulator-credit' });
    cjob = new ReleaseHoldsJob(transfers, cloads, () => now);
    spy = vi.spyOn(csim as Required<FundingSimulator>, 'creditWallet');
  });

  /** A held Monday ACH load for a fresh member (with a funding account ref unless told not to), the vendor id and the key. */
  const held = async (opts: { account?: boolean } = {}) => {
    const party = uuidv7(MONDAY);
    const key = `ach-credit-${party}`;
    now = MONDAY;
    if (opts.account !== false) await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('funding_account', $1, 'simulator-credit', $2)`, [party, `a:${party}`]);
    const run = await runLoad(cloads, ach(party, 12_000n), key, now);
    const loadId = (await cloads.vendorLoadOf(run.transfer.id))!;
    return { party, key, loadId, id: run.transfer.id };
  };
  const caseOf = async (id: string) => (await db.query<{ status: string; payload: { attempt: number; reasonCode: string; loadId: string; transferId: string; amount: { minor: string } } }>(`select status, payload from ops.case where dedupe_key = $1`, [`load-credit:${id}`])).rows;
  const keysUsed = () => spy.mock.calls.map((c) => c[1] as string);

  it('a hold the vendor still reports on_hold after our date is pending: no call, no case, no journal; once it reads succeeded it credits once, then one release journal', async () => {
    const t = await held();
    spy.mockClear();
    now = THURSDAY; // our clock says due; the vendor's still says on_hold
    expect(await cjob.run()).toMatchObject({ attempted: 1, released: 0, credited: 0, refused: 0, errors: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(await caseOf(t.id)).toEqual([]);
    expect(await journals(releaseKey(t.key))).toBe(0);
    expect((await transfers.get(t.id))!.state).toBe('pending_hold');

    csim.settle(t.loadId);
    expect(await cjob.run()).toMatchObject({ attempted: 1, released: 1, credited: 1, refused: 0, errors: [] });
    expect(keysUsed()).toEqual([`${t.key}:credit:1`]);
    expect(csim.creditCount(t.loadId)).toBe(1);
    expect(await journals(releaseKey(t.key))).toBe(1);
    expect(await purse(t.party)).toEqual({ available: 12_000n, holds: 0n, settled: 12_000n });
    expect(await cjob.run()).toMatchObject({ attempted: 0, credited: 0 });
  });

  it('a crash between the credit and the journal is finished by the next sweep: the credit is asked again, answered credited, and ONE journal posts', async () => {
    const t = await held();
    csim.settle(t.loadId);
    now = THURSDAY;
    spy.mockClear();
    const post = vi.spyOn(cledger, 'post').mockRejectedValueOnce(new Error('crash'));
    expect(await cjob.run()).toMatchObject({ released: 0, credited: 1, errors: [{ transferId: t.id, error: 'crash' }] });
    post.mockRestore();
    expect(await journals(releaseKey(t.key))).toBe(0);
    expect(await cjob.run()).toMatchObject({ released: 1, credited: 1, errors: [] });
    expect(keysUsed()).toEqual([`${t.key}:credit:1`, `${t.key}:credit:1`]);
    expect(csim.creditCount(t.loadId)).toBe(1);
    expect(await journals(releaseKey(t.key))).toBe(1);
  });

  it('a pending answer posts nothing and the next cycle retries the SAME key; an outage is an error, nothing moved, the same key again', async () => {
    const t = await held();
    csim.settle(t.loadId);
    now = THURSDAY;
    spy.mockClear();
    csim.pendNext();
    expect(await cjob.run()).toMatchObject({ released: 0, credited: 0, refused: 0, errors: [] });
    expect(await journals(releaseKey(t.key))).toBe(0);
    expect(await caseOf(t.id)).toEqual([]);
    csim.outageNext();
    const outage = await cjob.run();
    expect(outage.errors).toHaveLength(1);
    expect(outage.released).toBe(0);
    expect(await cjob.run()).toMatchObject({ released: 1, credited: 1, errors: [] });
    expect(new Set(keysUsed())).toEqual(new Set([`${t.key}:credit:1`]));
    expect(csim.creditCount(t.loadId)).toBe(1);
    expect(await journals(releaseKey(t.key))).toBe(1);
  });

  it('a refusal opens ONE load_credit_refused case, posts nothing, is not asked again while open; resolving it retries under :credit:2 and one journal follows; a second refusal reopens the same case', async () => {
    const t = await held();
    csim.settle(t.loadId);
    now = THURSDAY;
    spy.mockClear();
    csim.failNext('ACCOUNT_UNAVAILABLE');
    expect(await cjob.run()).toMatchObject({ released: 0, credited: 0, refused: 1, errors: [] });
    const [c1, ...rest] = await caseOf(t.id);
    expect(rest).toEqual([]);
    expect(c1).toMatchObject({ status: 'open', payload: { transferId: t.id, loadId: t.loadId, amount: { minor: '12000' }, reasonCode: 'ACCOUNT_UNAVAILABLE', attempt: 1 } });
    expect((await db.query<{ kind: string; severity: string }>(`select kind, severity from ops.case where dedupe_key = $1`, [`load-credit:${t.id}`])).rows[0]).toEqual({ kind: 'load_credit_refused', severity: 'high' });
    expect((await transfers.get(t.id))!.state).toBe('pending_hold');
    expect(await journals(releaseKey(t.key))).toBe(0);

    // Open: the vendor's load is still read (a bank return must be seen) but the credit is not asked again.
    spy.mockClear();
    const reads = cloads.vendorReads;
    expect(await cjob.run()).toMatchObject({ released: 0, credited: 0, refused: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(cloads.vendorReads).toBe(reads + 1);
    await db.query(`update ops.case set status = 'investigating' where dedupe_key = $1`, [`load-credit:${t.id}`]);
    await cjob.run();
    expect(spy).not.toHaveBeenCalled();

    // Resolved and refused again: the next key, the same case reopened with attempt 2.
    await db.query(`update ops.case set status = 'resolved' where dedupe_key = $1`, [`load-credit:${t.id}`]);
    csim.failNext('ACCOUNT_UNAVAILABLE');
    expect(await cjob.run()).toMatchObject({ refused: 1 });
    expect(keysUsed()).toEqual([`${t.key}:credit:2`]);
    const again = await caseOf(t.id);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ status: 'open', payload: { attempt: 2 } });

    // Resolved again: attempt 3 credits, one journal.
    await db.query(`update ops.case set status = 'dismissed' where dedupe_key = $1`, [`load-credit:${t.id}`]);
    expect(await cjob.run()).toMatchObject({ released: 1, credited: 1, refused: 0 });
    expect(keysUsed()).toEqual([`${t.key}:credit:2`, `${t.key}:credit:3`]);
    expect(csim.creditCount(t.loadId)).toBe(1);
    expect(await journals(releaseKey(t.key))).toBe(1);
    expect(await purse(t.party)).toEqual({ available: 12_000n, holds: 0n, settled: 12_000n });
  });

  it('a refusal then a resolve then a credit: the retry uses :credit:2 and credits', async () => {
    const t = await held();
    csim.settle(t.loadId);
    now = THURSDAY;
    spy.mockClear();
    csim.failNext('INSUFFICIENT_FUNDS');
    await cjob.run();
    await db.query(`update ops.case set status = 'resolved' where dedupe_key = $1`, [`load-credit:${t.id}`]);
    expect(await cjob.run()).toMatchObject({ released: 1, credited: 1 });
    expect(keysUsed()).toEqual([`${t.key}:credit:1`, `${t.key}:credit:2`]);
    expect(await journals(releaseKey(t.key))).toBe(1);
  });

  it('a hosted load with no funding account ref is refused NO_ACCOUNT in the same case, with no vendor call', async () => {
    const t = await held({ account: false });
    csim.settle(t.loadId);
    now = THURSDAY;
    spy.mockClear();
    expect(await cjob.run()).toMatchObject({ released: 0, refused: 1, errors: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(await caseOf(t.id)).toMatchObject([{ status: 'open', payload: { reasonCode: 'NO_ACCOUNT', attempt: 1 } }]);
    expect(await journals(releaseKey(t.key))).toBe(0);
  });

  it('a vendor return during the hold is failed, never credited', async () => {
    const t = await held();
    const w = csim.webhookFor(t.loadId, 'failed');
    await csim.parseWebhook(w.headers, w.rawBody);
    now = THURSDAY;
    spy.mockClear();
    expect(await cjob.run()).toMatchObject({ released: 0, credited: 0, refused: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect((await transfers.get(t.id))!.state).toBe('failed');
  });

  it('a bank return while a credit case is open fails the load: the hold is reversed, nothing is credited', async () => {
    const t = await held();
    csim.settle(t.loadId);
    now = THURSDAY;
    csim.failNext('ACCOUNT_UNAVAILABLE');
    await cjob.run();
    expect(await caseOf(t.id)).toMatchObject([{ status: 'open' }]);
    // The vendor then reports the load failed (a return): the next cycle reads it and fails the load.
    (csim as unknown as { loads: Map<string, { status: string }> }).loads.get(t.loadId)!.status = 'failed';
    spy.mockClear();
    expect(await cjob.run()).toMatchObject({ released: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect((await transfers.get(t.id))!.state).toBe('failed');
    expect(await journals(releaseKey(t.key))).toBe(0);
  });

  it('a refusal already held by an open case is not counted again', async () => {
    const t = await held({ account: false });
    csim.settle(t.loadId);
    now = THURSDAY;
    expect(await cjob.run()).toMatchObject({ refused: 1 });
    expect(await cjob.run()).toMatchObject({ refused: 0 });
  });
});
