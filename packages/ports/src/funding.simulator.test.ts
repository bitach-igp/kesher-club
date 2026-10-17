import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { fixedClock } from './base.ts';
import { fundingContract } from './funding.contract.ts';
import { addBusinessDays, FundingSimulator } from './funding.simulator.ts';

fundingContract('simulator', () => new FundingSimulator(), {
  goodPaymentMethod: 'pm_card_ok',
  declinedPaymentMethod: 'pm_declined',
  outagePaymentMethod: 'pm_outage',
  achPaymentMethod: 'pm_bank_ok',
  succeededWebhook: async (port, id) => (port as FundingSimulator).webhookFor(id, 'succeeded'),
  norefundPaymentMethod: 'pm_norefund',
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
