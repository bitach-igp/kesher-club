// MirrorPort contract (T-0718, TST-WAL-003, TST-LED-003). Every adapter:
// - books 1 to 10 USD legs per batch between a member's account and the chapter checking account, one result per leg
//   in order, each echoing the leg the vendor holds; ILS, zero, negative amounts, an empty or oversize batch, an empty
//   memo, a short key or a key or memo repeated inside the batch refuse the whole batch (VALIDATION_FAILED) before the provider;
// - books a key once: a replay answers `booked` with the same paymentRef and the FIRST leg, even when the new body differs;
// - refuses one leg without stopping the others (continue-on-error), with a code from the closed set. A refusal the vendor
//   persists (a Rejected overdraw) has a paymentRef, is listed as failed and is found by memo; a refusal before
//   persistence (validation, unknown or unavailable account) has no paymentRef, is never listed and reads not_found;
// - refuses a memo over 80 printable ASCII characters (the vendor never sees it);
// - finds a leg by chapter and memo without moving anything (the vendor has no lookup by key), so a lost answer is
//   recovered by memo before any resend; two payments with one memo are `ambiguous`;
// - maps an item the vendor calls Rejected to `refused` and a Pending one to `unknown`, never `booked`;
// - answers OUTCOME_UNKNOWN when a request may have booked and the answer is lost; PROVIDER_UNAVAILABLE only when nothing left;
// - reports balances (status, balance, hold, available) in bigint cents, lists the chapter's book payments with the
//   paymentRef bookBatch returned and the account movements, each exactly once across pages.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { type MirrorAccountStatus, type MirrorLeg, type MirrorMovement, type MirrorPayment, type MirrorPort, type MirrorReasonCode } from './mirror.ts';

export interface MirrorContractOptions<P extends MirrorPort> {
  /** The chapter whose checking account is on one side of every leg. */
  chapterRef: string;
  /** Opens the chapter's checking account (once) and a member's account, with `minor` USD cents in each. */
  seed(port: P, input: { accountRef: string; accountMinor: bigint; checkingMinor: bigint }): Promise<void>;
  /** The vendor refuses the leg with this key with this code, once it is sent. */
  refuse(port: P, key: string, code: MirrorReasonCode): void;
  /** The vendor answers the leg with this key as an item whose paymentStatus is Rejected or Pending. */
  vendorStatus(port: P, key: string, status: 'Rejected' | 'Pending'): void;
  /** The vendor books the leg with this key, then the answer is lost (`unknown`). */
  loseAnswer(port: P, key: string): void;
  /** The vendor books the next request, then its answer is lost. */
  loseBatch(port: P): void;
  setStatus(port: P, ref: string, status: MirrorAccountStatus): void;
  outage(port: P, on: boolean): void;
}

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2027-01-01T00:00:00Z');

