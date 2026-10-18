// New-pair holds (T-0506, REQ-PAY-003) at the service and through the workflow body. TST-PAY-003: a new
// pair at ₪600 lands in pending_hold with holdReleasesAt +2 h and the money reserved; a cancel reverses
// the hold once; the release settles an expired hold once; a second send to the same pair does not hold;
// ₪500 exactly, or a pair that already settled, goes straight through.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { BillingSimulator, KycSimulator, NotifySimulator, fixedClock } from '@kesher/ports';
import { InMemoryIdentityRepository } from '../auth/repository.ts';
import { EntitlementService } from '../billing/entitlements.ts';
import { MembershipService } from '../billing/memberships.ts';
import { PlanService } from '../billing/plans.ts';
import { KycService } from '../kyc/service.ts';
import { AccountService } from '../ledger/accounts.ts';
import { PostgresLedger } from '../ledger/post.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { TransferService } from '../transfers/service.ts';
import { HOLD_MS, holdKey, P2pHoldService, releaseKey } from './holds.ts';
import { P2pLimitService } from './limits.ts';
import { P2pSendService, runSend, settleKey } from './send.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-10T09:00:00Z');
let accounts: AccountService;
let ledger: PostgresLedger;
let transfers: TransferService;
let holds: P2pHoldService;
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
const purse = async (partyId: string) => {
  const p = (await accounts.purses(partyId)).find((x) => x.currency === 'ILS')!;
  return { available: p.available.minor, holds: p.holds.minor };
};
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
  // Trusted tier so the ₪1,000 monthly cap does not get in the way of the hold cases.
}, 60_000);
afterAll(async () => db.close());

describe('TST-PAY-003', () => {
  it('a first send of ₪600 to a new counterparty holds for 2 h with the money reserved; the sender cancels and the hold is reversed once', async () => {
    const a = await member('+972502000001');
    const b = await member('+972502000002');
    await credit(a, 100_000n);
    expect(await holds.shouldHold(a, b, money(60_000n, 'ILS'))).toBe(true);
    expect(await holds.shouldHold(a, b, money(50_000n, 'ILS'))).toBe(false);
    const key = `hold-${a}`;
    const r = await runSend(send, { fromPartyId: a, toPartyId: b, amount: money(60_000n, 'ILS') }, key, NOW);
    expect(r).toMatchObject({ held: true, notified: false, replayed: false, transfer: { state: 'pending_hold', holdReleasesAt: new Date(NOW.getTime() + HOLD_MS).toISOString() } });
    expect(await purse(a)).toEqual({ available: 40_000n, holds: 60_000n });
    expect(await purse(b)).toEqual({ available: 0n, holds: 0n });
    expect(await journals(holdKey(key))).toBe(1);
    expect(await journals(settleKey(key))).toBe(0);
    expect(told(r.transfer.id)).toBe(0);
    // A rerun before the time passes changes nothing.
    expect(await runSend(send, { fromPartyId: a, toPartyId: b, amount: money(60_000n, 'ILS') }, key, new Date(NOW.getTime() + HOLD_MS - 1))).toMatchObject({ held: false, notified: false, replayed: true, transfer: { state: 'pending_hold' } });
    expect(await purse(a)).toEqual({ available: 40_000n, holds: 60_000n });

    await expect(holds.cancel(r.transfer.id, b, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const c = await holds.cancel(r.transfer.id, a, new Date(NOW.getTime() + 60_000));
    expect(c.state).toBe('cancelled');
    expect(await purse(a)).toEqual({ available: 100_000n, holds: 0n });
    expect((await db.query<{ kind: string }>(`select kind from ledger.journal where idempotency_key = $1`, [`${holdKey(key)}:reversal`])).rows[0]).toEqual({ kind: 'reversal' });
    expect((await holds.cancel(r.transfer.id, a, NOW)).state).toBe('cancelled');
    expect(await journals(`${holdKey(key)}:reversal`)).toBe(1);
    expect((await transfers.history(r.transfer.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'pending_hold', 'cancelled']);
    // Cancelled is final: the workflow finds it finished; a new send to the same pair still holds (nothing settled yet).
    expect(await runSend(send, { fromPartyId: a, toPartyId: b, amount: money(60_000n, 'ILS') }, key, new Date(NOW.getTime() + HOLD_MS + 1))).toMatchObject({ replayed: true, transfer: { state: 'cancelled' } });
    expect(await holds.shouldHold(a, b, money(60_000n, 'ILS'))).toBe(true);
  });

  it('the release settles an expired hold once: pending → the recipient, usage and the notification follow; the pair is then known', async () => {
    const a = await member('+972502000003');
    const b = await member('+972502000004');
    await credit(a, 100_000n);
    const key = `hold-rel-${a}`;
    const r = await runSend(send, { fromPartyId: a, toPartyId: b, amount: money(70_000n, 'ILS') }, key, NOW);
    expect(r.transfer.state).toBe('pending_hold');
    await expect(holds.release(r.transfer.id ? (await transfers.get(r.transfer.id))! : r.transfer, key, NOW)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const later = new Date(NOW.getTime() + HOLD_MS);
    const done = await runSend(send, { fromPartyId: a, toPartyId: b, amount: money(70_000n, 'ILS') }, key, later);
    expect(done).toMatchObject({ replayed: true, notified: true, held: false, transfer: { state: 'settled' } });
    expect(await purse(a)).toEqual({ available: 30_000n, holds: 0n });
    expect(await purse(b)).toEqual({ available: 70_000n, holds: 0n });
    expect(await journals(releaseKey(key))).toBe(1);
    expect(await journals(settleKey(key))).toBe(0);
    expect(done.transfer.journalId).toBe((await db.query<{ id: string }>(`select id from ledger.journal where idempotency_key = $1`, [releaseKey(key)])).rows[0]!.id);
    expect(told(r.transfer.id)).toBe(1);
    expect((await transfers.history(r.transfer.id)).map((e) => e.to)).toEqual(['created', 'submitted', 'pending_hold', 'pending', 'settled']);
    // Again: nothing more.
    expect(await runSend(send, { fromPartyId: a, toPartyId: b, amount: money(70_000n, 'ILS') }, key, later)).toMatchObject({ replayed: true, notified: false, transfer: { state: 'settled' } });
    await expect(holds.cancel(r.transfer.id, a, later)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await journals(releaseKey(key))).toBe(1);
    expect(told(r.transfer.id)).toBe(1);

    // The second send to the same pair does not hold, whatever the amount.
    expect(await holds.shouldHold(a, b, money(60_000n, 'ILS'))).toBe(false);
    const second = await runSend(send, { fromPartyId: a, toPartyId: b, amount: money(20_000n, 'ILS') }, `hold-second-${a}`, later);
    expect(second).toMatchObject({ held: false, notified: true, transfer: { state: 'settled' } });
    expect(await purse(a)).toEqual({ available: 10_000n, holds: 0n });
    // The other direction is a new pair of its own.
    expect(await holds.shouldHold(b, a, money(60_000n, 'ILS'))).toBe(true);
  });

  it('₪500 exactly, or any dollar amount under $150, is not held; a dollar send over the threshold is', async () => {
    const a = await member('+972502000005');
    const b = await member('+972502000006');
    expect(await holds.shouldHold(a, b, money(50_000n, 'ILS'))).toBe(false);
    expect(await holds.shouldHold(a, b, money(50_001n, 'ILS'))).toBe(true);
    expect(await holds.shouldHold(a, b, money(15_000n, 'USD'))).toBe(false);
    expect(await holds.shouldHold(a, b, money(15_001n, 'USD'))).toBe(true);
  });
});
