// PayoutPort contract (TST-PO-001/002 at the port layer).
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { PayoutError, type Payee, type PayoutPort } from './payout.ts';

export interface PayoutContractOptions {
  goodPayee: Payee;
  failingPayee: Payee;
  outagePayee?: Payee;
  nextWebhook: (port: PayoutPort, payoutId: string) => Promise<{ headers: Record<string, string>; rawBody: string }>;
}

export function payoutContract(name: string, make: () => PayoutPort, opts: PayoutContractOptions): void {
  describe(`PayoutPort contract: ${name}`, () => {
    const amount = money(300_000n, 'ILS');

    it('validates Israeli IBANs by checksum (REQ-PO-001)', async () => {
      const port = make();
      expect((await port.validatePayee(opts.goodPayee)).valid).toBe(true);
      const bad = await port.validatePayee({ ...opts.goodPayee, iban: 'IL620108000000099999998' });
      expect(bad.valid).toBe(false);
      expect(bad.reasons).toContain('IBAN_CHECKSUM');
      const foreign = await port.validatePayee({ ...opts.goodPayee, iban: 'GB82WEST12345698765432' });
      expect(foreign.reasons).toContain('NOT_ISRAELI');
    });

    it('creates a payout idempotently and refuses an invalid payee or non-ILS amount', async () => {
      const port = make();
      const a = await port.createPayout({ payee: opts.goodPayee, amount, reference: 'rent-nov' }, 'po-1');
      const b = await port.createPayout({ payee: opts.goodPayee, amount, reference: 'rent-nov' }, 'po-1');
      expect(b.payoutId).toBe(a.payoutId);
      expect(a.status).toBe('submitted');
      await expect(port.createPayout({ payee: { iban: 'IL000', name: 'x' }, amount, reference: 'r' }, 'po-2')).rejects.toMatchObject({ code: 'INVALID_PAYEE' });
      await expect(port.createPayout({ payee: opts.goodPayee, amount: money(100n, 'USD'), reference: 'r' }, 'po-3')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('status webhooks settle or fail the payout, deduped, with a failure reason (REQ-PO-002)', async () => {
      const port = make();
      const ok = await port.createPayout({ payee: opts.goodPayee, amount, reference: 'r' }, 'po-4');
      const h1 = await opts.nextWebhook(port, ok.payoutId);
      expect((await port.parseWebhook(h1.headers, h1.rawBody)).payout.status).toBe('settled');
      const failing = await port.createPayout({ payee: opts.failingPayee, amount, reference: 'r' }, 'po-5');
      const h2 = await opts.nextWebhook(port, failing.payoutId);
      const e1 = await port.parseWebhook(h2.headers, h2.rawBody);
      const e2 = await port.parseWebhook(h2.headers, h2.rawBody);
      expect(e1.payout.status).toBe('failed');
      expect(e1.payout.failureReason).toBeTruthy();
      expect(e2).toEqual(e1);
      await expect(port.parseWebhook({ 'x-sim-signature': 'forged', 'x-signature': 'forged' }, h2.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    });

    it('unknown payouts are typed errors', async () => {
      await expect(make().getPayout('nope')).rejects.toBeInstanceOf(PayoutError);
    });

    if (opts.outagePayee) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().createPayout({ payee: opts.outagePayee!, amount, reference: 'r' }, 'po-o')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}
