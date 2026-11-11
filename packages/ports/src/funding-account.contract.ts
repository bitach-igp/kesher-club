// FundingAccountPort contract (TST-WAL-002 at the port layer, T-0698). The member's contact and wallet account at the funding vendor.
import { describe, expect, it, vi } from 'vitest';
import { money } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { FundingAccountError, type EnsureAccountInput, type FundingAccountPort, type FundingTransaction } from './funding-account.ts';

export interface FundingAccountContractOptions {
  /** A contact the vendor refuses: `ensureAccount` answers status `rejected`. */
  rejectedEmail: string;
  /** A contact whose account the vendor freezes: status `frozen`. */
  frozenEmail: string;
  /** Simulator controls: put money on (or take it off) an account, hold part of it, and read or set the clock. */
  controls: {
    credit: (port: FundingAccountPort, accountRef: string, amount: Money, collectPaymentId?: string) => void;
    debit: (port: FundingAccountPort, accountRef: string, amount: Money) => void;
    hold: (port: FundingAccountPort, accountRef: string, amount: Money) => void;
    advance: (port: FundingAccountPort, ms: number) => void;
    now: (port: FundingAccountPort) => Date;
  };
}

const PII = { email: 'sarah.cohen@example.test', mobile: '+14155550123', dateOfBirth: '1991-04-17', firstName: 'Sarah', lastName: 'Cohen' };

