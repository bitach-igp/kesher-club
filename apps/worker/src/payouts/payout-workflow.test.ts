// PayoutWorkflow (T-0510, REQ-PO-001/002): the sweep resumes a payout whose 24 h cooling-off ended, or
// whose second approval landed, exactly once; what is still waiting stays; reruns are replays.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { fixedClock, NotifySimulator, PayoutError, PayoutSimulator, type AdvanceableClock, type PayoutPort } from '@kesher/ports';
import { ApprovalService } from '@kesher/api/approvals/service';
import { AuditService } from '@kesher/api/audit/service';
import { InstitutionKyb } from '@kesher/api/institutions/kyb';
import { KybGate } from '@kesher/api/institutions/kyb-gate';
import { PayoutAccounts } from '@kesher/api/institutions/payout-account';
import { InMemoryIdentityRepository } from '@kesher/api/auth/repository';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { COOL_OFF_MS, PayoutService, settleKey } from '@kesher/api/payouts/service';
import { TransferService } from '@kesher/api/transfers/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { PayoutWorkflow } from './payout-workflow.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-10T09:00:00Z');
const clock = fixedClock(NOW.toISOString()) as AdvanceableClock;
let accounts: AccountService;
let ledger: PostgresLedger;
let transfers: TransferService;
let approvals: ApprovalService;
let payouts: PayoutService;
let wf: PayoutWorkflow;
const identity = new InMemoryIdentityRepository();
const IL = 'IL620108000000099999999';

async function member(phone: string, minor: bigint): Promise<string> {
  const partyId = uuidv7(NOW);
  await identity.createUser({ partyId, phone, status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
  const wallet = await accounts.memberAccount(partyId, 'wallet', 'ILS');
  const partner = await accounts.systemAccount('partner_settlement', 'ILS');
  await ledger.post({ idempotencyKey: `credit-${partyId}`, kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: minor }, { accountId: wallet, currency: 'ILS', amountMinor: -minor }] });
  return partyId;
}
const available = async (partyId: string) => (await accounts.purses(partyId)).find((p) => p.currency === 'ILS')!.available.minor;
const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  transfers = new TransferService(db);
  approvals = new ApprovalService(db);
  payouts = new PayoutService({ db, port: new PayoutSimulator(clock), ledger, accounts, transfers, approvals, identity, notify: new NotifySimulator(), flags: new StaticFlags(undefined, { 'payouts.nium': true }), provider: 'simulator', kyb: new KybGate(new InstitutionKyb(db, approvals, new AuditService(db))), payoutAccounts: new PayoutAccounts(db, new AuditService(db)) });
  wf = new PayoutWorkflow(payouts, () => clock.now());
}, 60_000);
afterAll(async () => db.close());

