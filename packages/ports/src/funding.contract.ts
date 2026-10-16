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
  });
}
