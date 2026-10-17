// LoadWorkflow (T-0501, REQ-WAL-002, SEQ-02): the run's id is the Idempotency-Key, the vendor pull
// carries it, one journal partner_settlement → wallet lands on success and never a second one however
// often the run repeats; a decline fails once; an outage leaves the run resumable; the sweep finishes
// loads whose webhook never came. Over the API's LoadService, the funding simulator and PGlite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, FundingError, FundingSimulator, fixedClock, type FundingPort, type Load } from '@kesher/ports';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { MembershipService } from '@kesher/api/billing/memberships';
import { PlanService } from '@kesher/api/billing/plans';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { TransferService } from '@kesher/api/transfers/service';
import { LoadService, settleKey, type LoadInput } from '@kesher/api/wallet/loads';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { LoadWorkflow, STALE_AFTER_MS } from './load-workflow.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-01T09:00:00Z');
let now = NOW;
const clock = () => now;
let accounts: AccountService;
let transfers: TransferService;
const keysSeen: string[] = [];

/** The vendor as a script: each load id answers with the statuses listed, the last one repeating. */
class ScriptedVendor implements FundingPort {
  readonly byKey = new Map<string, Load>();
  readonly script = new Map<string, Load['status'][]>();
  constructor(private readonly first: Load['status'] = 'processing') {}
  async createLoad(input: Parameters<FundingPort['createLoad']>[0], key: string): Promise<Load> {
    keysSeen.push(key);
    if (input.paymentMethodId === 'pm_outage') throw new FundingError('PROVIDER_UNAVAILABLE', 'down');
    const found = this.byKey.get(key);
    if (found) return { ...found };
    const l: Load = { loadId: `sv_${this.byKey.size + 1}`, method: input.method, amount: input.amount, status: this.first };
    this.byKey.set(key, l);
    return { ...l };
  }
  async getLoad(loadId: string): Promise<Load> {
    const l = [...this.byKey.values()].find((x) => x.loadId === loadId);
    if (!l) throw new FundingError('UNKNOWN_LOAD', loadId);
    const steps = this.script.get(loadId) ?? [];
    const status = steps.length > 1 ? steps.shift()! : (steps[0] ?? l.status);
    return { ...l, status, ...(status === 'failed' ? { failureCode: 'CARD_EXPIRED' } : {}) };
  }
  async parseWebhook(): Promise<{ eventId: string; load: Load }> {
    throw new FundingError('BAD_SIGNATURE', 'not used here');
  }
}

function service(port: FundingPort, provider: string): LoadService {
  const ledger = new PostgresLedger(db);
  const plans = new PlanService(db);
  return new LoadService({ db, port, ledger, accounts, transfers, memberships: new MembershipService(db, plans, new BillingSimulator()), flags: new StaticFlags(undefined, { 'wallet.enabled': true }), provider });
}

const input = (party: string, amountMinor = 10_000n, extra: Partial<LoadInput> = {}): LoadInput => ({ payerPartyId: party, memberPartyId: party, method: 'apple_pay', amount: money(amountMinor, 'USD'), ...extra });
const available = async (party: string) => (await accounts.purses(party)).find((p) => p.currency === 'USD')!.available.minor;
const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey(key)])).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase();
  const ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  transfers = new TransferService(db);
}, 60_000);
afterAll(async () => db.close());

