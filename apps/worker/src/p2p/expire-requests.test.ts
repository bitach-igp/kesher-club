// ExpireRequestsJob (T-0507, REQ-PAY-004): open requests past 14 days become expired, in batches, once;
// paid, declined and cancelled ones are left alone; a repeat finds nothing.
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
import { PaymentRequestService, REQUEST_TTL_MS } from '@kesher/api/p2p/requests';
import { P2pSendService } from '@kesher/api/p2p/send';
import { TransferService } from '@kesher/api/transfers/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { ExpireRequestsJob } from './expire-requests.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;
let requests: PaymentRequestService;
const identity = new InMemoryIdentityRepository();

async function member(phone: string): Promise<string> {
  const partyId = uuidv7(NOW);
  await identity.createUser({ partyId, phone, status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
  return partyId;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const ledger = new PostgresLedger(db);
  const accounts = new AccountService(db, ledger);
  const transfers = new TransferService(db);
  const plans = new PlanService(db);
  const send = new P2pSendService({ db, ledger, accounts, transfers, limits: new P2pLimitService(db, new MembershipService(db, plans, new BillingSimulator()), new EntitlementService(db, plans), plans), holds: new P2pHoldService(db, ledger, accounts, transfers), kyc: new KycService(db, new KycSimulator(fixedClock(NOW.toISOString())), 'IL'), identity, notify: new NotifySimulator(), preferences: new PreferenceService(db), rates: new RateService(db, new ApprovalService(db), new AuditService(db)), markups: { markupFor: async () => DEFAULT_FX_MARKUP_BPS } });
  requests = new PaymentRequestService(db, send, identity);
}, 60_000);
afterAll(async () => db.close());

describe('the expiry job', () => {
  it('expires only what is 14 days old and open, in batches, once', async () => {
    const a = await member('+972505000001');
    const b = await member('+972505000002');
    now = NOW;
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) ids.push((await requests.create(a, { payerPartyId: b, amount: money(100n + BigInt(i), 'ILS') }, `exp-${a}-${i}`, now)).id);
    await requests.decline(b, ids[5]!, now);
    await requests.cancel(a, ids[6]!, now);
    now = new Date(NOW.getTime() + 60_000);
    const young = (await requests.create(a, { payerPartyId: b, amount: money(999n, 'ILS') }, `exp-${a}-young`, now)).id;

    const job = new ExpireRequestsJob(requests, () => now, 2);
    now = new Date(NOW.getTime() + REQUEST_TTL_MS - 1);
    expect(await job.run()).toMatchObject({ expired: 0 });

    now = new Date(NOW.getTime() + REQUEST_TTL_MS);
    expect(await job.run()).toMatchObject({ ranAt: now.toISOString(), expired: 5 }); // three batches of two, the last short
    for (const id of ids.slice(0, 5)) expect((await requests.get(id))!.status).toBe('expired');
    expect((await requests.get(ids[5]!))!.status).toBe('declined');
    expect((await requests.get(ids[6]!))!.status).toBe('cancelled');
    expect((await requests.get(young))!.status).toBe('open');
    expect(await job.run()).toMatchObject({ expired: 0 });

    now = new Date(now.getTime() + 60_000);
    expect(await job.run()).toMatchObject({ expired: 1 });
    expect((await requests.get(young))!.status).toBe('expired');
    expect(await job.run()).toMatchObject({ expired: 0 });
  });
});
