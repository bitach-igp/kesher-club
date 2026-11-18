// MemberSubAccountPort contract (TST-WAL-002 at the port layer, T-0750). A member's sub-account under the nonprofit.
import { describe, expect, it, vi } from 'vitest';
import { money } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { MemberSubAccountError, type EnsureSubAccountInput, type MemberSubAccountPort, type MemberSubAccountStatus, type SubAccountOwner } from './member-sub-account.ts';

export interface MemberSubAccountContractOptions {
  /** An owner or invitation email the vendor refuses: `ownerStatus: 'failed'`, the sub-account still made and open. */
  ownerFailEmail: string;
  /** An email whose sub-account the vendor freezes. */
  frozenEmail: string;
  /** An email whose request fails as PROVIDER_UNAVAILABLE. */
  outageEmail: string;
  controls: {
    /** After `setQuota(n)` the create past `n` sub-accounts (in all) answers QUOTA_EXCEEDED. */
    setQuota: (port: MemberSubAccountPort, n: number) => void;
    credit: (port: MemberSubAccountPort, subAccountRef: string, amount: Money) => void;
    hold: (port: MemberSubAccountPort, subAccountRef: string, amount: Money) => void;
    setStatus: (port: MemberSubAccountPort, subAccountRef: string, status: MemberSubAccountStatus) => void;
  };
}

const OWNER: SubAccountOwner = { firstName: 'Sarah', lastName: 'Cohen', email: 'sarah.cohen@example.test', mobile: '+14155550123', dateOfBirth: '1991-04-17' };
const PURPOSE = 'Youth group fundraiser';