export function mirrorContract<P extends MirrorPort>(name: string, make: () => P, opts: MirrorContractOptions<P>): void {
  const chapterRef = opts.chapterRef;
  const leg = (key: string, over: Partial<MirrorLeg> = {}): MirrorLeg => ({ direction: 'from_checking', accountRef: 'acct_m1', amount: money(2_500n, 'USD'), memo: `KC-${key}`, idempotencyKey: key, ...over });
  const seeded = async (accountMinor = 10_000n, checkingMinor = 10_000n): Promise<P> => {
    const port = make();
    await opts.seed(port, { accountRef: 'acct_m1', accountMinor, checkingMinor });
    await opts.seed(port, { accountRef: 'acct_m2', accountMinor, checkingMinor });
    return port;
  };
  const bal = async (port: P, ref = 'acct_m1') => (await port.accountBalance(ref)).balance;

  describe(`MirrorPort contract: ${name}`, () => {
    it('books a leg each way, echoes the stored leg and moves both balances in bigint', async () => {
      const port = await seeded();
      const [out, back] = await port.bookBatch([leg('key-leg-0001', { direction: 'from_checking' }), leg('key-leg-0002', { direction: 'to_checking', amount: money(1_000n, 'USD') })], chapterRef);
      expect(out).toMatchObject({ status: 'booked', leg: { accountRef: 'acct_m1', direction: 'from_checking', amount: money(2_500n, 'USD'), memo: 'KC-key-leg-0001' } });
      expect(out?.paymentRef).toBeTruthy();
      expect(back).toMatchObject({ status: 'booked', leg: { direction: 'to_checking', amount: money(1_000n, 'USD') } });
      expect(back?.paymentRef).not.toBe(out?.paymentRef);
      expect(await bal(port)).toBe(10_000n + 2_500n - 1_000n);
      expect((await port.checkingBalance(chapterRef)).balance).toBe(10_000n - 2_500n + 1_000n);
      expect(await port.accountBalance('acct_m1')).toMatchObject({ status: 'open', hold: 0n, available: 11_500n });
    });

    it('books a key once and answers the same payment on a replay', async () => {
      const port = await seeded();
      const [a] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      const [b] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      expect(b).toEqual(a);
      expect(a?.status).toBe('booked');
      expect(await bal(port)).toBe(12_500n);
    });

    it('a reused key with a DIFFERENT body answers the ORIGINAL leg, and the caller can see the difference', async () => {
      const port = await seeded();
      const sent = leg('key-leg-0001');
      const [first] = await port.bookBatch([sent], chapterRef);
      const other = leg('key-leg-0001', { amount: money(9_999n, 'USD'), accountRef: 'acct_m2', direction: 'to_checking', memo: 'KC-another-memo' });
      const [again] = await port.bookBatch([other], chapterRef);
      expect(again).toEqual(first);
      expect(again?.leg?.amount).toEqual(money(2_500n, 'USD'));
      expect(again?.leg).not.toEqual({ accountRef: other.accountRef, direction: other.direction, amount: other.amount, memo: other.memo });
      expect(again?.leg?.amount.minor).not.toBe(other.amount.minor);
      expect(await bal(port)).toBe(12_500n);
      expect(await bal(port, 'acct_m2')).toBe(10_000n);
      // The second memo was never booked.
      expect(await port.readBack({ chapterRef, memo: 'KC-another-memo' })).toEqual({ status: 'not_found' });
    });

    it('refuses the whole batch before any call for ILS, zero, negative, empty or oversize, a bad key, memo or account, and repeats', async () => {
      const port = await seeded();
      const good = leg('key-leg-0001');
      const bad: MirrorLeg[][] = [
        [good, leg('key-leg-0002', { amount: money(500n, 'ILS') })],
        [good, leg('key-leg-0002', { amount: money(0n, 'USD') })],
        [good, leg('key-leg-0002', { amount: money(-5n, 'USD') })],
        [good, leg('key-leg-0002', { amount: { minor: 5 as unknown as bigint, currency: 'USD' } })],
        [],
        Array.from({ length: 11 }, (_, i) => leg(`key-leg-${String(i).padStart(4, '0')}`, { amount: money(1n, 'USD') })),
        [leg('short')],
        [leg('key leg 0001 with spaces')],
        [good, leg('key-leg-0002', { memo: '' })],
        [good, leg('key-leg-0002', { accountRef: '' })],
        [good, leg('key-leg-0001', { memo: 'KC-other' })], // the same key twice
        [good, leg('key-leg-0002', { memo: good.memo })], // the same memo twice
      ];
      for (const legs of bad) await expect(port.bookBatch(legs, chapterRef)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // Nothing moved, not even the valid first leg of a refused batch.
      expect(await bal(port)).toBe(10_000n);
      expect(await port.readBack({ chapterRef, memo: good.memo })).toEqual({ status: 'not_found' });
    });

    it('takes up to 10 legs in one batch, one result per leg in order', async () => {
      const port = await seeded(0n, 100_000n);
      const legs = Array.from({ length: 10 }, (_, i) => leg(`key-leg-${String(i).padStart(4, '0')}`, { amount: money(BigInt(i + 1), 'USD') }));
      const res = await port.bookBatch(legs, chapterRef);
      expect(res.map((r) => r.status)).toEqual(Array(10).fill('booked'));
      expect(res.map((r) => r.leg?.memo)).toEqual(legs.map((l) => l.memo));
      expect(await bal(port)).toBe(55n);
    });

    it('refuses a memo over 80 characters or outside printable ASCII for that leg only; the vendor never sees it', async () => {
      const port = await seeded();
      const long = 'x'.repeat(81);
      const res = await port.bookBatch([leg('key-leg-0001', { memo: long }), leg('key-leg-0002', { memo: 'שלום' }), leg('key-leg-0003', { memo: 'x'.repeat(80) })], chapterRef);
      expect(res.map((r) => r.status)).toEqual(['refused', 'refused', 'booked']);
      expect(res[0]?.reasonCode).toBe('VALIDATION_ERROR');
      expect(await port.readBack({ chapterRef, memo: long })).toEqual({ status: 'not_found' });
      expect(await port.readBack({ chapterRef, memo: 'שלום' })).toEqual({ status: 'not_found' });
      expect(await port.readBack({ chapterRef, memo: 'x'.repeat(80) })).toMatchObject({ status: 'found', result: { status: 'booked' } });
    });

    it('continues on error: an overdraft, a frozen or closed account and an unknown account refuse their own leg only', async () => {
      const port = await seeded(1_000n, 10_000n);
      opts.setStatus(port, 'acct_m2', 'frozen');
      await opts.seed(port, { accountRef: 'acct_m3', accountMinor: 0n, checkingMinor: 10_000n });
      opts.setStatus(port, 'acct_m3', 'closed');
      const res = await port.bookBatch(
        [
          leg('key-leg-0001', { direction: 'to_checking', amount: money(5_000n, 'USD') }),
          leg('key-leg-0002', { accountRef: 'acct_m2' }),
          leg('key-leg-0003', { accountRef: 'acct_nope' }),
          leg('key-leg-0004', { amount: money(100_000n, 'USD') }),
          leg('key-leg-0005', { accountRef: 'acct_m3' }),
          leg('key-leg-0006'),
        ],
        chapterRef,
      );
      expect(res.map((r) => [r.status, r.reasonCode])).toEqual([
        ['refused', 'INSUFFICIENT_FUNDS'],
        ['refused', 'ACCOUNT_UNAVAILABLE'],
        ['refused', 'NOT_FOUND'],
        ['refused', 'INSUFFICIENT_FUNDS'],
        ['refused', 'ACCOUNT_UNAVAILABLE'],
        ['booked', undefined],
      ]);
      expect(await bal(port)).toBe(3_500n);
      expect(await port.accountBalance('acct_m2')).toMatchObject({ status: 'frozen' });
      expect(await port.accountBalance('acct_m3')).toMatchObject({ status: 'closed' });
      // Refused before persistence (unavailable, unknown): no payment, nothing to read back or list.
      for (const k of ['key-leg-0002', 'key-leg-0003', 'key-leg-0005']) {
        expect(res.find((r) => r.leg?.memo === `KC-${k}`)).toBeUndefined();
        expect(await port.readBack({ chapterRef, memo: `KC-${k}` })).toEqual({ status: 'not_found' });
      }
      expect(res[1]?.paymentRef).toBeUndefined();
      expect(res[2]?.paymentRef).toBeUndefined();
      const listed: string[] = [];
      for await (const p of port.payments({ chapterRef, from: FROM, to: TO })) listed.push(p.memo);
      expect(listed.sort()).toEqual(['KC-key-leg-0001', 'KC-key-leg-0004', 'KC-key-leg-0006']);
      // A persisted refusal (the overdraw) has a payment and is final for its key: a replay answers the same refusal.
      expect(res[0]?.paymentRef).toBeTruthy();
      const [again] = await port.bookBatch([leg('key-leg-0001', { direction: 'to_checking', amount: money(5_000n, 'USD') })], chapterRef);
      expect(again).toMatchObject({ status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' });
    });

    it('a persisted refusal (PAYMENT_FAILED) has a payment, is listed as failed and is found by memo; an unpersisted one (VALIDATION_ERROR) is none of these', async () => {
      const port = await seeded();
      opts.refuse(port, 'key-leg-0001', 'PAYMENT_FAILED');
      opts.refuse(port, 'key-leg-0002', 'VALIDATION_ERROR');
      const [persisted, unpersisted] = await port.bookBatch([leg('key-leg-0001'), leg('key-leg-0002')], chapterRef);
      expect(persisted).toMatchObject({ status: 'refused', reasonCode: 'PAYMENT_FAILED' });
      expect(persisted?.paymentRef).toBeTruthy();
      expect(unpersisted).toMatchObject({ status: 'refused', reasonCode: 'VALIDATION_ERROR' });
      expect(await port.readBack({ chapterRef, memo: 'KC-key-leg-0001' })).toMatchObject({ status: 'found', result: { status: 'refused', reasonCode: 'PAYMENT_FAILED', paymentRef: persisted?.paymentRef } });
      expect(await port.readBack({ chapterRef, memo: 'KC-key-leg-0002' })).toEqual({ status: 'not_found' });
      const listed: MirrorPayment[] = [];
      for await (const p of port.payments({ chapterRef, from: FROM, to: TO })) listed.push(p);
      expect(listed.map((p) => [p.paymentRef, p.status])).toEqual([[persisted?.paymentRef, 'failed']]);
      expect(await bal(port)).toBe(10_000n);
    });

    it('maps a vendor item Rejected (InsufficientFunds) to a persisted refusal, and a Pending or unrecognised one to unknown, never booked', async () => {
      const port = await seeded();
      opts.vendorStatus(port, 'key-leg-0001', 'Rejected');
      opts.vendorStatus(port, 'key-leg-0002', 'Pending');
      const [rejected, pending] = await port.bookBatch([leg('key-leg-0001'), leg('key-leg-0002', { accountRef: 'acct_m2' })], chapterRef);
      expect(rejected).toMatchObject({ status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' });
      expect(rejected?.paymentRef).toBeTruthy();
      expect(pending?.status).toBe('unknown');
      expect(await bal(port)).toBe(10_000n);
      expect(await port.readBack({ chapterRef, memo: 'KC-key-leg-0001' })).toMatchObject({ status: 'found', result: { status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS', paymentRef: rejected?.paymentRef } });
      expect(await port.readBack({ chapterRef, memo: 'KC-key-leg-0002' })).toMatchObject({ status: 'found', result: { status: 'unknown' } });
      const listed: MirrorPayment[] = [];
      for await (const p of port.payments({ chapterRef, from: FROM, to: TO })) listed.push(p);
      expect(listed.find((p) => p.paymentRef === rejected?.paymentRef)).toMatchObject({ status: 'failed', memo: 'KC-key-leg-0001' });
    });

    it('recovers a leg whose answer was lost by reading it back by memo, moving nothing', async () => {
      const port = await seeded();
      expect(await port.readBack({ chapterRef, memo: 'KC-key-leg-0001' })).toEqual({ status: 'not_found' });
      opts.loseAnswer(port, 'key-leg-0001');
      const [lost] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      expect(lost?.status).toBe('unknown');
      const read = await port.readBack({ chapterRef, memo: 'KC-key-leg-0001' });
      expect(read).toMatchObject({ status: 'found', result: { status: 'booked', leg: { amount: money(2_500n, 'USD'), accountRef: 'acct_m1' } } });
      expect(await port.readBack({ chapterRef, memo: 'KC-key-leg-0001' })).toEqual(read);
      expect(await bal(port)).toBe(12_500n);
      // The resend of the same key and body books nothing more and answers the vendor's own payment.
      const [resent] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      expect(resent).toMatchObject({ status: 'booked', paymentRef: read.status === 'found' ? read.result.paymentRef : 'x' });
      expect(await bal(port)).toBe(12_500n);
    });

    it('answers ambiguous, with every candidate, when two payments carry one memo; the leg and since narrow the match', async () => {
      const port = await seeded();
      const [first] = await port.bookBatch([leg('key-leg-0001', { memo: 'KC-same' })], chapterRef);
      const [second] = await port.bookBatch([leg('key-leg-0002', { memo: 'KC-same', amount: money(700n, 'USD') })], chapterRef);
      const read = await port.readBack({ chapterRef, memo: 'KC-same' });
      expect(read.status).toBe('ambiguous');
      if (read.status === 'ambiguous') expect(read.candidates.map((c) => c.paymentRef).sort()).toEqual([first?.paymentRef, second?.paymentRef].sort());
      expect(await port.readBack({ chapterRef, memo: 'KC-same', amount: money(700n, 'USD') })).toMatchObject({ status: 'found', result: { paymentRef: second?.paymentRef } });
      expect(await port.readBack({ chapterRef, memo: 'KC-same', amount: money(1n, 'USD') })).toEqual({ status: 'not_found' });
      expect(await port.readBack({ chapterRef, memo: 'KC-same', accountRef: 'acct_m2' })).toEqual({ status: 'not_found' });
      expect(await port.readBack({ chapterRef, memo: 'KC-same', direction: 'to_checking' })).toEqual({ status: 'not_found' });
      expect(await port.readBack({ chapterRef, memo: 'KC-same', since: new Date('2099-01-01T00:00:00Z') })).toEqual({ status: 'not_found' });
      expect(await port.readBack({ chapterRef, memo: 'KC-same', since: new Date('2000-01-01T00:00:00Z') })).toMatchObject({ status: 'ambiguous' });
    });

    it('a refused leg retried under a new key and the same memo is ambiguous, with both candidates to act on; a new memo is not', async () => {
      const port = await seeded(10_000n, 1_000n);
      const [refused] = await port.bookBatch([leg('key-leg-0001', { amount: money(5_000n, 'USD') })], chapterRef); // overdraws checking
      expect(refused).toMatchObject({ status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' });
      await port.bookBatch([leg('key-leg-0002', { memo: 'KC-key-leg-0001', amount: money(500n, 'USD') })], chapterRef);
      const read = await port.readBack({ chapterRef, memo: 'KC-key-leg-0001' });
      expect(read.status).toBe('ambiguous');
      if (read.status === 'ambiguous') expect(read.candidates.map((c) => c.status).sort()).toEqual(['booked', 'refused']);
      await port.bookBatch([leg('key-leg-0003', { memo: 'KC-key-leg-0001-a2', amount: money(500n, 'USD') })], chapterRef);
      expect(await port.readBack({ chapterRef, memo: 'KC-key-leg-0001-a2' })).toMatchObject({ status: 'found', result: { status: 'booked' } });
    });

    it('a request whose answer is lost is OUTCOME_UNKNOWN; its legs are found by memo and a resend of the same keys books nothing more', async () => {
      const port = await seeded();
      const legs = [leg('key-leg-0001'), leg('key-leg-0002', { accountRef: 'acct_m2' })];
      opts.loseBatch(port);
      await expect(port.bookBatch(legs, chapterRef)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      for (const l of legs) expect(await port.readBack({ chapterRef, memo: l.memo })).toMatchObject({ status: 'found', result: { status: 'booked' } });
      const res = await port.bookBatch(legs, chapterRef);
      expect(res.map((r) => r.status)).toEqual(['booked', 'booked']);
      expect(await bal(port)).toBe(12_500n);
      expect(await bal(port, 'acct_m2')).toBe(12_500n);
    });

    it('keeps balances past 2^53 exact', async () => {
      const big = 9_007_199_254_740_993n;
      const port = await seeded(big, big);
      await port.bookBatch([leg('key-leg-0001', { amount: money(2n, 'USD') })], chapterRef);
      expect(await bal(port)).toBe(big + 2n);
      expect((await port.checkingBalance(chapterRef)).balance).toBe(big - 2n);
    });

    it('lists the chapter payments once across pages with the paymentRef bookBatch returned, failed ones too', async () => {
      const port = await seeded();
      const legs = Array.from({ length: 5 }, (_, i) => leg(`key-leg-${String(i).padStart(4, '0')}`, { amount: money(BigInt(100 + i), 'USD'), direction: i % 2 ? 'to_checking' : 'from_checking' }));
      const res = await port.bookBatch(legs, chapterRef);
      await port.bookBatch(legs.slice(0, 2), chapterRef); // a replay adds nothing
      opts.refuse(port, 'key-leg-0009', 'PAYMENT_FAILED');
      const [failed] = await port.bookBatch([leg('key-leg-0009')], chapterRef);
      const rows: MirrorPayment[] = [];
      for await (const p of port.payments({ chapterRef, from: FROM, to: TO })) rows.push(p);
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map((r) => r.paymentRef)).size).toBe(6);
      expect(rows.slice(0, 5).map((r) => r.paymentRef)).toEqual(res.map((r) => r.paymentRef));
      expect(rows[0]).toMatchObject({ status: 'sent', amount: money(100n, 'USD'), memo: 'KC-key-leg-0000', sourceAccountRef: chapterRef, destinationAccountRef: 'acct_m1' });
      expect(rows[1]).toMatchObject({ sourceAccountRef: 'acct_m1', destinationAccountRef: chapterRef });
      expect(rows[5]).toMatchObject({ status: 'failed' });
      expect(rows[5]?.paymentRef).toBe(failed?.paymentRef);
      const none: MirrorPayment[] = [];
      for await (const p of port.payments({ chapterRef, from: new Date('2020-01-01T00:00:00Z'), to: new Date('2020-02-01T00:00:00Z') })) none.push(p);
      expect(none).toEqual([]);
      for await (const p of port.payments({ chapterRef, from: FROM, to: TO, since: new Date('2099-01-01T00:00:00Z') })) none.push(p);
      expect(none).toEqual([]);
    });

    it('lists each movement exactly once across pages, two rows per booked payment, with no payment reference', async () => {
      const port = await seeded();
      const legs = Array.from({ length: 5 }, (_, i) => leg(`key-leg-${String(i).padStart(4, '0')}`, { amount: money(BigInt(100 + i), 'USD'), direction: i % 2 ? 'to_checking' : 'from_checking' }));
      await port.bookBatch(legs, chapterRef);
      await port.bookBatch(legs.slice(0, 2), chapterRef);
      const rows: MirrorMovement[] = [];
      for await (const m of port.movements({ from: FROM, to: TO })) rows.push(m);
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((r) => r.transactionRef)).size).toBe(10);
      expect(rows.filter((r) => r.accountRef === 'acct_m1')).toHaveLength(5);
      expect(rows.filter((r) => r.accountRef === chapterRef)).toHaveLength(5);
      expect(rows.find((r) => r.accountRef === 'acct_m1')).toMatchObject({ direction: 'credit', counterpartyAccountRef: chapterRef, amount: money(100n, 'USD') });
      expect(rows.find((r) => r.accountRef === chapterRef)).toMatchObject({ direction: 'debit', counterpartyAccountRef: 'acct_m1' });
      expect(rows[0]?.description).toContain('KC-key-leg-');
      expect(Object.keys(rows[0] ?? {})).not.toContain('paymentRef');
    });

    it('surfaces an outage as PROVIDER_UNAVAILABLE and books nothing', async () => {
      const port = await seeded();
      opts.outage(port, true);
      await expect(port.bookBatch([leg('key-leg-0001')], chapterRef)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      await expect(port.readBack({ chapterRef, memo: 'KC-key-leg-0001' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      opts.outage(port, false);
      expect(await port.readBack({ chapterRef, memo: 'KC-key-leg-0001' })).toEqual({ status: 'not_found' });
      expect(await bal(port)).toBe(10_000n);
    });
  });
}