describe('the sweep', () => {
  it('submits a payout once its cooling-off ends and once its approval lands; leaves the rest; every rerun is a replay', async () => {
    const a = await member('+972508000001', 2_000_000n);
    const cool = await payouts.request(a, { payee: { iban: IL, name: 'Yeshivat Example' }, amount: { minor: '300000', currency: 'ILS' }, reference: 'tuition' }, `po-cool-${a}`, clock.now());
    const big = await payouts.request(a, { payee: { iban: IL, name: 'Yeshivat Example' }, amount: { minor: '700000', currency: 'ILS' }, reference: 'building' }, `po-big-${a}`, clock.now());
    const small = await payouts.request(a, { payee: { iban: IL, name: 'Yeshivat Example' }, amount: { minor: '50000', currency: 'ILS' }, reference: 'books' }, `po-small-${a}`, clock.now());
    expect(cool.state).toBe('cooling_off');
    expect(big.state).toBe('cooling_off'); // new payee and over the threshold: the cooling-off comes first, the approval after
    expect(small.state).toBe('processing');
    // T-0540: the 300,000 in cool-off and the 700,000 that will wait for an approver are reserved; only the 50,000 left the wallet for the rail.
    expect(await available(a)).toBe(950_000n);

    expect(await wf.sweep()).toMatchObject({ attempted: 0 });
    clock.advance(COOL_OFF_MS);
    const first = await wf.sweep();
    expect(first).toMatchObject({ attempted: 2, submitted: 1, stillWaiting: 1, errors: [] });
    expect((await transfers.get(cool.id))!).toMatchObject({ state: 'pending', journalId: expect.any(String) }); // past the hold and at the rail
    expect((await payouts.view((await transfers.get(cool.id))!)).state).toBe('processing');
    expect((await transfers.get(big.id))!.state).toBe('pending'); // released from the hold, waiting on the second approver
    expect((await transfers.get(big.id))!.journalId).toBeUndefined();
    expect((await payouts.view((await transfers.get(big.id))!)).state).toBe('awaiting_second_approval');
    expect(await available(a)).toBe(950_000n); // unchanged by the cool-off ending: it was reserved from the start
    expect(await journals(settleKey(`po-cool-${a}`))).toBe(1);
    expect(await journals(settleKey(`po-big-${a}`))).toBe(0);

    // Nothing to do until finance approves; then the big one goes.
    expect(await wf.sweep()).toMatchObject({ attempted: 0 });
    const req = (await approvals.find('payout', big.id))!;
    await approvals.decide(req.id, { partyId: uuidv7(NOW), role: 'finance' }, 'approve', clock.now(), 'ok');
    const second = await wf.sweep();
    expect(second).toMatchObject({ attempted: 1, submitted: 1, stillWaiting: 0, errors: [] });
    expect((await transfers.get(big.id))!).toMatchObject({ state: 'pending', journalId: expect.any(String) });
    expect(await available(a)).toBe(950_000n);
    expect(await journals(settleKey(`po-big-${a}`))).toBe(1);
    for (let i = 0; i < 3; i += 1) expect(await wf.sweep()).toMatchObject({ attempted: 0 });
    expect(await wf.run(await payouts.inputFor((await transfers.get(big.id))!), `po-big-${a}`)).toMatchObject({ replayed: true, transfer: { state: 'pending' } });
    expect(await journals(settleKey(`po-big-${a}`))).toBe(1);
  });

  it('a failing resume is reported and does not stop the others', async () => {
    const a = await member('+972508000002', 1_000_000n);
    const b = await member('+972508000003', 1_000_000n);
    const pa = await payouts.request(a, { payee: { iban: IL, name: 'Yeshivat Example' }, amount: { minor: '300000', currency: 'ILS' }, reference: 'a' }, `po-a-${a}`, clock.now());
    const pb = await payouts.request(b, { payee: { iban: IL, name: 'Yeshivat Example' }, amount: { minor: '300000', currency: 'ILS' }, reference: 'b' }, `po-b-${b}`, clock.now());
    const original = payouts.submit.bind(payouts);
    let once = true;
    payouts.submit = async (t, i, w, n) => {
      if (t.id === pa.id && once) {
        once = false;
        throw new Error('rail unreachable');
      }
      return original(t, i, w, n);
    };
    clock.advance(COOL_OFF_MS);
    const r = await wf.sweep();
    expect(r).toMatchObject({ attempted: 2, submitted: 1, errors: [{ transferId: pa.id, error: 'rail unreachable' }] });
    expect((await transfers.get(pb.id))!).toMatchObject({ state: 'pending', journalId: expect.any(String) });
    expect((await transfers.get(pa.id))!.journalId).toBeUndefined();
    const again = await wf.sweep();
    expect(again.errors).toEqual([]);
    expect((await transfers.get(pa.id))!).toMatchObject({ state: 'pending', journalId: expect.any(String) });
    payouts.submit = original;
  });
});

