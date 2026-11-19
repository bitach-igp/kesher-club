import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { add, applyBps, CurrencyMismatchError, format, fromWire, money, roundUpTo99, sub, toDecimal, toWire } from './money.ts';

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

describe('roundUpTo99', () => {
  it('rounds up to the next .99 and leaves an exact .99 alone', () => {
    expect(roundUpTo99(2500n)).toBe(2599n);
    expect(roundUpTo99(2599n)).toBe(2599n);
    expect(roundUpTo99(2600n)).toBe(2699n);
    expect(roundUpTo99(1n)).toBe(99n);
  });
  it('maps zero and negatives to 99', () => {
    expect(roundUpTo99(0n)).toBe(99n);
    expect(roundUpTo99(-500n)).toBe(99n);
  });
  it('always ends in 99 and never rounds down', () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (n) => {
      const r = roundUpTo99(n);
      expect(r % 100n).toBe(99n);
      expect(r >= n).toBe(true);
      expect(r - n < 100n).toBe(true);
    }));
  });
});

describe('toDecimal', () => {
  it('writes two places with no grouping', () => {
    expect(toDecimal(0n)).toBe('0.00');
    expect(toDecimal(5n)).toBe('0.05');
    expect(toDecimal(5000n)).toBe('50.00');
    expect(toDecimal(123456789n)).toBe('1234567.89');
  });
  it('keeps the sign on negatives, including those under one major unit', () => {
    expect(toDecimal(-5n)).toBe('-0.05');
    expect(toDecimal(-5000n)).toBe('-50.00');
  });
  it('round-trips through BigInt for any amount', () => {
    fc.assert(fc.property(minor, (n) => {
      expect(BigInt(toDecimal(n).replace('.', ''))).toBe(n);
    }));
  });
});
