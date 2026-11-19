import { describe, expect, it } from 'vitest';
import { chapterOf, parseSubAccountRef, subAccountRef } from './member-sub-account-ref.ts';
import { MemberSubAccountSimulator } from './member-sub-account.simulator.ts';

describe('member sub-account ref grammar (T-0762)', () => {
  it('makes s:<chapter> and s:<chapter>:<account>', () => {
    expect(subAccountRef('ch1')).toBe('s:ch1');
    expect(subAccountRef('ch1', 'ac_9')).toBe('s:ch1:ac_9');
  });

  it('round-trips through parse and chapterOf', () => {
    expect(parseSubAccountRef(subAccountRef('Ab-1_x'))).toEqual({ chapterId: 'Ab-1_x' });
    expect(parseSubAccountRef(subAccountRef('ch1', 'ac-2'))).toEqual({ chapterId: 'ch1', accountId: 'ac-2' });
    expect(chapterOf('s:ch1')).toBe('ch1');
    expect(chapterOf('s:ch1:ac2')).toBe('ch1');
    expect(chapterOf('x:ch1')).toBeUndefined();
  });

  it('rejects anything that is not a ref', () => {
    for (const bad of ['s:', 's:a:b:c', 's:a%b', 's:a/b', 's:a:', 's::a', 'S:a', 'c:a', ' s:a', 's:a\n', `s:${'x'.repeat(65)}`, `s:a:${'x'.repeat(65)}`, '', undefined, null, 5, {}]) {
      expect(parseSubAccountRef(bad)).toBeUndefined();
      expect(chapterOf(bad)).toBeUndefined();
    }
    expect(parseSubAccountRef(`s:${'x'.repeat(64)}`)).toEqual({ chapterId: 'x'.repeat(64) });
  });

  it('parses the refs the simulator makes', async () => {
    const sim = new MemberSubAccountSimulator();
    const r = await sim.ensureSubAccount({ partyId: 'p1', purpose: 'dues', inviteEmail: 'a@example.test' }, 'key-ref-00001');
    const sub = parseSubAccountRef(r.subAccountRef);
    const acct = parseSubAccountRef(r.accountRef);
    expect(sub?.accountId).toBeUndefined();
    expect(acct?.chapterId).toBe(sub?.chapterId);
    expect(acct?.accountId).toBeDefined();
    expect(subAccountRef(sub!.chapterId)).toBe(r.subAccountRef);
    expect(subAccountRef(acct!.chapterId, acct!.accountId)).toBe(r.accountRef);
  });
});
