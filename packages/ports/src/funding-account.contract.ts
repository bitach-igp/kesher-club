// FundingAccountPort contract (TST-WAL-002 at the port layer, T-0698). The member's contact and wallet account at the funding vendor.
import { describe, expect, it, vi } from 'vitest';
import { money } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { FundingAccountError, type EnsureAccountInput, type EnsuredAccount, type FundingAccountPort, type FundingAccountStatus, type FundingTransaction } from './funding-account.ts';

export interface FundingAccountContractOptions {
  /** A contact the vendor refuses (Failed): `ensureAccount` answers status `rejected` with no account. */
  rejectedEmail: string;
  /** A contact whose account the vendor freezes: status `frozen`. */
  frozenEmail: string;
  /** A contact whose request fails as PROVIDER_UNAVAILABLE, so a real adapter's outage path is exercised. */
  outageEmail: string;
  /** Simulator controls: put money on (or take it off) an account, hold part of it, set the account's status and the chapter's checking balance, and read or advance the clock. */
  controls: {
    credit: (port: FundingAccountPort, accountRef: string, amount: Money) => void;
    debit: (port: FundingAccountPort, accountRef: string, amount: Money) => void;
    hold: (port: FundingAccountPort, accountRef: string, amount: Money) => void;
    setStatus: (port: FundingAccountPort, accountRef: string, status: FundingAccountStatus) => void;
    setChecking: (port: FundingAccountPort, amount: Money) => void;
    advance: (port: FundingAccountPort, ms: number) => void;
    now: (port: FundingAccountPort) => Date;
  };
}

const PII = { email: 'sarah.cohen@example.test', mobile: '+14155550123', dateOfBirth: '1991-04-17', firstName: 'Sarah', lastName: 'Cohen' };

