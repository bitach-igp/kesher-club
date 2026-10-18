// SendWorkflow (T-0505, REQ-PAY-001/005): one run per key with one transfer and one journal however
// often it runs; a run that dies between the journal and the settle, or before the recipient is told,
// is finished by the sweep with the same keys, so the member is never charged twice and told once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, KycSimulator, NotifySimulator, fixedClock } from '@kesher/ports';
import { InMemoryIdentityRepository } from '@kesher/api/auth/repository';
import { EntitlementService } from '@kesher/api/billing/entitlements';
import { MembershipService } from '@kesher/api/billing/memberships';
import { PlanService } from '@kesher/api/billing/plans';
import { KycService } from '@kesher/api/kyc/service';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { P2pHoldService } from '@kesher/api/p2p/holds';
import { P2pLimitService } from '@kesher/api/p2p/limits';
import { P2pSendService, settleKey, type SendActivities, type SendInput } from '@kesher/api/p2p/send';
import { TransferService } from '@kesher/api/transfers/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { SendWorkflow, STALE_AFTER_MS } from './send-workflow.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;
let accounts: AccountService;
let transfers: TransferService;
let ledger: PostgresLedger;
let send: P2pSendService;
let notify: NotifySimulator;
const identity = new InMemoryIdentityRepository();

async function member(phone: string): Promise<string> {
  const partyId = uuidv7(NOW);
  await identity.createUser({ partyId, phone, status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
  return partyId;
}
const credit = async (partyId: string, minor: bigint) => {
  const wallet = await accounts.memberAccount(partyId, 'wallet', 'ILS');
  const partner = await accounts.systemAccount('partner_settlement', 'ILS');
  await ledger.post({ idempotencyKey: `credit-${partyId}-${minor}`, kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: minor }, { accountId: wallet, currency: 'ILS', amountMinor: -minor }] });
};
const available = async (partyId: string) => (await accounts.purses(partyId)).find((p) => p.currency === 'ILS')!.available.minor;
const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [settleKey(key)])).rows[0]!.n;
const input = (from: string, to: string, minor: bigint): SendInput => ({ fromPartyId: from, toPartyId: to, amount: money(minor, 'ILS') });

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  transfers = new TransferService(db);
  const plans = new PlanService(db);
  const memberships = new MembershipService(db, plans, new BillingSimulator());
  notify = new NotifySimulator();
  send = new P2pSendService({ db, ledger, accounts, transfers, limits: new P2pLimitService(db, memberships, new EntitlementService(db, plans), plans), holds: new P2pHoldService(db, ledger, accounts, transfers), kyc: new KycService(db, new KycSimulator(fixedClock(NOW.toISOString())), 'IL'), identity, notify });
}, 60_000);
afterAll(async () => db.close());

describe('the run (TST-PAY-001, TST-PAY-005)', () => {
  it('moves the money once, tells the recipient once, and every rerun is a replay', async () => {
    const wf = new SendWorkflow(send, () => now);
    const a = await member('+972501100001');
    const b = await member('+972501100002');
    await credit(a, 20_000n);
    const key = `send-${a}`;
    const r = await wf.run(input(a, b, 5_000n), key);
    expect(r).toMatchObject({ workflowId: key, replayed: false, notified: true, transfer: { state: 'settled', fromPartyId: a, toPartyId: b } });
    expect(await available(a)).toBe(15_000n);
    expect(await available(b)).toBe(5_000n);
    expect(await journals(key)).toBe(1);
    expect(notify.sent.filter((n) => n.data['transferId'] === r.transfer.id)).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) expect(await wf.run(input(a, b, 5_000n), key)).toMatchObject({ replayed: true, notified: false, transfer: { id: r.transfer.id, state: 'settled' } });
    expect(await available(a)).toBe(15_000n);
    expect(await journals(key)).toBe(1);
    expect(notify.sent.filter((n) => n.data['transferId'] === r.transfer.id)).toHaveLength(1);
  });

  it('a run that dies after the journal is finished by the sweep with the same journal and one notification', async () => {
    const a = await member('+972501100003');
    const b = await member('+972501100004');
    await credit(a, 10_000n);
    const key = `send-dies-${a}`;
    // The activities, with the settle step dying once.
    let die = true;
    const flaky: SendActivities = {
      begin: (i, w, n) => send.begin(i, w, n),
      submit: (t, n) => send.submit(t, n),
      post: (t, w, n) => send.post(t, w, n),
      settle: async (t, j, n) => {
        if (die) {
          die = false;
          throw new Error('process died');
        }
        return send.settle(t, j, n);
      },
      recordUsage: (t, w, n) => send.recordUsage(t, w, n),
      notify: (t, w, n) => send.notify(t, w, n),
      shouldHold: (t) => send.shouldHold(t),
      hold: (t, w, n) => send.hold(t, w, n),
      release: (t, w, n) => send.release(t, w, n),
    };
    const { runSend } = await import('@kesher/api/p2p/send');
    await expect(runSend(flaky, input(a, b, 4_000n), key, now)).rejects.toThrow('process died');
    const stuck = (await transfers.byKey(key))!;
    expect(stuck.state).toBe('submitted');
    expect(await journals(key)).toBe(1); // the money moved
    expect(await available(b)).toBe(4_000n);
    expect(notify.sent.filter((n) => n.data['transferId'] === stuck.id)).toHaveLength(0);

    const wf = new SendWorkflow(send, () => now);
    expect(await wf.sweep()).toMatchObject({ attempted: 0 }); // too young
    now = new Date(NOW.getTime() + STALE_AFTER_MS + 1);
    const report = await wf.sweep();
    expect(report).toMatchObject({ attempted: 1, settled: 1, errors: [] });
    expect(await transfers.get(stuck.id)).toMatchObject({ state: 'settled' });
    expect(await journals(key)).toBe(1);
    expect(await available(a)).toBe(6_000n);
    expect(await available(b)).toBe(4_000n);
    expect(notify.sent.filter((n) => n.data['transferId'] === stuck.id)).toHaveLength(1);
    expect((await transfers.history(stuck.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'settled']);
    now = new Date(now.getTime() + 60_000);
    expect(await wf.sweep()).toMatchObject({ attempted: 0 });
  });
});
