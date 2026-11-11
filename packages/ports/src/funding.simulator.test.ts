import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { type AdvanceableClock, fixedClock } from './base.ts';
import { FundingError } from './funding.ts';
import { fundingContract, fundingStatementContract } from './funding.contract.ts';
import { addBusinessDays, FundingSimulator } from './funding.simulator.ts';

fundingContract('simulator', () => new FundingSimulator(), {
  goodPaymentMethod: 'pm_card_ok',
  declinedPaymentMethod: 'pm_declined',
  outagePaymentMethod: 'pm_outage',
  achPaymentMethod: 'pm_bank_ok',
  succeededWebhook: async (port, id) => (port as FundingSimulator).webhookFor(id, 'succeeded'),
  norefundPaymentMethod: 'pm_norefund',
  hosted: true,
});

fundingStatementContract('simulator', () => new FundingSimulator(fixedClock()), {
  goodPaymentMethod: 'pm_card_ok',
  achPaymentMethod: 'pm_bank_ok',
  slowRefundPaymentMethod: 'pm_slowrefund',
  clockOf: (port) => (port as FundingSimulator).clock as AdvanceableClock,
  failListingFrom: (port, after) => {
    (port as FundingSimulator).outageAfterPages = after;
  },
});

describe('FundingSimulator hosted load controls (T-0697, TST-WAL-002)', () => {
  const amount = money(10_000n, 'USD');
  const hosted = { payerIp: '203.0.113.7', userConsented: true } as const;
  const start = async (sim: FundingSimulator, key = 'H-key-1') => sim.createLoad({ customerId: 'c', method: 'hosted', amount, hosted }, key);

  it('payHosted(card) makes the load succeeded with method card and no action', async () => {
    const sim = new FundingSimulator();
    const l = await start(sim);
    const paid = sim.payHosted(l.loadId, 'card');
    expect(paid).toMatchObject({ loadId: l.loadId, status: 'succeeded', method: 'card', amount });
    expect(paid.action).toBeUndefined();
    expect(await sim.getLoad(l.loadId)).toEqual(paid);
    const settled = await sim.listSettled({ from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' });
    expect(settled.entries.map((e) => e.id)).toEqual([l.loadId]);
  });

  it('payHosted(ach) makes it processing, then settle puts it on hold three business days on', async () => {
    const sim = new FundingSimulator(fixedClock('2026-11-02T10:00:00Z')); // a Monday
    const l = await start(sim);
    expect(sim.payHosted(l.loadId, 'ach')).toMatchObject({ status: 'processing', method: 'ach' });
    const held = sim.settle(l.loadId);
    expect(held).toMatchObject({ status: 'on_hold', method: 'ach' });
    expect(held.holdUntil!.slice(0, 10)).toBe('2026-11-05');
  });

  it('failHosted makes it failed with that code', async () => {
    const sim = new FundingSimulator();
    const l = await start(sim);
    expect(sim.failHosted(l.loadId, 'DECLINED')).toMatchObject({ status: 'failed', failureCode: 'DECLINED' });
    expect((await sim.getLoad(l.loadId)).action).toBeUndefined();
  });

  it('only a pending hosted load can be paid or failed', async () => {
    const sim = new FundingSimulator();
    const l = await start(sim);
    sim.payHosted(l.loadId, 'card');
    expect(() => sim.payHosted(l.loadId, 'ach')).toThrow(FundingError);
    expect(() => sim.failHosted(l.loadId, 'DECLINED')).toThrow(FundingError);
    const card = await sim.createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_ok' }, 'H-card-1');
    expect(() => sim.payHosted(card.loadId, 'card')).toThrow(FundingError);
  });

  it('a load that is not hosted still has no action (existing callers unchanged)', async () => {
    const l = await new FundingSimulator().createLoad({ customerId: 'c', method: 'card', amount, paymentMethodId: 'pm_card_ok' }, 'H-card-2');
    expect(l.action).toBeUndefined();
  });
});

describe('FundingSimulator specifics', () => {
  it('an ACH load on Monday with a 3-day hold is spendable Thursday (REQ-WAL-003)', async () => {
    const monday = fixedClock('2026-11-02T10:00:00Z'); // 2026-11-02 is a Monday
    const sim = new FundingSimulator(monday);
    const l = await sim.createLoad({ customerId: 'c', method: 'ach', amount: money(5000n, 'USD'), paymentMethodId: 'pm_bank_ok' }, 'k');
    expect(l.holdUntil!.slice(0, 10)).toBe('2026-11-05');
  });

  it('business-day arithmetic skips weekends', () => {
    expect(addBusinessDays(new Date('2026-11-06T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-11-09'); // Fri -> Mon
  });
});
