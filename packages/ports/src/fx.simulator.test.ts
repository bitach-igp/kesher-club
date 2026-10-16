import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fixedClock, type AdvanceableClock } from './base.ts';
import { fxContract } from './fx.contract.ts';
import { FxSimulator } from './fx.simulator.ts';
import { applyRate, RATE_SCALE } from './fx.ts';

fxContract('simulator', () => new FxSimulator(), {
  expireQuotes: async (port) => (port as FxSimulator & { clock: AdvanceableClock }).clock.advance(30_001),
  outageAmountMinor: 999_999n,
});

describe('fixed-point FX arithmetic', () => {
  it('never drifts by more than one minor unit from the exact rational value', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 8n }), (minor, rate) => {
        const exact2 = (minor * rate * 2n) / RATE_SCALE; // 2× to detect half-up
        const got = applyRate(minor, rate);
        expect(got * 2n - exact2 <= 1n && got * 2n - exact2 >= -1n).toBe(true);
      }),
    );
  });

  it('a 30 s lock expires exactly after 30 s, not before', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const sim = new FxSimulator(clock);
    const q = await sim.quote({ from: { minor: 100n, currency: 'USD' }, to: 'ILS', markupBps: 0n });
    clock.advance(30_000);
    await expect(sim.convert(q.quoteId, 'k')).resolves.toMatchObject({ status: 'settled' });
  });
});
