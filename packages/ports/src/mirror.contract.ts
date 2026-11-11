// MirrorPort contract (T-0718, TST-WAL-003, TST-LED-003). Every adapter:
// - books 1 to 10 USD legs per batch between a member's account and the chapter checking account, one result per leg
//   in order; ILS, zero, negative amounts, an empty or oversize batch, or a short key refuse the whole batch
//   (VALIDATION_FAILED) before the provider is called;
// - books a key once: a replay answers `booked` with the same paymentRef and moves nothing more;
// - refuses one leg without stopping the others (continue-on-error), with a code from the closed set;
// - refuses a memo over 80 printable ASCII characters;
// - reads a leg back by key without moving anything, so a lost answer is read before any resend;
// - reports checking and account balances in bigint cents, and lists movements each exactly once across pages,
//   two rows per booked payment (one per account);
// - surfaces an outage as PROVIDER_UNAVAILABLE.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { type MirrorLeg, type MirrorPort, type MirrorMovement } from './mirror.ts';

export interface MirrorContractOptions<P extends MirrorPort> {
  /** The chapter whose checking account is on one side of every leg. */
  chapterRef: string;
  /** Opens a member's account (status open) and puts `minor` USD cents in checking and in the account. */
  seed(port: P, input: { accountRef: string; accountMinor: bigint; checkingMinor: bigint }): Promise<void>;
  /** The vendor refuses the leg with this key with this code, once it is sent. */
  refuse(port: P, key: string, code: 'INSUFFICIENT_FUNDS' | 'ACCOUNT_UNAVAILABLE' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'PAYMENT_FAILED'): void;
  /** The vendor books the leg with this key, then the answer is lost (`unknown`). */
  loseAnswer(port: P, key: string): void;
  /** The account is frozen: legs on it are refused ACCOUNT_UNAVAILABLE. */
  freeze(port: P, accountRef: string): void;
  outage(port: P, on: boolean): void;
}

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2027-01-01T00:00:00Z');

