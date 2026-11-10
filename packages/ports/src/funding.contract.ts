// FundingPort contract (TST-WAL-002/003 at the port layer).
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { FundingError, type FundingPort, type FundingStatementPort, type SettledEntry } from './funding.ts';
import type { AdvanceableClock } from './base.ts';

export interface FundingContractOptions {
  goodPaymentMethod: string;
  declinedPaymentMethod?: string;
  outagePaymentMethod?: string;
  achPaymentMethod?: string;
  succeededWebhook: (port: FundingPort, loadId: string) => Promise<{ headers: Record<string, string>; rawBody: string }>;
  /** A payment method whose loads cannot be refunded (the vendor answers failed). */
  norefundPaymentMethod?: string;
}

export function fundingContract(name: string, make: () => FundingPort, opts: FundingContractOptions): void {
  describe(`FundingPort contract: ${name}`, () => {
    const amount = money(10_000n, 'USD');

    it('creates a card load idempotently and never twice for one key', async () => {
      const port = make();
      const a = await port.createLoad({ customerId: 'c1', method: 'card', amount, paymentMethodId: opts.goodPaymentMethod }, 'L-1');
      const b = await port.createLoad({ customerId: 'c1', method: 'card', amount, paymentMethodId: opts.goodPaymentMethod }, 'L-1');
      expect(b.loadId).toBe(a.loadId);
      expect(a.amount).toEqual(amount);
      expect(['succeeded', 'processing', 'requires_action']).toContain(a.status);
    });

    it('supports Apple Pay and Google Pay as methods', async () => {
      const port = make();
      for (const method of ['apple_pay', 'google_pay'] as const) {
        const l = await port.createLoad({ customerId: 'c1', method, amount, paymentMethodId: opts.goodPaymentMethod }, `L-${method}`);
        expect(l.method).toBe(method);
      }
    });

    it('rejects non-positive amounts', async () => {
      await expect(make().createLoad({ customerId: 'c1', method: 'card', amount: money(0n, 'USD'), paymentMethodId: opts.goodPaymentMethod }, 'L-0')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('verifies webhook signatures, dedupes, and refuses an amount mismatch', async () => {
      const port = make();
      const l = await port.createLoad({ customerId: 'c1', method: 'card', amount, paymentMethodId: opts.goodPaymentMethod }, 'L-2');
      const hook = await opts.succeededWebhook(port, l.loadId);
      const e1 = await port.parseWebhook(hook.headers, hook.rawBody);
      const e2 = await port.parseWebhook(hook.headers, hook.rawBody);
      expect(e1.load.status).toBe('succeeded');
      expect(e2).toEqual(e1);
      await expect(port.parseWebhook({ 'x-sim-signature': 'forged', 'stripe-signature': 'forged' }, hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    if (opts.achPaymentMethod) {
      it('ACH loads are on hold with a spendable date (REQ-WAL-003)', async () => {
        const l = await make().createLoad({ customerId: 'c1', method: 'ach', amount, paymentMethodId: opts.achPaymentMethod! }, 'L-ach');
        expect(l.status).toBe('on_hold');
        expect(l.holdUntil).toBeTruthy();
      });
    }
    if (opts.declinedPaymentMethod) {
      it('maps declines to DECLINED and does not retry under the same key', async () => {
        const port = make();
        await expect(port.createLoad({ customerId: 'c1', method: 'card', amount, paymentMethodId: opts.declinedPaymentMethod! }, 'L-d')).rejects.toMatchObject({ code: 'DECLINED' });
      });
    }
    if (opts.outagePaymentMethod) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().createLoad({ customerId: 'c1', method: 'card', amount, paymentMethodId: opts.outagePaymentMethod! }, 'L-o')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
    it('unknown loads are typed errors', async () => {
      await expect(make().getLoad('nope')).rejects.toBeInstanceOf(FundingError);
    });

    it('refunds a settled load to its source, partially and idempotently, never past what remains (REQ-WAL-005)', async () => {
      const port = make();
      const l = await port.createLoad({ customerId: 'c1', method: 'card', amount, paymentMethodId: opts.goodPaymentMethod }, 'L-r');
      const a = await port.refund({ loadId: l.loadId, amount: money(3_000n, 'USD') }, 'R-1');
      expect(a).toMatchObject({ loadId: l.loadId, amount: money(3_000n, 'USD') });
      expect(['pending', 'succeeded']).toContain(a.status);
      expect(await port.refund({ loadId: l.loadId, amount: money(3_000n, 'USD') }, 'R-1')).toEqual(a);
      expect((await port.getRefund(a.refundId)).refundId).toBe(a.refundId);
      await expect(port.refund({ loadId: l.loadId, amount: money(7_001n, 'USD') }, 'R-2')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await port.refund({ loadId: l.loadId, amount: money(7_000n, 'USD') }, 'R-3')).amount).toEqual(money(7_000n, 'USD'));
      await expect(port.refund({ loadId: l.loadId, amount: money(0n, 'USD') }, 'R-4')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(port.refund({ loadId: 'nope', amount: money(100n, 'USD') }, 'R-5')).rejects.toMatchObject({ code: 'UNKNOWN_LOAD' });
      await expect(port.getRefund('nope')).rejects.toBeInstanceOf(FundingError);
    });

    if (opts.norefundPaymentMethod) {
      it('a refund the vendor refuses comes back failed with a code, not as an exception', async () => {
        const port = make();
        const l = await port.createLoad({ customerId: 'c1', method: 'card', amount, paymentMethodId: opts.norefundPaymentMethod! }, 'L-nr');
        const r = await port.refund({ loadId: l.loadId, amount }, 'R-nr');
        expect(r.status).toBe('failed');
        expect(r.failureCode).toBeTruthy();
      });
    }
  });
}

export interface FundingStatementContractOptions {
  goodPaymentMethod: string;
  achPaymentMethod: string;
  /** A payment method whose refunds stay pending until the vendor settles them. */
  slowRefundPaymentMethod: string;
  /** The clock the port stamps settlement with, so the suite can place movements on different days. */
  clockOf: (port: FundingPort & FundingStatementPort) => AdvanceableClock;
  /** Makes every later listing request fail as the vendor being down (a 5xx), from the `after`-th request on (0 = the next). */
  failListingFrom: (port: FundingPort & FundingStatementPort, after: number) => void;
}

/** FundingStatementPort contract (T-0683): the settled-movement listing reconciliation reads. */
export function fundingStatementContract(name: string, make: () => FundingPort & FundingStatementPort, opts: FundingStatementContractOptions): void {
  describe(`FundingStatementPort contract: ${name}`, () => {
    const amount = (minor: bigint) => money(minor, 'USD');
    const DAY = 86_400_000;
    const key = (e: SettledEntry) => `${e.kind}:${e.id}`;
    const all = async (port: FundingStatementPort, from: string, to: string, limit?: number): Promise<SettledEntry[]> => {
      const out: SettledEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = await port.listSettled({ from, to, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) });
        out.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    };

    it('lists settled charges and refunds in the window with ids, bigint amounts and the settlement instant', async () => {
      const port = make();
      const clock = opts.clockOf(port);
      const start = clock.now();
      const a = await port.createLoad({ customerId: 'c', method: 'card', amount: amount(10_000n), paymentMethodId: opts.goodPaymentMethod }, 'S-load-a');
      clock.advance(60_000);
      const b = await port.createLoad({ customerId: 'c', method: 'card', amount: amount(2_500n), paymentMethodId: opts.goodPaymentMethod }, 'S-load-b');
      clock.advance(60_000);
      const r = await port.refund({ loadId: a.loadId, amount: amount(4_000n) }, 'S-refund-a');
      const entries = await all(port, start.toISOString(), new Date(start.getTime() + DAY).toISOString());
      expect(entries.map(key).sort()).toEqual([`charge:${a.loadId}`, `charge:${b.loadId}`, `refund:${r.refundId}`].sort());
      const byKey = new Map(entries.map((e) => [key(e), e]));
      expect(byKey.get(`charge:${a.loadId}`)).toMatchObject({ loadId: a.loadId, amount: amount(10_000n) });
      expect(typeof byKey.get(`charge:${a.loadId}`)!.amount.minor).toBe('bigint');
      expect(byKey.get(`refund:${r.refundId}`)).toMatchObject({ loadId: a.loadId, amount: amount(4_000n) });
      for (const e of entries) expect(Number.isNaN(Date.parse(e.settledAt))).toBe(false);
    });

    it('takes from inclusive and to exclusive, and leaves out other days', async () => {
      const port = make();
      const clock = opts.clockOf(port);
      const t0 = clock.now();
      const early = await port.createLoad({ customerId: 'c', method: 'card', amount: amount(100n), paymentMethodId: opts.goodPaymentMethod }, 'S-early');
      clock.advance(DAY);
      const mid = await port.createLoad({ customerId: 'c', method: 'card', amount: amount(200n), paymentMethodId: opts.goodPaymentMethod }, 'S-mid');
      clock.advance(DAY);
      await port.createLoad({ customerId: 'c', method: 'card', amount: amount(300n), paymentMethodId: opts.goodPaymentMethod }, 'S-late');
      const day = await all(port, new Date(t0.getTime() + DAY).toISOString(), new Date(t0.getTime() + 2 * DAY).toISOString());
      expect(day.map((e) => e.id)).toEqual([mid.loadId]);
      expect((await all(port, t0.toISOString(), new Date(t0.getTime() + DAY).toISOString())).map((e) => e.id)).toEqual([early.loadId]);
    });

    it('does not list what has not settled: an ACH load on hold, a pending or failed refund', async () => {
      const port = make();
      const clock = opts.clockOf(port);
      const t0 = clock.now();
      await port.createLoad({ customerId: 'c', method: 'ach', amount: amount(5_000n), paymentMethodId: opts.achPaymentMethod }, 'S-ach');
      const slow = await port.createLoad({ customerId: 'c', method: 'card', amount: amount(5_000n), paymentMethodId: opts.slowRefundPaymentMethod }, 'S-slow');
      await port.refund({ loadId: slow.loadId, amount: amount(1_000n) }, 'S-slow-refund');
      const entries = await all(port, t0.toISOString(), new Date(t0.getTime() + DAY).toISOString());
      expect(entries.map(key)).toEqual([`charge:${slow.loadId}`]);
    });

    it('pages: limit 2 over five rows returns each once, and a page past the end is empty', async () => {
      const port = make();
      const clock = opts.clockOf(port);
      const t0 = clock.now();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await port.createLoad({ customerId: 'c', method: 'card', amount: amount(BigInt(100 + i)), paymentMethodId: opts.goodPaymentMethod }, `S-page-${i}`)).loadId);
        clock.advance(1_000);
      }
      const from = t0.toISOString();
      const to = new Date(t0.getTime() + DAY).toISOString();
      const first = await port.listSettled({ from, to, limit: 2 });
      expect(first.entries).toHaveLength(2);
      expect(first.nextCursor).toBeTruthy();
      const entries = await all(port, from, to, 2);
      expect(entries.map((e) => e.id).sort()).toEqual([...ids].sort());
    });

    it('a vendor outage on a later page throws PROVIDER_UNAVAILABLE instead of returning what it had', async () => {
      const port = make();
      const clock = opts.clockOf(port);
      const t0 = clock.now();
      for (let i = 0; i < 3; i++) await port.createLoad({ customerId: 'c', method: 'card', amount: amount(100n), paymentMethodId: opts.goodPaymentMethod }, `S-out-${i}`);
      const from = t0.toISOString();
      const to = new Date(t0.getTime() + DAY).toISOString();
      opts.failListingFrom(port, 1);
      const first = await port.listSettled({ from, to, limit: 2 });
      await expect(port.listSettled({ from, to, limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    });

    it('rejects an empty or inverted window', async () => {
      const port = make();
      const t = opts.clockOf(port).now().toISOString();
      await expect(port.listSettled({ from: t, to: t })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
}
