// T-0647: the US-banking simulator passes the InstitutionBankingPort contract (REQ-INS-022..026), and its fixtures do
// what its header says.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { fixedClock } from './base.ts';
import { institutionBankingContract } from './institution-banking.contract.ts';
import { InstitutionBankingSimulator } from './institution-banking.simulator.ts';

// A page of 2 so five rows cross three page boundaries. The suite runs for each holder setup.
const common = {
  approve: async (sim: InstitutionBankingSimulator, ref: string) => void sim.decide(ref),
  fund: async (sim: InstitutionBankingSimulator, ref: string, minor: bigint) => void sim.post(ref, 'credit', money(minor, 'USD'), 'Wire in'),
  post: async (sim: InstitutionBankingSimulator, ref: string, count: number) => {
    for (let i = 0; i < count; i++) sim.post(ref, 'credit', money(100n + BigInt(i), 'USD'), `Deposit ${i}`);
  },
  pay: async (sim: InstitutionBankingSimulator, intentRef: string) => sim.pay(intentRef),
  advanceAch: async (sim: InstitutionBankingSimulator, ref: string) => void sim.settleAch(ref),
  signed: (sim: InstitutionBankingSimulator) => sim.webhook([{ type: 'application.updated', objectRef: 'ent_000001' }]),
  forge: (n: { headers: Record<string, string>; rawBody: string }) => ({ ...n, headers: { ...n.headers, 'x-webhook-signature': 'sha256=forged' } }),
  outageLegalName: 'OUTAGE Friends',
};
const make = () => new InstitutionBankingSimulator(fixedClock(), 2);
institutionBankingContract('simulator, institution holder', make, { ...common, holder: 'institution' });
institutionBankingContract('simulator, platform holder with sub-accounts', make, { ...common, holder: 'platform', legalName: 'holder_platform_subaccounts Israel Global Pay' });
institutionBankingContract('simulator, platform holder with a pooled account', make, { ...common, holder: 'platform', legalName: 'holder_platform_pooled Israel Global Pay' });

const NEW = (key: string, legalName: string) => ({ holder: 'institution' as const, institutionId: '0190a0a0-0000-7000-8000-000000000001', legalName, ein: '123456789', idempotencyKey: key });
const opened = async (sim: InstitutionBankingSimulator, legalName = 'ent_ok Friends') => {
  const { entityRef } = await sim.createEntity(NEW('key-entity-0001', legalName));
  sim.decide(entityRef);
  return entityRef;
};