describe('the run (TST-WAL-002)', () => {
  it('settles a $100 Apple Pay load with one journal, the vendor pull keyed by the workflow id; every rerun is a replay', async () => {
    const sim = new FundingSimulator(fixedClock(NOW.toISOString()));
    const recording: FundingPort = { createLoad: (i, k) => (keysSeen.push(k), sim.createLoad(i, k)), getLoad: (id) => sim.getLoad(id), parseWebhook: (h, b) => sim.parseWebhook(h, b) };
    const wf = new LoadWorkflow(service(recording, 'simulator'), recording, clock);
    const party = uuidv7(NOW);
    const key = `load-${party}`;

    const r = await wf.run(input(party, 10_000n, { paymentMethodId: 'pm_ok' }), key);
    expect(r).toMatchObject({ workflowId: key, replayed: false, transfer: { idempotencyKey: key, kind: 'load', state: 'settled', toPartyId: party } });
    expect(r.awaiting).toBeUndefined();
    expect(r.clientSecret).toBeUndefined();
    expect(keysSeen.filter((k) => k === key)).toEqual([key]);
    expect(await available(party)).toBe(10_000n);
    expect(await journals(key)).toBe(1);
    const posted = (await db.query<{ type: string; amount_minor: string }>(`select a.type::text as type, p.amount_minor::text from ledger.posting p join ledger.account a on a.id = p.account_id join ledger.journal j on j.id = p.journal_id where j.idempotency_key = $1 order by a.type::text`, [settleKey(key)])).rows;
    expect(posted).toEqual([
      { type: 'partner_settlement', amount_minor: '10000' },
      { type: 'wallet', amount_minor: '-10000' },
    ]);

    for (let i = 0; i < 3; i += 1) {
      const again = await wf.run(input(party, 10_000n, { paymentMethodId: 'pm_ok' }), key);
      expect(again).toMatchObject({ replayed: true, transfer: { id: r.transfer.id, state: 'settled' } });
    }
    expect(keysSeen.filter((k) => k === key)).toEqual([key]);
    expect(await available(party)).toBe(10_000n);
    expect(await journals(key)).toBe(1);
    expect((await transfers.history(r.transfer.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'settled']);
  });

  it('a decline fails the transfer once with the vendor code; an outage leaves it submitted and the next run with the same key finishes', async () => {
    const sim = new FundingSimulator(fixedClock(NOW.toISOString()));
    const wf = new LoadWorkflow(service(sim, 'simulator'), sim, clock);
    const party = uuidv7(NOW);

    const declined = await wf.run(input(party, 2_500n, { paymentMethodId: 'pm_declined' }), `decl-${party}`);
    expect(declined.transfer).toMatchObject({ state: 'failed', failureCode: 'DECLINED' });
    expect(await wf.run(input(party, 2_500n, { paymentMethodId: 'pm_declined' }), `decl-${party}`)).toMatchObject({ replayed: true, transfer: { state: 'failed' } });
    expect((await transfers.history(declined.transfer.id)).filter((e) => e.to === 'failed')).toHaveLength(1);
    expect(await available(party)).toBe(0n);

    const key = `out-${party}`;
    await expect(wf.run(input(party, 4_000n, { paymentMethodId: 'pm_outage' }), key)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const stuck = (await transfers.byKey(key))!;
    expect(stuck.state).toBe('submitted');
    const done = await wf.run(input(party, 4_000n, { paymentMethodId: 'pm_ok' }), key);
    expect(done).toMatchObject({ replayed: true, transfer: { id: stuck.id, state: 'settled' } });
    expect(await available(party)).toBe(4_000n);
    expect((await transfers.history(stuck.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'settled']);
  });

  it('an ACH load the vendor holds goes to pending_hold with the release date and the money in pending; a rerun leaves it there', async () => {
    const sim = new FundingSimulator(fixedClock(NOW.toISOString()));
    const wf = new LoadWorkflow(service(sim, 'simulator'), sim, clock);
    const party = uuidv7(NOW);
    const r = await wf.run(input(party, 9_000n, { method: 'ach' }), `ach-${party}`);
    expect(r.transfer).toMatchObject({ state: 'pending_hold', holdReleasesAt: '2026-11-04T09:00:00.000Z' });
    expect(await wf.run(input(party, 9_000n, { method: 'ach' }), `ach-${party}`)).toMatchObject({ replayed: true, transfer: { state: 'pending_hold' } });
    expect(await available(party)).toBe(0n);
    // The hold is in the member's pending purse (REQ-WAL-003); the release job (release-holds.ts) moves it on the date.
    expect((await accounts.purses(party)).find((p) => p.currency === 'USD')!.holds.minor).toBe(9_000n);
    expect(await journals(`ach-${party}`)).toBe(0);
  });
});

describe('the sweep', () => {
  it('asks the vendor about loads submitted past the stale window and applies the answer once; younger or unresolved ones wait', async () => {
    const vendor = new ScriptedVendor('processing');
    const wf = new LoadWorkflow(service(vendor, 'scripted'), vendor, clock);
    const a = uuidv7(NOW);
    const b = uuidv7(NOW);
    const c = uuidv7(NOW);
    const d = uuidv7(NOW);
    now = NOW;
    const ra = await wf.run(input(a, 1_000n), `sw-a-${a}`);
    const rb = await wf.run(input(b, 2_000n), `sw-b-${b}`);
    const rc = await wf.run(input(c, 3_000n), `sw-c-${c}`);
    await expect(wf.run(input(d, 4_000n, { paymentMethodId: 'pm_outage' }), `sw-d-${d}`)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    for (const r of [ra, rb, rc]) expect(r).toMatchObject({ awaiting: 'vendor', transfer: { state: 'submitted' } });
    vendor.script.set('sv_1', ['succeeded']);
    vendor.script.set('sv_2', ['failed']);
    vendor.script.set('sv_3', ['processing', 'succeeded']);

    // Too young: nothing is asked.
    now = new Date(NOW.getTime() + STALE_AFTER_MS - 1);
    expect(await wf.sweep()).toMatchObject({ attempted: 0 });

    now = new Date(NOW.getTime() + STALE_AFTER_MS + 1);
    const first = await wf.sweep();
    expect(first).toMatchObject({ attempted: 4, settled: 1, failed: 1, open: 2, held: 0, errors: [] });
    expect(await transfers.get(ra.transfer.id)).toMatchObject({ state: 'settled' });
    expect(await transfers.get(rb.transfer.id)).toMatchObject({ state: 'failed', failureCode: 'CARD_EXPIRED' });
    expect(await transfers.get(rc.transfer.id)).toMatchObject({ state: 'submitted' });
    expect(await available(a)).toBe(1_000n);
    expect(await available(b)).toBe(0n);

    // The next cycle: c is now confirmed; d, which the vendor never heard of, stays for the member's rerun.
    now = new Date(now.getTime() + 60_000);
    const second = await wf.sweep();
    expect(second).toMatchObject({ attempted: 2, settled: 1, open: 1, errors: [] });
    expect(await transfers.get(rc.transfer.id)).toMatchObject({ state: 'settled' });
    expect(await available(c)).toBe(3_000n);
    expect(await journals(`sw-a-${a}`)).toBe(1);
    expect(await journals(`sw-c-${c}`)).toBe(1);
    expect((await transfers.byKey(`sw-d-${d}`))!.state).toBe('submitted');

    // Settled and failed loads are out of the sweep's reach; a third pass finds only d.
    now = new Date(now.getTime() + 60_000);
    expect(await wf.sweep()).toMatchObject({ attempted: 1, open: 1 });
    expect(await wf.run(input(d, 4_000n), `sw-d-${d}`)).toMatchObject({ replayed: true, awaiting: 'vendor' });
  });

  it('a vendor error on one load is reported and does not stop the others', async () => {
    const vendor = new ScriptedVendor('processing');
    const wf = new LoadWorkflow(service(vendor, 'scripted-2'), vendor, clock);
    const a = uuidv7(NOW);
    const b = uuidv7(NOW);
    now = new Date(NOW.getTime() + 3 * STALE_AFTER_MS);
    const start = now;
    const ra = await wf.run(input(a, 500n), `err-a-${a}`);
    const rb = await wf.run(input(b, 600n), `err-b-${b}`);
    vendor.getLoad = async (id) => {
      if (id === 'sv_1') throw new FundingError('PROVIDER_UNAVAILABLE', 'flaky');
      return { loadId: id, method: 'apple_pay', amount: money(600n, 'USD'), status: 'succeeded' };
    };
    now = new Date(start.getTime() + STALE_AFTER_MS + 1);
    const report = await wf.sweep(); // the previous test's unresolved load is still waiting, and counted open
    expect(report).toMatchObject({ attempted: 3, settled: 1, failed: 0, open: 1, errors: [{ transferId: ra.transfer.id, error: 'flaky' }] });
    expect(await transfers.get(rb.transfer.id)).toMatchObject({ state: 'settled' });
    expect(await transfers.get(ra.transfer.id)).toMatchObject({ state: 'submitted' });
  });
});
