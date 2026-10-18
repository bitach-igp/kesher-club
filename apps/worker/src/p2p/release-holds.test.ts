// P2pReleaseHoldsJob (T-0506, REQ-PAY-003). TST-PAY-003: the job leaves a hold alone before its two
// hours pass, settles it once when they have, however often it runs, tells the recipient once, and
// skips a hold the sender cancelled. A failing release is reported and does not stop the rest.
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
import { HOLD_MS, P2pHoldService, releaseKey } from '@kesher/api/p2p/holds';
import { P2pLimitService } from '@kesher/api/p2p/limits';
import { P2pSendService, runSend } from '@kesher/api/p2p/send';
import { TransferService } from '@kesher/api/transfers/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { P2pReleaseHoldsJob } from './release-holds.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;
let accounts: AccountService;
let ledger: PostgresLedger;
let transfers: TransferService;
let holds: P2pHoldService;
let send: P2pSendService;
let notify: NotifySimulator;
let job: P2pReleaseHoldsJob;
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
const journals = async (key: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where idempotency_key = $1`, [key])).rows[0]!.n;
const told = (transferId: string) => notify.sent.filter((n) => n.data['transferId'] === transferId).length;

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  transfers = new TransferService(db);
  holds = new P2pHoldService(db, ledger, accounts, transfers);
  const plans = new PlanService(db);
  notify = new NotifySimulator();
  send = new P2pSendService({ db, ledger, accounts, transfers, limits: new P2pLimitService(db, new MembershipService(db, plans, new BillingSimulator()), new EntitlementService(db, plans), plans), holds, kyc: new KycService(db, new KycSimulator(fixedClock(NOW.toISOString())), 'IL'), identity, notify });
  job = new P2pReleaseHoldsJob(send, transfers, () => now);
}, 60_000);
afterAll(async () => db.close());

describe('TST-PAY-003: the release job', () => {
  it('settles expired holds once, leaves young and cancelled ones alone, and reports a failing one', async () => {
    const a = await member('+972503000001');
    const b = await member('+972503000002');
    const c = await member('+972503000003');
    const d = await member('+972503000004');
    await credit(a, 300_000n);
    now = NOW;
    const ab = await runSend(send, { fromPartyId: a, toPartyId: b, amount: money(60_000n, 'ILS') }, `h-ab-${a}`, now);
    const ac = await runSend(send, { fromPartyId: a, toPartyId: c, amount: money(70_000n, 'ILS') }, `h-ac-${a}`, now);
    const ad = await runSend(send, { fromPartyId: a, toPartyId: d, amount: money(80_000n, 'ILS') }, `h-ad-${a}`, now);
    for (const r of [ab, ac, ad]) expect(r.transfer.state).toBe('pending_hold');
    expect(await available(a)).toBe(90_000n);
    await holds.cancel(ac.transfer.id, a, now);
    expect(await available(a)).toBe(160_000n);

    now = new Date(NOW.getTime() + HOLD_MS - 1);
    expect(await job.run()).toMatchObject({ attempted: 0, released: 0, lagMs: 0, withinSla: true });
    expect(await available(b)).toBe(0n);

    // One release fails on this pass (the recipient's wallet is briefly unavailable, say): the other goes through.
    const original = holds.release.bind(holds);
    let once = true;
    holds.release = async (t, w, at) => {
      if (t.id === ad.transfer.id && once) {
        once = false;
        throw new Error('ledger unavailable');
      }
      return original(t, w, at);
    };
    now = new Date(NOW.getTime() + HOLD_MS + 30_000);
    const first = await job.run();
    expect(first).toMatchObject({ attempted: 2, released: 1, errors: [{ transferId: ad.transfer.id, error: 'ledger unavailable' }], lagMs: 30_000, withinSla: true });
    expect(await transfers.get(ab.transfer.id)).toMatchObject({ state: 'settled' });
    expect(await transfers.get(ad.transfer.id)).toMatchObject({ state: 'pending_hold' });
    expect(await transfers.get(ac.transfer.id)).toMatchObject({ state: 'cancelled' });
    expect(await available(b)).toBe(60_000n);
    expect(await available(d)).toBe(0n);
    expect(told(ab.transfer.id)).toBe(1);

    now = new Date(now.getTime() + 60_000);
    const second = await job.run();
    expect(second).toMatchObject({ attempted: 1, released: 1, errors: [], lagMs: 0, withinSla: true });
    expect(await available(d)).toBe(80_000n);
    expect(await available(a)).toBe(160_000n);
    expect(told(ad.transfer.id)).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      now = new Date(now.getTime() + 60_000);
      expect(await job.run()).toMatchObject({ attempted: 0 });
    }
    expect(await journals(releaseKey(`h-ab-${a}`))).toBe(1);
    expect(await journals(releaseKey(`h-ad-${a}`))).toBe(1);
    expect(await journals(releaseKey(`h-ac-${a}`))).toBe(0);
    expect(told(ab.transfer.id)).toBe(1);
    expect(told(ad.transfer.id)).toBe(1);
    expect(told(ac.transfer.id)).toBe(0);
    holds.release = original;
  });
});
