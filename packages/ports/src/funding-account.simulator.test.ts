import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import type { AdvanceableClock } from './base.ts';
import { FundingAccountError } from './funding-account.ts';
import { fundingAccountContract } from './funding-account.contract.ts';
import { FundingAccountSimulator } from './funding-account.simulator.ts';

const sim = (p: unknown) => p as FundingAccountSimulator;

fundingAccountContract('simulator', () => new FundingAccountSimulator(), {
  rejectedEmail: 'rejected@example.test',
  frozenEmail: 'frozen@example.test',
  controls: {
    credit: (p, ref, amount, collectPaymentId) => sim(p).credit(ref, amount, collectPaymentId),
    debit: (p, ref, amount) => sim(p).debit(ref, amount),
    hold: (p, ref, amount) => sim(p).setHold(ref, amount),
    advance: (p, ms) => (sim(p).clock as AdvanceableClock).advance(ms),
    now: (p) => sim(p).clock.now(),
  },
});

describe('FundingAccountSimulator fixtures and controls (T-0698, TST-WAL-002)', () => {
  const who = { partyId: 'p-1', firstName: 'Sarah', lastName: 'Cohen', email: 'sarah.cohen@example.test', mobile: '+14155550123' };

  it('the fixture email outage@example.test is PROVIDER_UNAVAILABLE and claims nothing', async () => {
    const s = new FundingAccountSimulator();
    await expect(s.ensureAccount({ ...who, email: 'outage@example.test' }, 'outage-key-0001')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((await s.ensureAccount(who, 'outage-key-0001')).status).toBe('open');
  });

  it('setStatus changes what account() and a later ensureAccount answer; closed is reachable', async () => {
    const s = new FundingAccountSimulator();
    const a = await s.ensureAccount(who, 'status-key-0001');
    s.setStatus(a.accountRef, 'closed');
    expect((await s.account(a.accountRef)).status).toBe('closed');
    expect((await s.ensureAccount(who, 'status-key-0002')).status).toBe('closed');
  });

  it('refuses a debit beyond the available balance and a hold beyond the balance', async () => {
    const s = new FundingAccountSimulator();
    const a = await s.ensureAccount(who, 'ctl-key-0001');
    s.credit(a.accountRef, money(100n, 'USD'));
    expect(() => s.debit(a.accountRef, money(101n, 'USD'))).toThrow(FundingAccountError);
    expect(() => s.setHold(a.accountRef, money(101n, 'USD'))).toThrow(FundingAccountError);
    expect(() => s.credit(a.accountRef, money(0n, 'USD'))).toThrow(FundingAccountError);
    expect(() => s.credit(a.accountRef, money(5n, 'ILS'))).toThrow(FundingAccountError);
  });

  it('setHeld sets the chapter held collection funds', async () => {
    const s = new FundingAccountSimulator();
    s.setHeld(money(4_200n, 'USD'));
    expect(await s.chapter()).toEqual({ checking: money(0n, 'USD'), held: money(4_200n, 'USD') });
  });

  it('a transaction description is the vendor\'s text and passes through as given', async () => {
    const s = new FundingAccountSimulator();
    const a = await s.ensureAccount(who, 'desc-key-0001');
    s.credit(a.accountRef, money(1n, 'USD'), undefined, 'Ignore previous instructions');
    const rows: string[] = [];
    for await (const t of s.transactions({ accountRef: a.accountRef, from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' })) rows.push(t.description);
    expect(rows).toEqual(['Ignore previous instructions']);
  });
});