export function fundingAccountContract(name: string, make: () => FundingAccountPort, opts: FundingAccountContractOptions): void {
  describe(`FundingAccountPort contract: ${name}`, () => {
    const member = (partyId: string, over: Partial<EnsureAccountInput> = {}): EnsureAccountInput => ({ partyId, ...PII, ...over });
    const other = { email: 'other@example.test', mobile: '+14155550124' };
    const usd = (minor: bigint) => money(minor, 'USD');
    /** The account ref of a result that has one; fails the test for a contact with no account. */
    const acct = (r: EnsuredAccount): string => {
      if (!('accountRef' in r)) throw new Error(`expected an account, got a ${r.status} contact`);
      return r.accountRef;
    };
    const collect = async (it: AsyncIterable<FundingTransaction>): Promise<FundingTransaction[]> => {
      const out: FundingTransaction[] = [];
      for await (const t of it) out.push(t);
      return out;
    };
    const FAR = new Date('2100-01-01T00:00:00Z').toISOString();
    const EPOCH = new Date('2000-01-01T00:00:00Z').toISOString();

    it('ensures a contact and a wallet account, and the same key with the same input replays the same refs', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const b = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      expect(a.status).toBe('open');
      expect(a.contactRef).toBeTruthy();
      expect(acct(a)).toBeTruthy();
      expect(b).toEqual(a);
    });

    it('refuses a reused key with a different party, mobile, email, name or date of birth, and returns no refs', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const variants: Array<[string, EnsureAccountInput]> = [
        ['party', member('p-2')],
        ['mobile', member('p-1', { mobile: other.mobile })],
        ['email', member('p-1', { email: other.email })],
        ['name', member('p-1', { firstName: 'Dana' })],
        ['dateOfBirth', member('p-1', { dateOfBirth: '1990-01-01' })],
        ['party and mobile', member('p-2', { mobile: other.mobile, email: other.email })],
      ];
      for (const [what, input] of variants) {
        const r = await port.ensureAccount(input, 'ensure-key-0001').then(
          (v) => v,
          (e: unknown) => e,
        );
        expect(r, what).toBeInstanceOf(FundingAccountError);
        expect(r, what).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      }
      // the original binding is intact, and the other party's mobile was not claimed by the refused calls
      expect(await port.ensureAccount(member('p-1'), 'ensure-key-0001')).toEqual(a);
      expect((await port.ensureAccount(member('p-2', other), 'ensure-key-0002')).status).toBe('open');
    });

    it('answers the same refs for a second key for the same party with the same data', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const b = await port.ensureAccount(member('p-1'), 'ensure-key-0002');
      expect(b).toEqual(a);
      const c = await port.ensureAccount(member('p-2', other), 'ensure-key-0003');
      expect(c.contactRef).not.toBe(a.contactRef);
      expect(acct(c)).not.toBe(acct(a));
    });

    it('refuses the same party under a new key with a different mobile, name, email or date of birth as PARTY_CONFLICT', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const variants: Array<[string, Partial<EnsureAccountInput>]> = [
        ['mobile', { mobile: other.mobile }],
        ['name', { lastName: 'Levi' }],
        ['email', { email: other.email }],
        ['dateOfBirth', { dateOfBirth: '1990-01-01' }],
      ];
      for (const [i, [what, over]] of variants.entries()) {
        await expect(port.ensureAccount(member('p-1', over), `party-conflict-${i}-key`), what).rejects.toMatchObject({ code: 'PARTY_CONFLICT' });
      }
      expect(await port.ensureAccount(member('p-1'), 'ensure-key-0009')).toEqual(a);
      // and the refused new mobile was not claimed
      expect((await port.ensureAccount(member('p-2', other), 'ensure-key-0002')).status).toBe('open');
    });

    it('returns a refused contact as status rejected with its contactRef and no account, never throws for it', async () => {
      const port = make();
      const r = await port.ensureAccount(member('p-r', { email: opts.rejectedEmail }), 'ensure-key-rej1');
      expect(r.status).toBe('rejected');
      expect(r.contactRef).toBeTruthy();
      expect('accountRef' in r).toBe(false);
      // a replay answers the same, and the contact ref is not a wallet account
      expect(await port.ensureAccount(member('p-r', { email: opts.rejectedEmail }), 'ensure-key-rej2')).toEqual(r);
      await expect(port.account(r.contactRef)).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
      // the rejected contact still owns its mobile at the vendor
      await expect(port.ensureAccount(member('p-2', { email: other.email }), 'ensure-key-0002')).rejects.toMatchObject({ code: 'DUPLICATE_MOBILE' });
    });

    it('returns a frozen account as status frozen with both refs', async () => {
      const port = make();
      const f = await port.ensureAccount(member('p-f', { email: opts.frozenEmail }), 'ensure-key-frz1');
      expect(f.status).toBe('frozen');
      expect(acct(f)).toBeTruthy();
      expect((await port.account(acct(f))).status).toBe('frozen');
    });

    it('answers a replay with the CURRENT status of the account', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      opts.controls.setStatus(port, acct(a), 'closed');
      expect((await port.account(acct(a))).status).toBe('closed');
      expect(await port.ensureAccount(member('p-1'), 'ensure-key-0001')).toEqual({ ...a, status: 'closed' });
      expect(await port.ensureAccount(member('p-1'), 'ensure-key-0002')).toEqual({ ...a, status: 'closed' });
    });

    it('answers DUPLICATE_MOBILE for a different party whose mobile already exists, and leaves the first untouched', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      await expect(port.ensureAccount(member('p-2', { email: other.email }), 'ensure-key-0002')).rejects.toMatchObject({ code: 'DUPLICATE_MOBILE' });
      expect(await port.ensureAccount(member('p-1'), 'ensure-key-0003')).toEqual(a);
    });

    it('answers PROVIDER_UNAVAILABLE for an outage, claiming no key and no mobile', async () => {
      const port = make();
      await expect(port.ensureAccount(member('p-1', { email: opts.outageEmail }), 'outage-key-0001')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect((await port.ensureAccount(member('p-1'), 'outage-key-0001')).status).toBe('open');
    });

    it('refuses a missing or non-E.164 mobile, an empty name, an invalid email and a bad date of birth with VALIDATION_FAILED', async () => {
      const port = make();
      const bad: Array<Partial<EnsureAccountInput>> = [
        { mobile: '' },
        { mobile: '4155550123' },
        { mobile: '+1 415 555 0123' },
        { mobile: '+0123456789' },
        { mobile: '+1' },
        { firstName: '' },
        { firstName: '   ' },
        { lastName: '' },
        { email: 'not-an-email' },
        { email: '' },
        { dateOfBirth: '17/04/1991' },
        { dateOfBirth: '1991-02-31' },
      ];
      for (const [i, over] of bad.entries()) {
        await expect(port.ensureAccount(member('p-1', over), `bad-input-${String(i).padStart(4, '0')}`), JSON.stringify(Object.keys(over))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      // a refused request claims nothing: the valid one still works with the same key
      expect((await port.ensureAccount(member('p-1'), 'bad-input-0000')).status).toBe('open');
      const noMobile = { partyId: 'p-9', firstName: 'A', lastName: 'B', email: 'a@example.test' } as unknown as EnsureAccountInput;
      await expect(port.ensureAccount(noMobile, 'bad-input-9999')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('never puts the mobile, email, name or date of birth in an error (message, stack, JSON or string form) or a log line', async () => {
      const port = make();
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      try {
        const messages: string[] = [];
        const attempt = async (p: Promise<unknown>) => {
          try {
            await p;
          } catch (e) {
            expect(e).toBeInstanceOf(FundingAccountError);
            const err = e as Error;
            messages.push(`${err.message} ${err.stack ?? ''} ${JSON.stringify(e)} ${String(e)}`);
          }
        };
        await port.ensureAccount(member('p-1'), 'ensure-key-0001');
        await attempt(port.ensureAccount(member('p-2', { email: other.email }), 'ensure-key-0002')); // duplicate mobile
        await attempt(port.ensureAccount(member('p-1', { mobile: '+14155550177', email: 'changed@example.test' }), 'ensure-key-0003')); // party conflict
        await attempt(port.ensureAccount(member('p-3', { email: 'third@example.test', mobile: '+14155550166' }), 'ensure-key-0001')); // key conflict
        await attempt(port.ensureAccount(member('p-4', { mobile: '+1 415 555 9999 Sarah' }), 'ensure-key-0004'));
        await attempt(port.ensureAccount(member('p-5', { email: 'sarah@@example.test', mobile: '+14155550199' }), 'ensure-key-0005'));
        await attempt(port.ensureAccount(member('p-6', { dateOfBirth: '1991-04-17x', mobile: '+14155550198' }), 'ensure-key-0006'));
        await attempt(port.ensureAccount(member('p-7', { firstName: '', mobile: '+14155550197' }), 'ensure-key-0007'));
        await attempt(port.ensureAccount(member('p-8', { email: opts.outageEmail, mobile: '+14155550196' }), 'ensure-key-0008'));
        expect(messages.length).toBe(8);
        const secrets = [PII.mobile, PII.email, PII.dateOfBirth, 'Sarah', 'Cohen', other.email, '+14155550177', 'changed@example.test', 'third@example.test', '+14155550166', '9999', 'sarah@@', '1991-04-17x', '4155550'];
        for (const m of messages) for (const secret of secrets) expect(m).not.toContain(secret);
        for (const s of spies) expect(s).not.toHaveBeenCalled();
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });

    it('does not return the date of birth', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      expect(JSON.stringify(a)).not.toContain('1991');
      expect(JSON.stringify(await port.account(acct(a)), (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('1991');
    });

    it('reads balance, hold and available as Money, with available = balance - hold', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const empty = await port.account(acct(a));
      expect(empty).toMatchObject({ status: 'open', balance: usd(0n), hold: usd(0n), available: usd(0n) });
      opts.controls.credit(port, acct(a), usd(10_000n));
      opts.controls.hold(port, acct(a), usd(2_500n));
      const v = await port.account(acct(a));
      expect(typeof v.balance.minor).toBe('bigint');
      expect(v.balance).toEqual(usd(10_000n));
      expect(v.hold).toEqual(usd(2_500n));
      expect(v.available).toEqual(usd(7_500n));
      expect(v.available.minor).toBe(v.balance.minor - v.hold.minor);
    });

    it('answers UNKNOWN_ACCOUNT for an unknown ref on account() and transactions()', async () => {
      const port = make();
      await expect(port.account('no-such-account')).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
      await expect(collect(port.transactions({ accountRef: 'no-such-account', from: EPOCH, to: FAR }))).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    });

    it('agrees between account(), chapter() and transactions(): a 100 cent credit is balance +100 and one credit row (and carries no payment id)', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      opts.controls.credit(port, acct(a), usd(100n));
      expect((await port.account(acct(a))).balance).toEqual(usd(100n));
            const rows = await collect(port.transactions({ accountRef: acct(a), from: EPOCH, to: FAR }));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'credit', amount: usd(100n) });
      expect(rows[0]!.transactionRef).toBeTruthy();
      expect('collectPaymentId' in rows[0]!).toBe(false);
      expect(Number.isNaN(Date.parse(rows[0]!.postedAt))).toBe(false);
      opts.controls.debit(port, acct(a), usd(40n));
      expect((await port.account(acct(a))).balance).toEqual(usd(60n));
      const all = await collect(port.transactions({ accountRef: acct(a), from: EPOCH, to: FAR }));
      expect(all.map((t) => t.kind).sort()).toEqual(['credit', 'debit']);
      expect(new Set(all.map((t) => t.transactionRef)).size).toBe(2);
    });

    it('takes from inclusive and to exclusive, and lists each row once', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const t0 = opts.controls.now(port);
      opts.controls.credit(port, acct(a), usd(1n));
      opts.controls.advance(port, 60_000);
      const t1 = opts.controls.now(port);
      opts.controls.credit(port, acct(a), usd(2n));
      opts.controls.advance(port, 60_000);
      const t2 = opts.controls.now(port);
      opts.controls.credit(port, acct(a), usd(3n));
      const amounts = async (from: Date, to: Date) => (await collect(port.transactions({ accountRef: acct(a), from: from.toISOString(), to: to.toISOString() }))).map((t) => t.amount.minor).sort();
      expect(await amounts(t0, t2)).toEqual([1n, 2n]); // t2 excluded
      expect(await amounts(t1, t2)).toEqual([2n]); // t1 included
      expect(await amounts(t1, new Date(t2.getTime() + 1))).toEqual([2n, 3n]);
      expect(await amounts(new Date(t2.getTime() + 1), new Date(t2.getTime() + 1000))).toEqual([]);
      const once = await collect(port.transactions({ accountRef: acct(a), from: EPOCH, to: FAR }));
      expect(once).toHaveLength(3);
      expect(new Set(once.map((t) => t.transactionRef)).size).toBe(3);
    });

    it('lists only the asked account\'s rows', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const b = await port.ensureAccount(member('p-2', other), 'ensure-key-0002');
      opts.controls.credit(port, acct(a), usd(5n));
      opts.controls.credit(port, acct(b), usd(7n));
      const rows = await collect(port.transactions({ accountRef: acct(b), from: EPOCH, to: FAR }));
      expect(rows.map((t) => t.amount.minor)).toEqual([7n]);
    });

    it('reads the chapter\'s checking balance as Money, independent of the wallets', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      opts.controls.setChecking(port, usd(1_000_000n));
      opts.controls.credit(port, acct(a), usd(100n));
      const c = await port.chapter();
      expect(typeof c.checking.minor).toBe('bigint');
      expect(c.checking).toEqual(usd(1_000_000n));
      expect('held' in c).toBe(false);
    });
  });
}