export function memberSubAccountContract(name: string, make: () => MemberSubAccountPort, opts: MemberSubAccountContractOptions): void {
  describe(`MemberSubAccountPort contract: ${name}`, () => {
    const withOwner = (partyId: string, over: Partial<SubAccountOwner> = {}, purpose = PURPOSE): EnsureSubAccountInput => ({ partyId, purpose, owner: { ...OWNER, ...over } });
    const invite = (partyId: string, inviteEmail = 'invitee@example.test', purpose = PURPOSE): EnsureSubAccountInput => ({ partyId, purpose, inviteEmail });
    const other = { email: 'other@example.test', mobile: '+14155550124' };
    const usd = (minor: bigint) => money(minor, 'USD');
    const attempt = (p: Promise<unknown>) => p.then((v) => v, (e: unknown) => e);

    it('ensures a sub-account with a chapter ref and its own deposit account, and the same key replays the same refs', async () => {
      const port = make();
      const a = await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
      const b = await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
      expect(a).toMatchObject({ status: 'open', ownerStatus: 'active' });
      expect(a.subAccountRef).toBeTruthy();
      expect(a.accountRef).toBeTruthy();
      expect(a.accountRef).not.toBe(a.subAccountRef);
      expect(b).toEqual(a);
    });

    it('answers the same refs for a second key for the same party and purpose, and new refs for another party or purpose', async () => {
      const port = make();
      const a = await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
      expect(await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0002')).toEqual(a);
      const c = await port.ensureSubAccount(withOwner('p-2', other), 'ensure-key-0003');
      const d = await port.ensureSubAccount(withOwner('p-1', {}, 'Camp tuition'), 'ensure-key-0004');
      expect(c.subAccountRef).not.toBe(a.subAccountRef);
      expect(d.subAccountRef).not.toBe(a.subAccountRef);
      expect(new Set([a.accountRef, c.accountRef, d.accountRef]).size).toBe(3);
    });

    it('refuses a reused key with different input and returns no refs', async () => {
      const port = make();
      const a = await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
      const variants: Array<[string, EnsureSubAccountInput]> = [
        ['party', withOwner('p-2')],
        ['purpose', withOwner('p-1', {}, 'Camp tuition')],
        ['mobile', withOwner('p-1', { mobile: other.mobile })],
        ['email', withOwner('p-1', { email: other.email })],
        ['name', withOwner('p-1', { firstName: 'Dana' })],
        ['dateOfBirth', withOwner('p-1', { dateOfBirth: '1990-01-01' })],
        ['invitation instead of owner', invite('p-1')],
      ];
      for (const [what, input] of variants) {
        const r = await attempt(port.ensureSubAccount(input, 'ensure-key-0001'));
        expect(r, what).toBeInstanceOf(MemberSubAccountError);
        expect(r, what).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      }
      expect(await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001')).toEqual(a);
    });

    it('takes an invitation email in place of an owner: ownerStatus invited', async () => {
      const port = make();
      const a = await port.ensureSubAccount(invite('p-1'), 'invite-key-0001');
      expect(a).toMatchObject({ status: 'open', ownerStatus: 'invited' });
      expect(await port.ensureSubAccount(invite('p-1'), 'invite-key-0001')).toEqual(a);
    });

    it('refuses both an owner and an invitation, or neither, with VALIDATION_FAILED', async () => {
      const port = make();
      const both = { partyId: 'p-1', purpose: PURPOSE, owner: OWNER, inviteEmail: 'invitee@example.test' };
      const neither = { partyId: 'p-1', purpose: PURPOSE };
      await expect(port.ensureSubAccount(both, 'bad-input-0001')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(port.ensureSubAccount(neither, 'bad-input-0002')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('refuses an empty purpose as PURPOSE_REQUIRED, and judges no other purpose', async () => {
      const port = make();
      for (const [i, purpose] of ['', '   '].entries()) {
        await expect(port.ensureSubAccount(withOwner('p-1', {}, purpose), `purpose-key-000${i}`)).rejects.toMatchObject({ code: 'PURPOSE_REQUIRED' });
      }
      expect((await port.ensureSubAccount(withOwner('p-1', {}, 'anything at all'), 'purpose-key-0000')).status).toBe('open');
    });

    it('refuses a non-E.164 mobile, an invalid email, an empty name and a bad date of birth with VALIDATION_FAILED, claiming nothing', async () => {
      const port = make();
      const bad: Array<Partial<SubAccountOwner>> = [
        { mobile: '' },
        { mobile: '4155550123' },
        { mobile: '+1 415 555 0123' },
        { mobile: '+0123456789' },
        { email: 'not-an-email' },
        { email: '' },
        { firstName: '   ' },
        { lastName: '' },
        { dateOfBirth: '17/04/1991' },
        { dateOfBirth: '1991-02-31' },
      ];
      for (const [i, over] of bad.entries()) {
        await expect(port.ensureSubAccount(withOwner('p-1', over), `bad-input-${String(i).padStart(4, '0')}`), JSON.stringify(Object.keys(over))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      await expect(port.ensureSubAccount(invite('p-1', 'not-an-email'), 'bad-input-1000')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await port.ensureSubAccount(withOwner('p-1'), 'bad-input-0000')).status).toBe('open');
    });

    it('returns a refused owner as ownerStatus failed with the sub-account still made and open', async () => {
      const port = make();
      const r = await port.ensureSubAccount(withOwner('p-1', { email: opts.ownerFailEmail }), 'owner-key-0001');
      expect(r).toMatchObject({ status: 'open', ownerStatus: 'failed' });
      expect(r.subAccountRef).toBeTruthy();
      expect(await port.ensureSubAccount(withOwner('p-1', { email: opts.ownerFailEmail }), 'owner-key-0002')).toEqual(r);
      expect((await port.subAccount(r.subAccountRef)).status).toBe('open');
    });

    it('returns a frozen sub-account as status frozen', async () => {
      const port = make();
      const f = await port.ensureSubAccount(withOwner('p-f', { email: opts.frozenEmail }), 'frozen-key-0001');
      expect(f.status).toBe('frozen');
      expect((await port.subAccount(f.subAccountRef)).status).toBe('frozen');
    });

    it('answers a replay with the CURRENT status of the sub-account', async () => {
      const port = make();
      const a = await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
      opts.controls.setStatus(port, a.subAccountRef, 'closed');
      expect(await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001')).toEqual({ ...a, status: 'closed' });
      expect(await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0002')).toEqual({ ...a, status: 'closed' });
    });

    it('answers PROVIDER_UNAVAILABLE for an outage, claiming no key', async () => {
      const port = make();
      await expect(port.ensureSubAccount(withOwner('p-1', { email: opts.outageEmail }), 'outage-key-0001')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect((await port.ensureSubAccount(withOwner('p-1'), 'outage-key-0001')).status).toBe('open');
    });

    it('answers QUOTA_EXCEEDED for a create past the limit, before the key is looked at, creating nothing', async () => {
      const port = make();
      const a = await port.ensureSubAccount(withOwner('p-1'), 'quota-key-0001');
      opts.controls.setQuota(port, 1);
      // a new party, a new key; and a new party under a key already bound to another input: the quota answers first
      await expect(port.ensureSubAccount(withOwner('p-2', other), 'quota-key-0002')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      await expect(port.ensureSubAccount(withOwner('p-2', other), 'quota-key-0001')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      await expect(port.ensureSubAccount(withOwner('p-1', {}, 'Camp tuition'), 'quota-key-0003')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      // a repeat of an earlier key, and the same member and purpose under a new key, still answer their own refs
      expect(await port.ensureSubAccount(withOwner('p-1'), 'quota-key-0001')).toEqual(a);
      expect(await port.ensureSubAccount(withOwner('p-1'), 'quota-key-0004')).toEqual(a);
      // nothing was created and no refused key was claimed: raising the limit lets the same call through
      opts.controls.setQuota(port, 2);
      expect((await port.ensureSubAccount(withOwner('p-2', other), 'quota-key-0002')).subAccountRef).not.toBe(a.subAccountRef);
      await expect(port.ensureSubAccount(withOwner('p-3', { email: 'third@example.test', mobile: '+14155550125' }), 'quota-key-0005')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    });

    it('reads balance, hold and available as Money, with available = balance - hold', async () => {
      const port = make();
      const a = await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
      expect(await port.subAccount(a.subAccountRef)).toMatchObject({ status: 'open', balance: usd(0n), hold: usd(0n), available: usd(0n) });
      opts.controls.credit(port, a.subAccountRef, usd(10_000n));
      opts.controls.hold(port, a.subAccountRef, usd(2_500n));
      const v = await port.subAccount(a.subAccountRef);
      expect(typeof v.balance.minor).toBe('bigint');
      expect(v.balance).toEqual(usd(10_000n));
      expect(v.hold).toEqual(usd(2_500n));
      expect(v.available).toEqual(usd(7_500n));
      expect(v.available.minor).toBe(v.balance.minor - v.hold.minor);
    });

    it('answers UNKNOWN_ACCOUNT for an unknown ref, including the deposit account ref', async () => {
      const port = make();
      const a = await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
      await expect(port.subAccount('no-such-account')).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
      await expect(port.subAccount(a.accountRef)).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    });

    it('never puts the mobile, email, name or date of birth in an error (message, stack, JSON or string form) or a log line', async () => {
      const port = make();
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      try {
        const messages: string[] = [];
        const probe = async (p: Promise<unknown>) => {
          const e = await attempt(p);
          expect(e).toBeInstanceOf(MemberSubAccountError);
          const err = e as Error;
          messages.push(`${err.message} ${err.stack ?? ''} ${JSON.stringify(e)} ${String(e)}`);
        };
        await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
        await probe(port.ensureSubAccount(withOwner('p-3', { email: 'third@example.test', mobile: '+14155550166' }), 'ensure-key-0001')); // key conflict
        await probe(port.ensureSubAccount(withOwner('p-4', { mobile: '+1 415 555 9999 Sarah' }), 'ensure-key-0004'));
        await probe(port.ensureSubAccount(withOwner('p-5', { email: 'sarah@@example.test', mobile: '+14155550199' }), 'ensure-key-0005'));
        await probe(port.ensureSubAccount(withOwner('p-6', { dateOfBirth: '1991-04-17x', mobile: '+14155550198' }), 'ensure-key-0006'));
        await probe(port.ensureSubAccount(withOwner('p-7', { firstName: '', mobile: '+14155550197' }), 'ensure-key-0007'));
        await probe(port.ensureSubAccount(withOwner('p-8', { email: opts.outageEmail, mobile: '+14155550196' }), 'ensure-key-0008'));
        await probe(port.ensureSubAccount({ partyId: 'p-9', purpose: PURPOSE, owner: OWNER, inviteEmail: 'both@example.test' }, 'ensure-key-0009'));
        await probe(port.ensureSubAccount(invite('p-10', 'bad@@example.test'), 'ensure-key-0010'));
        await probe(port.ensureSubAccount(withOwner('p-11', {}, ''), 'ensure-key-0011'));
        opts.controls.setQuota(port, 1);
        await probe(port.ensureSubAccount(withOwner('p-12', { email: 'quota@example.test', mobile: '+14155550195' }), 'ensure-key-0012'));
        expect(messages.length).toBe(10);
        const secrets = [OWNER.mobile, OWNER.email, OWNER.dateOfBirth!, 'Sarah', 'Cohen', 'third@example.test', '+14155550166', '9999', 'sarah@@', '1991-04-17x', 'both@example.test', 'bad@@', 'quota@example.test', '4155550'];
        for (const m of messages) for (const secret of secrets) expect(m).not.toContain(secret);
        for (const s of spies) expect(s).not.toHaveBeenCalled();
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });

    it('does not return the date of birth or any personal data', async () => {
      const port = make();
      const a = await port.ensureSubAccount(withOwner('p-1'), 'ensure-key-0001');
      const text = JSON.stringify([a, await port.subAccount(a.subAccountRef)], (_k, v) => (typeof v === 'bigint' ? String(v) : v));
      for (const secret of ['1991', 'Sarah', 'Cohen', OWNER.email, OWNER.mobile]) expect(text).not.toContain(secret);
    });
  });
}
