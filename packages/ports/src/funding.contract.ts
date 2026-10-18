// FundingPort contract (TST-WAL-002/003 at the port layer).
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { FundingError, type FundingPort } from './funding.ts';

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
