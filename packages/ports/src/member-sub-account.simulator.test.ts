import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { MemberSubAccountError, isMemberSubAccountPort } from './member-sub-account.ts';
import { memberSubAccountContract } from './member-sub-account.contract.ts';
import { MemberSubAccountSimulator } from './member-sub-account.simulator.ts';

const sim = (p: unknown) => p as MemberSubAccountSimulator;

memberSubAccountContract('simulator', () => new MemberSubAccountSimulator(), {
  ownerFailEmail: 'ownerfail@example.test',
  frozenEmail: 'frozen@example.test',
  outageEmail: 'outage@example.test',
  controls: {
    setQuota: (p, n) => sim(p).setQuota(n),
    credit: (p, ref, amount) => sim(p).credit(ref, amount),
    hold: (p, ref, amount) => sim(p).setHold(ref, amount),
    setStatus: (p, ref, status) => sim(p).setStatus(ref, status),
  },
});

describe('MemberSubAccountSimulator refs, fixtures and controls (T-0750, TST-WAL-002)', () => {
  const owner = { firstName: 'Sarah', lastName: 'Cohen', email: 'sarah.cohen@example.test', mobile: '+14155550123' };

  it('refs are self-describing: s:<chapter> and s:<chapter>:<account>', async () => {
    const r = await new MemberSubAccountSimulator().ensureSubAccount({ partyId: 'p-1', purpose: 'Camp', owner }, 'ref-key-0001');
    expect(r.subAccountRef).toMatch(/^s:[\w-]+$/);
    expect(r.accountRef).toMatch(new RegExp(`^${r.subAccountRef}:[\\w-]+$`));
  });

  it('a second party with the same owner mobile still gets a sub-account (the owner is not the identity)', async () => {
    const s = new MemberSubAccountSimulator();
    const a = await s.ensureSubAccount({ partyId: 'p-1', purpose: 'Camp', owner }, 'dup-key-0001');
    const b = await s.ensureSubAccount({ partyId: 'p-2', purpose: 'Camp', owner }, 'dup-key-0002');
    expect(b.subAccountRef).not.toBe(a.subAccountRef);
  });

  it('refuses a debit-like misuse of the controls: hold beyond the balance, non-positive or non-USD credit', async () => {
    const s = new MemberSubAccountSimulator();
    const r = await s.ensureSubAccount({ partyId: 'p-1', purpose: 'Camp', owner }, 'ctl-key-0001');
    s.credit(r.subAccountRef, money(100n, 'USD'));
    expect(() => s.setHold(r.subAccountRef, money(101n, 'USD'))).toThrow(MemberSubAccountError);
    expect(() => s.credit(r.subAccountRef, money(0n, 'USD'))).toThrow(MemberSubAccountError);
    expect(() => s.credit(r.subAccountRef, money(5n, 'ILS'))).toThrow(MemberSubAccountError);
  });

  it('is found by the method-exists guard, and a port without the methods is not', () => {
    expect(isMemberSubAccountPort(new MemberSubAccountSimulator())).toBe(true);
    expect(isMemberSubAccountPort({ ensureSubAccount: () => undefined })).toBe(false);
    expect(isMemberSubAccountPort(null)).toBe(false);
  });
});