describe('T-0541: a payout hit by a rail outage is retried, not stranded (F10)', () => {
  let db2: TestDatabase;
  let sim: PayoutSimulator;
  let wf2: PayoutWorkflow;
  let p2: PayoutService;
  let t2: TransferService;
  let l2: PostgresLedger;
  let a2: AccountService;
  const rail = { down: false, calls: 0, acceptThenTimeout: false };
  const T = new Date('2026-11-12T09:00:00Z');
  const c2 = fixedClock(T.toISOString()) as AdvanceableClock;
  const vendorRef = async (id: string) => (await db2.query<{ n: number }>(`select count(*)::int as n from ops.external_ref where entity_type = 'transfer' and entity_id = $1 and provider = 'simulator'`, [id])).rows[0]!.n;
  const jr = async (key: string) => (await db2.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.n;
  async function funded(minor: bigint): Promise<string> {
    const partyId = uuidv7(T);
    await identity.createUser({ partyId, phone: `+97250900${Math.floor(Math.random() * 9000 + 1000)}`, status: 'active', roles: ['member'], createdAt: T.toISOString() });
    const wallet = await a2.memberAccount(partyId, 'wallet', 'ILS');
    const partner = await a2.systemAccount('partner_settlement', 'ILS');
    await l2.post({ idempotencyKey: `credit-${partyId}`, kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: minor }, { accountId: wallet, currency: 'ILS', amountMinor: -minor }] });
    return partyId;
  }
  const ask = (party: string, key: string, minor: bigint) => p2.request(party, { payee: { iban: IL, name: 'Yeshivat Example' }, amount: { minor: minor.toString(), currency: 'ILS' }, reference: 'tuition' }, key, c2.now());
  const avail = async (party: string) => (await a2.purses(party)).find((p) => p.currency === 'ILS')!.available.minor;

  beforeAll(async () => {
    db2 = await createTestDatabase();
    sim = new PayoutSimulator(c2);
    const port: PayoutPort = {
      validatePayee: (x) => sim.validatePayee(x),
      createPayout: async (x, k) => {
        rail.calls += 1;
        if (rail.down) throw new PayoutError('PROVIDER_UNAVAILABLE', 'rail down');
        // The vendor takes the payout and our answer is lost (a timeout after acceptance): it will hand the same payout back for the same key.
        if (rail.acceptThenTimeout) {
          rail.acceptThenTimeout = false;
          await sim.createPayout(x, k);
          throw new PayoutError('PROVIDER_UNAVAILABLE', 'timeout after the vendor accepted');
        }
        return sim.createPayout(x, k);
      },
      getPayout: (x) => sim.getPayout(x),
      parseWebhook: (h, b) => sim.parseWebhook(h, b),
    };
    l2 = new PostgresLedger(db2);
    a2 = new AccountService(db2, l2);
    t2 = new TransferService(db2);
    const ap = new ApprovalService(db2);
    p2 = new PayoutService({ db: db2, port, ledger: l2, accounts: a2, transfers: t2, approvals: ap, identity, notify: new NotifySimulator(), flags: new StaticFlags(undefined, { 'payouts.nium': true }), provider: 'simulator', kyb: new KybGate(new InstitutionKyb(db2, ap, new AuditService(db2))), payoutAccounts: new PayoutAccounts(db2, new AuditService(db2)) });
    wf2 = new PayoutWorkflow(p2, () => c2.now());
  }, 60_000);
  afterAll(async () => db2.close());

  it('outage then recovery: the sweep retries with the same key and exactly one vendor payout is made', async () => {
    const a = await funded(100_000n);
    const key = `po-out-${a}`;
    rail.down = true;
    await expect(ask(a, key, 50_000n)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const t = (await t2.byKey(key))!;
    expect(t.state).toBe('submitted');
    expect(await vendorRef(t.id)).toBe(0);
    expect(await jr(settleKey(key))).toBe(1);
    // Too young for the sweep.
    expect(await wf2.sweep()).toMatchObject({ attempted: 0 });
    c2.advance(6 * 60_000);
    // Still down: the sweep tries, it fails quietly (reported), nothing doubles.
    const down = await wf2.sweep();
    expect(down.attempted).toBe(1);
    expect(down.errors).toHaveLength(1);
    expect((await t2.get(t.id))!.state).toBe('submitted');
    expect(await jr(settleKey(key))).toBe(1);
    // The rail is back: the next sweep sends it once.
    rail.down = false;
    const callsBefore = rail.calls;
    const ok = await wf2.sweep();
    expect(ok).toMatchObject({ attempted: 1, errors: [] });
    expect(rail.calls - callsBefore).toBe(1);
    expect(await vendorRef(t.id)).toBe(1);
    expect(await jr(settleKey(key))).toBe(1);
    expect(await avail(a)).toBe(50_000n);
    // Nothing more to do; a client replay of the request changes nothing.
    expect(await wf2.sweep()).toMatchObject({ attempted: 0 });
    await ask(a, key, 50_000n);
    expect(rail.calls - callsBefore).toBe(1);
  });

  it('a persistent outage fails the payout after 30 minutes and reverses it once; the member is told and ops get a case', async () => {
    const a = await funded(100_000n);
    const key = `po-dead-${a}`;
    rail.down = true;
    await expect(ask(a, key, 40_000n)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const t = (await t2.byKey(key))!;
    expect(await avail(a)).toBe(60_000n);
    c2.advance(10 * 60_000);
    expect((await wf2.sweep()).attempted).toBe(1);
    expect((await t2.get(t.id))!.state).toBe('submitted'); // ten minutes in: still retrying
    c2.advance(25 * 60_000);
    await wf2.sweep();
    expect(await t2.get(t.id)).toMatchObject({ state: 'failed', failureCode: 'PROVIDER_UNAVAILABLE' });
    expect(await avail(a)).toBe(100_000n);
    expect(await jr(`${settleKey(key)}:reversal`)).toBe(1);
    expect((await db2.query<{ n: number }>(`select count(*)::int as n from ops.case where kind = 'payout_stranded' and payload->>'transferId' = $1`, [t.id])).rows[0]!.n).toBe(1);
    // Failed once: further sweeps and the recovery of the rail change nothing.
    rail.down = false;
    expect(await wf2.sweep()).toMatchObject({ attempted: 0 });
    expect(await avail(a)).toBe(100_000n);
    expect(await jr(`${settleKey(key)}:reversal`)).toBe(1);
  });

  it('a payout under the approval threshold that cooled off is resumed by the sweep (no approver is needed)', async () => {
    rail.down = false;
    const a = await funded(500_000n);
    const key = `po-cool-${a}`;
    expect((await ask(a, key, 300_000n)).state).toBe('cooling_off');
    c2.advance(COOL_OFF_MS);
    expect(await wf2.sweep()).toMatchObject({ attempted: 1, submitted: 1, errors: [] });
    expect((await t2.byKey(key))!).toMatchObject({ state: 'pending', journalId: expect.any(String) });
    expect(await vendorRef((await t2.byKey(key))!.id)).toBe(1);
  });

  it('the vendor took the payout but its answer was lost: thirty-one minutes on, the retry gets the same payout back and nothing is refunded', async () => {
    const a = await funded(100_000n);
    const key = `po-lost-${a}`;
    rail.down = false;
    rail.acceptThenTimeout = true;
    await expect(ask(a, key, 30_000n)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const t = (await t2.byKey(key))!;
    expect(t.state).toBe('submitted');
    expect(await vendorRef(t.id)).toBe(0);
    expect(await avail(a)).toBe(70_000n);
    c2.advance(31 * 60_000);
    // Past the thirty minutes, the vendor is asked once more first; it answers, so the payout is not given up on.
    expect(await wf2.sweep()).toMatchObject({ attempted: 1, errors: [] });
    expect(await vendorRef(t.id)).toBe(1);
    expect((await t2.get(t.id))!.state).toBe('submitted');
    expect(await jr(`${settleKey(key)}:reversal`)).toBe(0);
    expect(await avail(a)).toBe(70_000n);
    expect((await db2.query<{ n: number }>(`select count(*)::int as n from ops.case where kind = 'payout_stranded' and payload->>'transferId' = $1`, [t.id])).rows[0]!.n).toBe(0);
  });

  it('a payout that cooled off and then met a persistent outage is failed and reversed too, measured from its first attempt (not from the cool-off)', async () => {
    const a = await funded(500_000n);
    const key = `po-cooldead-${a}`;
    rail.down = false;
    expect((await ask(a, key, 300_000n)).state).toBe('cooling_off');
    expect(await avail(a)).toBe(200_000n); // reserved while it cools off
    c2.advance(COOL_OFF_MS);
    rail.down = true;
    // First attempt after the cool-off: the outage. Despite the day it waited, it is not given up on yet.
    const first = await wf2.sweep();
    expect(first.errors).toHaveLength(1);
    const t = (await t2.byKey(key))!;
    expect(t.state).toBe('pending');
    expect(t.journalId).toBeUndefined();
    expect(await jr(settleKey(key))).toBe(1);
    c2.advance(35 * 60_000);
    await wf2.sweep();
    expect(await t2.get(t.id)).toMatchObject({ state: 'failed', failureCode: 'PROVIDER_UNAVAILABLE' });
    expect(await avail(a)).toBe(500_000n);
    expect(await jr(`${settleKey(key)}:reversal`)).toBe(1);
    expect(await jr(`${key}:unreserve`)).toBe(1);
    rail.down = false;
    expect(await wf2.sweep()).toMatchObject({ attempted: 0 });
    expect(await avail(a)).toBe(500_000n);
  });
});

