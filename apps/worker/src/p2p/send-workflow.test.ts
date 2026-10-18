// SendWorkflow (T-0505, REQ-PAY-001/005): one run per key with one transfer and one journal however
// often it runs; a run that dies between the journal and the settle, or before the recipient is told,
// is finished by the sweep with the same keys, so the member is never charged twice and told once. A send
// received in the other currency (T-0515, REQ-PAY-006) is priced once, when it begins, and the sweep moves
// that amount even after the rate has changed or run out.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, KycSimulator, NotifySimulator, fixedClock } from '@kesher/ports';
import { InMemoryIdentityRepository } from '@kesher/api/auth/repository';
import { ApprovalService } from '@kesher/api/approvals/service';
import { AuditService } from '@kesher/api/audit/service';
import { DEFAULT_FX_MARKUP_BPS } from '@kesher/api/billing/plans';
import { RateService } from '@kesher/api/fx/rates';
import { PreferenceService } from '@kesher/api/me/preferences';
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
let rates: RateService;
let preferences: PreferenceService;
const identity = new InMemoryIdentityRepository();

async function member(phone: string): Promise<string> {
  const partyId = uuidv7(NOW);
  await identity.createUser({ partyId, phone, status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
  return partyId;
}
const credit = async (partyId: string, minor: bigint, currency: 'ILS' | 'USD' = 'ILS') => {
  const wallet = await accounts.memberAccount(partyId, 'wallet', currency);
  const partner = await accounts.systemAccount('partner_settlement', currency);
  await ledger.post({ idempotencyKey: `credit-${partyId}-${currency}-${minor}`, kind: 'load', postings: [{ accountId: partner, currency, amountMinor: minor }, { accountId: wallet, currency, amountMinor: -minor }] });
};
const available = async (partyId: string, currency: 'ILS' | 'USD' = 'ILS') => (await accounts.purses(partyId)).find((p) => p.currency === currency)!.available.minor;
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
  rates = new RateService(db, new ApprovalService(db), new AuditService(db));
  preferences = new PreferenceService(db);
  send = new P2pSendService({ db, ledger, accounts, transfers, limits: new P2pLimitService(db, memberships, new EntitlementService(db, plans), plans), holds: new P2pHoldService(db, ledger, accounts, transfers), kyc: new KycService(db, new KycSimulator(fixedClock(NOW.toISOString())), 'IL'), identity, notify, preferences, rates, markups: { markupFor: async () => DEFAULT_FX_MARKUP_BPS } });
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

describe('a converted run (TST-PAY-006)', () => {
  it('is priced once when it begins; a run that dies after the journal is finished by the sweep at that price after the rate has run out', async () => {
    now = NOW;
    await rates.publishFromPort('USD/ILS', 3_700_000n, now);
    const a = await member('+972501100005');
    const b = await member('+972501100006');
    await credit(a, 20_000n, 'USD');
    await preferences.set(b, 'ILS', now);
    const key = `send-xccy-${a}`;
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
    // $100 → ₪370.00 at 3.70 less 75 bps → ₪367.22, fixed on the transfer before the journal.
    await expect(runSend(flaky, { fromPartyId: a, toPartyId: b, amount: money(10_000n, 'USD') }, key, now)).rejects.toThrow('process died');
    const stuck = (await transfers.byKey(key))!;
    expect(stuck).toMatchObject({ state: 'submitted', conversion: { received: money(36_722n, 'ILS'), rateVersion: 1, rateScaled: 3_700_000n, markupBps: 75n } });
    expect(await journals(key)).toBe(1);
    expect(await available(b, 'ILS')).toBe(36_722n);

    // The rate changes and then runs out; the sweep finishes the run with the same journal and the price it began at.
    await rates.publishFromPort('USD/ILS', 3_900_000n, new Date(NOW.getTime() + 30_000));
    now = new Date(NOW.getTime() + 20 * 60_000);
    await expect(rates.rateFor('USD', 'ILS', now)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const wf = new SendWorkflow(send, () => now);
    expect(await wf.sweep()).toMatchObject({ attempted: 1, settled: 1, errors: [] });
    expect(await transfers.get(stuck.id)).toMatchObject({ state: 'settled', conversion: { received: money(36_722n, 'ILS'), rateVersion: 1 } });
    expect(await journals(key)).toBe(1);
    expect(await available(a, 'USD')).toBe(10_000n);
    expect(await available(b, 'ILS')).toBe(36_722n);
    expect(notify.sent.filter((n) => n.data['transferId'] === stuck.id)).toEqual([expect.objectContaining({ data: { amount: '36722', currency: 'ILS', transferId: stuck.id } })]);
    // A fresh converted send with no valid rate is refused before anything is created.
    await expect(runSend(send, { fromPartyId: a, toPartyId: b, amount: money(1_000n, 'USD') }, `${key}-stale`, now)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await transfers.byKey(`${key}-stale`)).toBeUndefined();
  });
});