describe('InstitutionBankingSimulator fixtures', () => {
  it('keeps a balance past 2^53 exact in bigint, and a page is paid once', async () => {
    const sim = new InstitutionBankingSimulator();
    const entityRef = await opened(sim);
    sim.post(entityRef, 'credit', money(9_007_199_254_740_993n, 'USD'), 'Wire in');
    expect((await sim.account(entityRef)).balance).toEqual(money(9_007_199_254_740_993n, 'USD'));
    const { collectionRef } = await sim.createCollection({ entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' });
    const { intentRef } = await sim.createPaymentPage({ collectionRef, funder: { name: 'A', email: 'a@example.com', mobile: '+12125550123' }, idempotencyKey: 'key-page-0001' });
    expect(sim.pay(intentRef).payment).toEqual(sim.pay(intentRef).payment);
    expect((await sim.account(entityRef)).balance).toEqual(money(9_007_199_254_785_993n, 'USD'));
  });

  it('the platform fixtures decide whether an institution gets its own account number; a unit has no units', async () => {
    const sim = new InstitutionBankingSimulator();
    const platform = async (legalName: string, key: string) => {
      const { entityRef } = await sim.createEntity({ ...NEW(key, legalName), holder: 'platform' });
      sim.decide(entityRef);
      return entityRef;
    };
    const inst = '0190a0a0-0000-7000-8000-000000000101';
    const own = await platform('holder_platform_subaccounts IGP', 'key-plat-0001');
    const pooled = await platform('holder_platform_pooled IGP', 'key-plat-0002');
    const a = await sim.createSubAccount({ entityRef: own, institutionId: inst, idempotencyKey: 'key-sub-00001' });
    const b = await sim.createSubAccount({ entityRef: pooled, institutionId: inst, idempotencyKey: 'key-sub-00002' });
    expect([a.hasOwnAccountNumber, b.hasOwnAccountNumber]).toEqual([true, false]);
    await expect(sim.createSubAccount({ entityRef: a.subAccountRef, institutionId: inst, idempotencyKey: 'key-sub-00003' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(sim.createSubAccount({ entityRef: b.subAccountRef, institutionId: inst, idempotencyKey: 'key-sub-00004' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a book transfer stays inside one platform: another platform, or an institution\'s own entity, is refused and nothing moves', async () => {
    const sim = new InstitutionBankingSimulator();
    const open = async (holder: 'platform' | 'institution', key: string) => {
      const { entityRef } = await sim.createEntity({ ...NEW(key, 'ent_ok Friends'), holder });
      sim.decide(entityRef);
      sim.post(entityRef, 'credit', money(100_000n, 'USD'), 'Wire in');
      return entityRef;
    };
    const p1 = await open('platform', 'key-plat-0001');
    const p2 = await open('platform', 'key-plat-0002');
    const own = await open('institution', 'key-inst-0001');
    const book = (fromRef: string, toRef: string, key: string) => sim.bookTransfer({ fromRef, toRef, amount: money(1_000n, 'USD'), memo: 'KC-7M4QX2HD', idempotencyKey: key });
    await expect(book(p1, p2, 'key-book-0001')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(book(p1, own, 'key-book-0002')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    for (const ref of [p1, p2, own]) expect((await sim.account(ref)).balance).toEqual(money(100_000n, 'USD'));
  });

  it('ent_rejected and ent_needs_info decide that way; the default is approved', async () => {
    const sim = new InstitutionBankingSimulator();
    for (const [name, status] of [['ent_rejected Friends', 'rejected'], ['ent_needs_info Friends', 'needs_info'], ['Friends', 'approved']] as const) {
      const { entityRef } = await sim.createEntity(NEW(`key-${name.length}-0000`, name));
      expect(sim.decide(entityRef)).toBe(status);
      expect(await sim.applicationStatus(entityRef)).toBe(status);
    }
  });

  it('pay_declined and pay_refunded settle that way, and only a paid page credits the account', async () => {
    const sim = new InstitutionBankingSimulator();
    const entityRef = await opened(sim);
    const { collectionRef } = await sim.createCollection({ entityRef, title: 'Trip', amount: money(45_000n, 'USD'), idempotencyKey: 'key-col-00001' });
    const page = (name: string) => sim.createPaymentPage({ collectionRef, funder: { name, email: 'a@example.com', mobile: '+12125550123' }, idempotencyKey: `key-${name}` });
    const [ok, declined, refunded] = await Promise.all([page('pay_ok A'), page('pay_declined B'), page('pay_refunded C')]);
    expect(sim.pay(ok.intentRef).payment.status).toBe('paid');
    expect(sim.pay(declined.intentRef).payment.status).toBe('declined');
    expect(sim.pay(refunded.intentRef).payment.status).toBe('refunded');
    expect((await sim.account(entityRef)).balance).toEqual(money(45_000n, 'USD'));
  });

  it('ach_returned comes back to the balance; ach_rejected_201 is REJECTED; a send over the balance is refused', async () => {
    const sim = new InstitutionBankingSimulator();
    const entityRef = await opened(sim);
    sim.post(entityRef, 'credit', money(200_000n, 'USD'), 'Wire in');
    const send = (counterpartyRef: string, key: string, minor = 50_000n) => sim.sendAch({ entityRef, counterpartyRef, amount: money(minor, 'USD'), addenda: 'KC-7M4QX2HD', idempotencyKey: key });
    const a = await send('ach_returned_kesher', 'key-ach-00001');
    expect((await sim.account(entityRef)).balance).toEqual(money(150_000n, 'USD'));
    expect([sim.settleAch(a.paymentRef), sim.settleAch(a.paymentRef)]).toEqual(['sent', 'returned']);
    expect((await sim.account(entityRef)).balance).toEqual(money(200_000n, 'USD'));
    await expect(send('ach_rejected_201_kesher', 'key-ach-00002')).rejects.toMatchObject({ code: 'REJECTED' });
    await expect(send('ach_ok_kesher', 'key-ach-00003', 200_001n)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(sim.sendAch({ entityRef, counterpartyRef: 'ach_rejected_201_kesher', amount: money(1n, 'USD'), addenda: 'KC-7M4QX2HD', idempotencyKey: 'key-ach-00001' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('wh_dup repeats an event id in one batch and wh_bad_sig is rejected', async () => {
    const sim = new InstitutionBankingSimulator();
    const dup = sim.webhook([{ type: 'collect.payment.paid' }, { type: 'application.updated' }], 'wh_dup');
    const parsed = await sim.parseWebhook(dup.headers, dup.rawBody);
    expect('events' in parsed && parsed.events.map((e) => e.eventId)).toEqual(['ev_000001', 'ev_000002', 'ev_000001']);
    const bad = sim.webhook([{ type: 'x' }], 'wh_bad_sig');
    expect(await sim.parseWebhook(bad.headers, bad.rawBody)).toEqual({ rejected: 'BAD_SIGNATURE' });
  });
});