export function fundingAccountContract(name: string, make: () => FundingAccountPort, opts: FundingAccountContractOptions): void {
  describe(`FundingAccountPort contract: ${name}`, () => {
    const member = (partyId: string, over: Partial<EnsureAccountInput> = {}): EnsureAccountInput => ({ partyId, ...PII, ...over });
    const usd = (minor: bigint) => money(minor, 'USD');
    const collect = async (it: AsyncIterable<FundingTransaction>): Promise<FundingTransaction[]> => {
      const out: FundingTransaction[] = [];
      for await (const t of it) out.push(t);
      return out;
    };
    const FAR = new Date('2100-01-01T00:00:00Z').toISOString();
    const EPOCH = new Date('2000-01-01T00:00:00Z').toISOString();

    it('ensures a contact and a wallet account, and the same key answers the same refs', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const b = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      expect(a.status).toBe('open');
      expect(a.contactRef).toBeTruthy();
      expect(a.accountRef).toBeTruthy();
      expect(b).toEqual(a);
    });

    it('is per member, not per call: a second key for the same party answers the same refs', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const b = await port.ensureAccount(member('p-1'), 'ensure-key-0002');
      expect(b.contactRef).toBe(a.contactRef);
      expect(b.accountRef).toBe(a.accountRef);
      const c = await port.ensureAccount(member('p-2', { email: 'other@example.test', mobile: '+14155550124' }), 'ensure-key-0003');
      expect(c.accountRef).not.toBe(a.accountRef);
      expect(c.contactRef).not.toBe(a.contactRef);
    });

    it('returns a refused contact as status rejected and a frozen account as status frozen, never throws for them', async () => {
      const port = make();
      const r = await port.ensureAccount(member('p-r', { email: opts.rejectedEmail }), 'ensure-key-rej1');
      expect(r.status).toBe('rejected');
      const f = await port.ensureAccount(member('p-f', { email: opts.frozenEmail, mobile: '+14155550125' }), 'ensure-key-frz1');
      expect(f.status).toBe('frozen');
      expect((await port.account(f.accountRef)).status).toBe('frozen');
    });

    it('answers DUPLICATE_MOBILE for a second party with the same mobile, and leaves the first untouched', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      await expect(port.ensureAccount(member('p-2', { email: 'other@example.test' }), 'ensure-key-0002')).rejects.toMatchObject({ code: 'DUPLICATE_MOBILE' });
      expect(await port.ensureAccount(member('p-1'), 'ensure-key-0003')).toEqual(a);
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

    it('never puts the mobile, email, name or date of birth in an error message or a log line', async () => {
      const port = make();
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      try {
        const messages: string[] = [];
        const attempt = async (p: Promise<unknown>) => {
          try {
            await p;
          } catch (e) {
            expect(e).toBeInstanceOf(FundingAccountError);
            messages.push(`${(e as Error).message} ${(e as Error).stack ?? ''}`);
          }
        };
        await port.ensureAccount(member('p-1'), 'ensure-key-0001');
        await attempt(port.ensureAccount(member('p-2', { email: 'other@example.test' }), 'ensure-key-0002')); // duplicate mobile
        await attempt(port.ensureAccount(member('p-3', { mobile: '+1 415 555 9999 Sarah' }), 'ensure-key-0003'));
        await attempt(port.ensureAccount(member('p-4', { email: 'sarah@@example.test', mobile: '+14155550199' }), 'ensure-key-0004'));
        await attempt(port.ensureAccount(member('p-5', { dateOfBirth: '1991-04-17x', mobile: '+14155550198' }), 'ensure-key-0005'));
        await attempt(port.ensureAccount(member('p-6', { firstName: '', mobile: '+14155550197' }), 'ensure-key-0006'));
        expect(messages.length).toBe(5);
        for (const m of messages) for (const secret of [PII.mobile, PII.email, PII.dateOfBirth, 'Sarah', 'Cohen', 'other@example.test', '9999', 'sarah@@', '1991-04-17x']) expect(m).not.toContain(secret);
        for (const s of spies) expect(s).not.toHaveBeenCalled();
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });

    it('does not return the date of birth', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      expect(JSON.stringify(a)).not.toContain('1991');
      expect(JSON.stringify(await port.account(a.accountRef), (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('1991');
    });

    it('reads balance, hold and available as Money, with available = balance - hold', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const empty = await port.account(a.accountRef);
      expect(empty).toMatchObject({ status: 'open', balance: usd(0n), hold: usd(0n), available: usd(0n) });
      opts.controls.credit(port, a.accountRef, usd(10_000n));
      opts.controls.hold(port, a.accountRef, usd(2_500n));
      const v = await port.account(a.accountRef);
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

    it('agrees between account(), chapter() and transactions(): a 100 cent credit is balance +100 and one credit row', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const before = await port.chapter();
      opts.controls.credit(port, a.accountRef, usd(100n), 'cp_1');
      const after = await port.chapter();
      expect((await port.account(a.accountRef)).balance).toEqual(usd(100n));
      expect(after.checking.minor - before.checking.minor).toBe(100n);
      expect(typeof after.held.minor).toBe('bigint');
      const rows = await collect(port.transactions({ accountRef: a.accountRef, from: EPOCH, to: FAR }));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'credit', amount: usd(100n), collectPaymentId: 'cp_1' });
      expect(rows[0]!.transactionRef).toBeTruthy();
      expect(Number.isNaN(Date.parse(rows[0]!.postedAt))).toBe(false);
      opts.controls.debit(port, a.accountRef, usd(40n));
      expect((await port.account(a.accountRef)).balance).toEqual(usd(60n));
      const all = await collect(port.transactions({ accountRef: a.accountRef, from: EPOCH, to: FAR }));
      expect(all.map((t) => t.kind).sort()).toEqual(['credit', 'debit']);
      expect(new Set(all.map((t) => t.transactionRef)).size).toBe(2);
    });

    it('takes from inclusive and to exclusive, and lists each row once', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const t0 = opts.controls.now(port);
      opts.controls.credit(port, a.accountRef, usd(1n));
      opts.controls.advance(port, 60_000);
      const t1 = opts.controls.now(port);
      opts.controls.credit(port, a.accountRef, usd(2n));
      opts.controls.advance(port, 60_000);
      const t2 = opts.controls.now(port);
      opts.controls.credit(port, a.accountRef, usd(3n));
      const amounts = async (from: Date, to: Date) => (await collect(port.transactions({ accountRef: a.accountRef, from: from.toISOString(), to: to.toISOString() }))).map((t) => t.amount.minor).sort();
      expect(await amounts(t0, t2)).toEqual([1n, 2n]); // t2 excluded
      expect(await amounts(t1, t2)).toEqual([2n]); // t1 included
      expect(await amounts(t1, new Date(t2.getTime() + 1))).toEqual([2n, 3n]);
      expect(await amounts(new Date(t2.getTime() + 1), new Date(t2.getTime() + 1000))).toEqual([]);
      const once = await collect(port.transactions({ accountRef: a.accountRef, from: EPOCH, to: FAR }));
      expect(once).toHaveLength(3);
      expect(new Set(once.map((t) => t.transactionRef)).size).toBe(3);
    });

    it('lists only the asked account\'s rows', async () => {
      const port = make();
      const a = await port.ensureAccount(member('p-1'), 'ensure-key-0001');
      const b = await port.ensureAccount(member('p-2', { email: 'other@example.test', mobile: '+14155550124' }), 'ensure-key-0002');
      opts.controls.credit(port, a.accountRef, usd(5n));
      opts.controls.credit(port, b.accountRef, usd(7n));
      const rows = await collect(port.transactions({ accountRef: b.accountRef, from: EPOCH, to: FAR }));
      expect(rows.map((t) => t.amount.minor)).toEqual([7n]);
    });
  });
}
