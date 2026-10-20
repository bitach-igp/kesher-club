// PayoutWorkflow (T-0510, REQ-PO-001/002): the sweep resumes a payout whose 24 h cooling-off ended, or
// whose second approval landed, exactly once; what is still waiting stays; reruns are replays.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { fixedClock, NotifySimulator, PayoutSimulator, type AdvanceableClock } from '@kesher/ports';
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
    expect(await available(a)).toBe(1_950_000n);

    expect(await wf.sweep()).toMatchObject({ attempted: 0 });
    clock.advance(COOL_OFF_MS);
    const first = await wf.sweep();
    expect(first).toMatchObject({ attempted: 2, submitted: 1, stillWaiting: 1, errors: [] });
    expect((await transfers.get(cool.id))!).toMatchObject({ state: 'pending', journalId: expect.any(String) }); // past the hold and at the rail
    expect((await payouts.view((await transfers.get(cool.id))!)).state).toBe('processing');
    expect((await transfers.get(big.id))!.state).toBe('pending'); // released from the hold, waiting on the second approver
    expect((await transfers.get(big.id))!.journalId).toBeUndefined();
    expect((await payouts.view((await transfers.get(big.id))!)).state).toBe('awaiting_second_approval');
    expect(await available(a)).toBe(1_650_000n);
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