export function mirrorContract<P extends MirrorPort>(name: string, make: () => P, opts: MirrorContractOptions<P>): void {
  const chapterRef = opts.chapterRef;
  const leg = (key: string, over: Partial<MirrorLeg> = {}): MirrorLeg => ({ direction: 'from_checking', accountRef: 'acct_m1', amount: money(2_500n, 'USD'), memo: 'KC-test', idempotencyKey: key, ...over });
  const seeded = async (accountMinor = 10_000n, checkingMinor = 10_000n): Promise<P> => {
    const port = make();
    await opts.seed(port, { accountRef: 'acct_m1', accountMinor, checkingMinor });
    await opts.seed(port, { accountRef: 'acct_m2', accountMinor, checkingMinor });
    return port;
  };

  describe(`MirrorPort contract: ${name}`, () => {
    it('books a leg each way and moves both balances in bigint', async () => {
      const port = await seeded();
      const [out, back] = await port.bookBatch([leg('key-leg-0001', { direction: 'from_checking' }), leg('key-leg-0002', { direction: 'to_checking', amount: money(1_000n, 'USD') })], chapterRef);
      expect(out?.status).toBe('booked');
      expect(out?.paymentRef).toBeTruthy();
      expect(back?.status).toBe('booked');
      expect(back?.paymentRef).not.toBe(out?.paymentRef);
      expect(await port.accountBalance('acct_m1')).toEqual({ balance: 10_000n + 2_500n - 1_000n });
      expect(await port.checkingBalance(chapterRef)).toEqual({ balance: 10_000n - 2_500n + 1_000n });
    });

    it('books a key once and answers the same paymentRef on a replay', async () => {
      const port = await seeded();
      const [a] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      const [b] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      expect(b).toEqual(a);
      expect(a?.status).toBe('booked');
      expect((await port.accountBalance('acct_m1')).balance).toBe(12_500n);
      const [c, d] = await port.bookBatch([leg('key-leg-0001'), leg('key-leg-0001')], chapterRef);
      expect([c?.paymentRef, d?.paymentRef]).toEqual([a?.paymentRef, a?.paymentRef]);
      expect((await port.accountBalance('acct_m1')).balance).toBe(12_500n);
    });

    it('refuses the whole batch before any call for ILS, zero, negative, an empty or oversize batch and a short key', async () => {
      const port = await seeded();
      const bad: MirrorLeg[][] = [
        [leg('key-leg-0001'), leg('key-leg-0002', { amount: money(500n, 'ILS') })],
        [leg('key-leg-0001'), leg('key-leg-0002', { amount: money(0n, 'USD') })],
        [leg('key-leg-0001'), leg('key-leg-0002', { amount: money(-5n, 'USD') })],
        [],
        Array.from({ length: 11 }, (_, i) => leg(`key-leg-${String(i).padStart(4, '0')}`, { amount: money(1n, 'USD') })),
        [leg('short')],
      ];
      for (const legs of bad) await expect(port.bookBatch(legs, chapterRef)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // Nothing moved, not even the valid first leg of a refused batch.
      expect((await port.accountBalance('acct_m1')).balance).toBe(10_000n);
      expect(await port.readBack('key-leg-0001')).toMatchObject({ status: 'not_found' });
    });

    it('takes up to 10 legs in one batch, one result per leg in order', async () => {
      const port = await seeded(0n, 100_000n);
      const legs = Array.from({ length: 10 }, (_, i) => leg(`key-leg-${String(i).padStart(4, '0')}`, { amount: money(BigInt(i + 1), 'USD') }));
      const res = await port.bookBatch(legs, chapterRef);
      expect(res.map((r) => r.status)).toEqual(Array(10).fill('booked'));
      expect((await port.accountBalance('acct_m1')).balance).toBe(55n);
    });

    it('refuses a memo over 80 characters or outside printable ASCII, and a refused leg does not stop the others', async () => {
      const port = await seeded();
      const res = await port.bookBatch([leg('key-leg-0001', { memo: 'x'.repeat(81) }), leg('key-leg-0002', { memo: 'שלום' }), leg('key-leg-0003', { memo: 'x'.repeat(80) })], chapterRef);
      expect(res.map((r) => r.status)).toEqual(['refused', 'refused', 'booked']);
      expect(res[0]?.reasonCode).toBe('VALIDATION_ERROR');
    });

    it('continues on error: an overdraft, a frozen account and an unknown account refuse their own leg only', async () => {
      const port = await seeded(1_000n, 10_000n);
      opts.freeze(port, 'acct_m2');
      const res = await port.bookBatch(
        [
          leg('key-leg-0001', { direction: 'to_checking', amount: money(5_000n, 'USD') }),
          leg('key-leg-0002', { accountRef: 'acct_m2' }),
          leg('key-leg-0003', { accountRef: 'acct_nope' }),
          leg('key-leg-0004', { amount: money(100_000n, 'USD') }),
          leg('key-leg-0005'),
        ],
        chapterRef,
      );
      expect(res.map((r) => [r.status, r.reasonCode])).toEqual([
        ['refused', 'INSUFFICIENT_FUNDS'],
        ['refused', 'ACCOUNT_UNAVAILABLE'],
        ['refused', 'NOT_FOUND'],
        ['refused', 'INSUFFICIENT_FUNDS'],
        ['booked', undefined],
      ]);
      expect((await port.accountBalance('acct_m1')).balance).toBe(3_500n);
      // A refused leg is final for its key: a replay answers the same refusal.
      const [again] = await port.bookBatch([leg('key-leg-0001', { direction: 'to_checking', amount: money(5_000n, 'USD') })], chapterRef);
      expect(again).toMatchObject({ status: 'refused', reasonCode: 'INSUFFICIENT_FUNDS' });
    });

    it('reports the vendor reason codes it is told to refuse with', async () => {
      const port = await seeded();
      opts.refuse(port, 'key-leg-0001', 'PAYMENT_FAILED');
      const [r] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      expect(r).toMatchObject({ status: 'refused', reasonCode: 'PAYMENT_FAILED' });
      expect(await port.readBack('key-leg-0001')).toMatchObject({ status: 'refused', reasonCode: 'PAYMENT_FAILED' });
      expect((await port.accountBalance('acct_m1')).balance).toBe(10_000n);
    });

    it('reads a leg back by key without moving anything, including one whose answer was lost', async () => {
      const port = await seeded();
      expect(await port.readBack('key-leg-0001')).toEqual({ status: 'not_found' });
      opts.loseAnswer(port, 'key-leg-0001');
      const [lost] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      expect(lost?.status).toBe('unknown');
      const read = await port.readBack('key-leg-0001');
      expect(read.status).toBe('booked');
      expect(read.paymentRef).toBeTruthy();
      expect(await port.readBack('key-leg-0001')).toEqual(read);
      expect((await port.accountBalance('acct_m1')).balance).toBe(12_500n);
      // The resend of the same key books nothing more and answers the vendor's own payment.
      const [resent] = await port.bookBatch([leg('key-leg-0001')], chapterRef);
      expect(resent).toMatchObject({ status: 'booked', paymentRef: read.paymentRef });
      expect((await port.accountBalance('acct_m1')).balance).toBe(12_500n);
    });

    it('keeps balances past 2^53 exact', async () => {
      const big = 9_007_199_254_740_993n;
      const port = await seeded(big, big);
      await port.bookBatch([leg('key-leg-0001', { amount: money(2n, 'USD') })], chapterRef);
      expect((await port.accountBalance('acct_m1')).balance).toBe(big + 2n);
      expect((await port.checkingBalance(chapterRef)).balance).toBe(big - 2n);
    });

    it('lists each movement exactly once across pages, two rows per booked payment', async () => {
      const port = await seeded();
      const legs = Array.from({ length: 5 }, (_, i) => leg(`key-leg-${String(i).padStart(4, '0')}`, { amount: money(BigInt(100 + i), 'USD'), direction: i % 2 ? 'to_checking' : 'from_checking' }));
      await port.bookBatch(legs, chapterRef);
      await port.bookBatch(legs.slice(0, 2), chapterRef); // a replay adds nothing
      const rows: MirrorMovement[] = [];
      for await (const m of port.movements({ from: FROM, to: TO })) rows.push(m);
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((r) => r.transactionRef)).size).toBe(10);
      const forAccount = rows.filter((r) => r.accountRef === 'acct_m1');
      const forChecking = rows.filter((r) => r.accountRef === chapterRef);
      expect(forAccount).toHaveLength(5);
      expect(forChecking).toHaveLength(5);
      expect(forAccount[0]).toMatchObject({ direction: 'credit', counterpartyAccountRef: chapterRef });
      expect(forChecking[0]).toMatchObject({ direction: 'debit', counterpartyAccountRef: 'acct_m1' });
      expect(forAccount[0]?.amount).toEqual(money(100n, 'USD'));
      expect(forAccount[0]?.description).toContain('KC-test');
      const none: MirrorMovement[] = [];
      for await (const m of port.movements({ from: new Date('2020-01-01T00:00:00Z'), to: new Date('2020-02-01T00:00:00Z') })) none.push(m);
      expect(none).toEqual([]);
    });

    it('surfaces an outage as PROVIDER_UNAVAILABLE and books nothing', async () => {
      const port = await seeded();
      opts.outage(port, true);
      await expect(port.bookBatch([leg('key-leg-0001')], chapterRef)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      await expect(port.readBack('key-leg-0001')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      opts.outage(port, false);
      expect(await port.readBack('key-leg-0001')).toEqual({ status: 'not_found' });
      expect((await port.accountBalance('acct_m1')).balance).toBe(10_000n);
    });
  });
}
