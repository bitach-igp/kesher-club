// T-0647: the US-banking simulator passes the InstitutionBankingPort contract (REQ-INS-022..026), and its fixtures do
// what its header says.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { fixedClock } from './base.ts';
import { institutionBankingContract } from './institution-banking.contract.ts';
import { InstitutionBankingSimulator } from './institution-banking.simulator.ts';

// A page of 2 so five rows cross three page boundaries.
institutionBankingContract('simulator', () => new InstitutionBankingSimulator(fixedClock(), 2), {
  approve: async (sim, ref) => void sim.decide(ref),
  fund: async (sim, ref, minor) => void sim.post(ref, 'credit', money(minor, 'USD'), 'Wire in'),
  post: async (sim, ref, count) => {
    for (let i = 0; i < count; i++) sim.post(ref, 'credit', money(100n + BigInt(i), 'USD'), `Deposit ${i}`);
  },
  pay: async (sim, intentRef) => sim.pay(intentRef),
  advanceAch: async (sim, ref) => void sim.settleAch(ref),
  signed: (sim) => sim.webhook([{ type: 'application.updated', objectRef: 'ent_000001' }]),
  forge: (n) => ({ ...n, headers: { ...n.headers, 'x-webhook-signature': 'sha256=forged' } }),
  outageLegalName: 'OUTAGE Friends',
});

const NEW = (key: string, legalName: string) => ({ institutionId: '0190a0a0-0000-7000-8000-000000000001', legalName, ein: '123456789', idempotencyKey: key });
const opened = async (sim: InstitutionBankingSimulator, legalName = 'ent_ok Friends') => {
  const { entityRef } = await sim.createEntity(NEW('key-entity-0001', legalName));
  sim.decide(entityRef);
  return entityRef;
};

describe('InstitutionBankingSimulator fixtures', () => {
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
