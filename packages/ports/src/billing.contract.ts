// BillingPort contract. Adapters run it nightly against the Stripe sandbox.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { BillingError, type BillingPort } from './billing.ts';

export interface BillingContractOptions {
  /** Produces a signed `invoice.payment_failed` webhook for a subscription. */
  failedInvoiceWebhook: (port: BillingPort, subscriptionId: string) => Promise<{ headers: Record<string, string>; rawBody: string }>;
  declinedEmail?: string;
  outageEmail?: string;
}

export function billingContract(name: string, make: () => BillingPort, opts: BillingContractOptions): void {
  describe(`BillingPort contract: ${name}`, () => {
    const price = money(4900n, 'USD');

    it('creates customers and subscriptions idempotently', async () => {
      const port = make();
      const c1 = await port.createCustomer({ partyId: 'p1', email: 'funder@example.com' }, 'c-1');
      const c2 = await port.createCustomer({ partyId: 'p1', email: 'funder@example.com' }, 'c-1');
      expect(c2.customerId).toBe(c1.customerId);
      const s1 = await port.createSubscription({ customerId: c1.customerId, planCode: 'club', price, termMonths: 10 }, 's-1');
      const s2 = await port.createSubscription({ customerId: c1.customerId, planCode: 'club', price, termMonths: 10 }, 's-1');
      expect(s2.subscriptionId).toBe(s1.subscriptionId);
      expect(s1.status).toBe('active');
      expect(s1.price).toEqual(price);
      expect(s1.termMonths).toBe(10);
    });

    it('offers wallet buttons exactly as asked (both on, or both off)', async () => {
      const port = make();
      const c = await port.createCustomer({ partyId: 'p2', email: 'f2@example.com' }, 'c-2');
      const both = await port.createSetupSheet(c.customerId, { applePay: true, googlePay: true });
      expect(both.wallets).toEqual({ applePay: true, googlePay: true });
      expect(both.clientSecret).toBeTruthy();
      const none = await port.createSetupSheet(c.customerId, { applePay: false, googlePay: false });
      expect(none.wallets).toEqual({ applePay: false, googlePay: false });
    });

    it('pause → resume → cancel at period end, with invalid transitions refused', async () => {
      const port = make();
      const c = await port.createCustomer({ partyId: 'p3', email: 'f3@example.com' }, 'c-3');
      const s = await port.createSubscription({ customerId: c.customerId, planCode: 'club', price, termMonths: 10 }, 's-3');
      await expect(port.resume(s.subscriptionId, 'r-0')).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect((await port.pause(s.subscriptionId, 'p-1')).status).toBe('paused');
      expect((await port.resume(s.subscriptionId, 'r-1')).status).toBe('active');
      const cancelled = await port.cancel(s.subscriptionId, 'period_end', 'x-1');
      expect(cancelled.cancelAt).toBe(cancelled.currentPeriodEnd);
      expect(cancelled.status).toBe('active');
    });

    it('a failed invoice webhook moves the subscription to past_due and is deduped', async () => {
      const port = make();
      const c = await port.createCustomer({ partyId: 'p4', email: 'f4@example.com' }, 'c-4');
      const s = await port.createSubscription({ customerId: c.customerId, planCode: 'club', price, termMonths: 10 }, 's-4');
      const hook = await opts.failedInvoiceWebhook(port, s.subscriptionId);
      const e1 = await port.parseWebhook(hook.headers, hook.rawBody);
      const e2 = await port.parseWebhook(hook.headers, hook.rawBody);
      expect(e1.type).toBe('invoice.payment_failed');
      expect(e2).toEqual(e1);
      expect((await port.get(s.subscriptionId)).status).toBe('past_due');
      await expect(port.parseWebhook({ 'x-sim-signature': 'forged', 'stripe-signature': 'forged' }, hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    it('unknown ids are typed errors', async () => {
      await expect(make().get('nope')).rejects.toBeInstanceOf(BillingError);
    });

    if (opts.declinedEmail) {
      it('maps a declined card to CARD_DECLINED', async () => {
        const port = make();
        const c = await port.createCustomer({ partyId: 'p5', email: opts.declinedEmail! }, 'c-5');
        await expect(port.createSubscription({ customerId: c.customerId, planCode: 'club', price, termMonths: 10 }, 's-5')).rejects.toMatchObject({ code: 'CARD_DECLINED' });
      });
    }
    if (opts.outageEmail) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().createCustomer({ partyId: 'p6', email: opts.outageEmail! }, 'c-6')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}
