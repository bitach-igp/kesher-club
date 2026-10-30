// T-0618: the bank simulator passes the BankPort contract, and its fixtures do what its header says.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { bankContract } from './bank.contract.ts';
import { BANK_OUTAGE_DATE, BankSimulator } from './bank.simulator.ts';

bankContract('simulator', () => new BankSimulator(), {
  credit: async (sim, remitterReference) => sim.credit({ rail: 'masav', amount: money(1_200_000n, 'ILS'), remitterReference }),
  forge: (n) => ({ ...n, headers: { ...n.headers, 'x-sim-signature': 'forged' } }),
  outageDate: BANK_OUTAGE_DATE,
});

describe('BankSimulator fixtures', () => {
  it('a withheld credit is on the statement with no notification; a retried notification is the same event', async () => {
    const sim = new BankSimulator();
    const lost = sim.withhold({ rail: 'ach', amount: money(50_000n, 'USD'), remitterReference: 'KC-AAAAAAAA', valueDate: '2026-11-01' });
    expect((await sim.statement({ valueDate: '2026-11-01' })).map((c) => c.creditId)).toEqual([lost.creditId]);
    const retry = sim.notificationFor(lost.creditId, 'bev_retry');
    expect(await sim.parseWebhook(retry.headers, retry.rawBody)).toEqual(await sim.parseWebhook(retry.headers, retry.rawBody));
  });

  it('refuses a credit of nothing and a malformed date', async () => {
    const sim = new BankSimulator();
    expect(() => sim.credit({ rail: 'wire', amount: money(0n, 'USD'), remitterReference: '' })).toThrow(/positive/);
    await expect(sim.statement({ valueDate: 'yesterday' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
