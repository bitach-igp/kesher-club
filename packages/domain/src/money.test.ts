import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { add, applyBps, CurrencyMismatchError, format, fromWire, money, sub, toWire } from './money.ts';

const minor = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n });

describe('money', () => {
  it('formats shekels and dollars with U+2212 for negatives', () => {
    expect(format(money(128450n, 'ILS'))).toBe('₪1,284.50');
    expect(format(money(-1800n, 'ILS'))).toBe('−₪18.00');
    expect(format(money(21240n, 'USD'))).toBe('$212.40');
    expect(format(money(128450n, 'ILS'), 'he-IL')).toBe('1,284.50 ₪');
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(1n, 'USD'), money(1n, 'ILS'))).toThrow(CurrencyMismatchError);
  });

  it('round-trips through the wire format', () => {
    fc.assert(fc.property(minor, fc.constantFrom('USD' as const, 'ILS' as const), (m, c) => {
      const back = fromWire(toWire(money(m, c)));
      expect(back).toEqual(money(m, c));
    }));
  });

  it('add then sub is the identity', () => {
    fc.assert(fc.property(minor, minor, (a, b) => {
      const x = money(a, 'ILS');
      expect(sub(add(x, money(b, 'ILS')), money(b, 'ILS'))).toEqual(x);
    }));
  });

  it('applies basis points with half-up rounding', () => {
    expect(applyBps(money(60000n, 'USD'), 75n)).toEqual(money(450n, 'USD')); // 0.75% of $600 = $4.50
    expect(applyBps(money(1n, 'USD'), 5000n)).toEqual(money(1n, 'USD')); // 0.5 rounds up
  });

  it('a markup never exceeds the amount for bps <= 10000', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: 0n, max: 10_000n }), (m, bps) => {
      expect(applyBps(money(m, 'USD'), bps).minor <= m).toBe(true);
    }));
  });
});
