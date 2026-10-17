// FxPort contract (TST-FX-001/002 at the port layer).
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { applyRate, FxError, type FxPort } from './fx.ts';

export interface FxContractOptions {
  /** Moves the port's clock past the quote lock (simulator) or waits (sandbox). */
  expireQuotes: (port: FxPort) => Promise<void>;
  outageAmountMinor?: bigint;
}

export function fxContract(name: string, make: () => FxPort, opts: FxContractOptions): void {
  describe(`FxPort contract: ${name}`, () => {
    it('quotes with rate, markup and total that reconcile exactly (REQ-FX-001/002)', async () => {
      const q = await make().quote({ from: money(10_000n, 'USD'), to: 'ILS', markupBps: 75n });
      expect(q.to).toBe('ILS');
      expect(q.markupBps).toBe(75n);
      expect(q.rateScaled > 0n).toBe(true);
      const gross = applyRate(q.from.minor, q.rateScaled);
      expect(q.total.minor + q.markup.minor).toBe(gross);
      expect(q.markup.minor >= 0n).toBe(true);
      expect(Date.parse(q.expiresAt)).toBeGreaterThan(0);
    });

    it('converts a live quote once per key and carries the markup bps onto the conversion', async () => {
      const port = make();
      const q = await port.quote({ from: money(5_000n, 'USD'), to: 'ILS', markupBps: 75n });
      const a = await port.convert(q.quoteId, 'conv-1');
      const b = await port.convert(q.quoteId, 'conv-1');
      expect(b).toEqual(a);
      expect(a.markupBps).toBe(75n);
      expect(a.total).toEqual(q.total);
      expect(a.status).toBe('settled');
    });

    it('an expired quote fails with QUOTE_EXPIRED', async () => {
      const port = make();
      const q = await port.quote({ from: money(5_000n, 'USD'), to: 'ILS', markupBps: 75n });
      await opts.expireQuotes(port);
      await expect(port.convert(q.quoteId, 'conv-2')).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    });

    it('rejects same-currency and non-positive quotes', async () => {
      const port = make();
      await expect(port.quote({ from: money(1n, 'USD'), to: 'USD', markupBps: 0n })).rejects.toBeInstanceOf(FxError);
      await expect(port.quote({ from: money(0n, 'USD'), to: 'ILS', markupBps: 0n })).rejects.toBeInstanceOf(FxError);
    });

    if (opts.outageAmountMinor !== undefined) {
      it('a provider rejection voids the quote with PROVIDER_UNAVAILABLE and no conversion', async () => {
        const port = make();
        const q = await port.quote({ from: money(opts.outageAmountMinor!, 'USD'), to: 'ILS', markupBps: 75n });
        await expect(port.convert(q.quoteId, 'conv-o')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}
