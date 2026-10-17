// XCover prices arrive as JSON decimals (e.g. 12.0) in the quote currency. We never do float
// arithmetic on money: the value is rendered to a decimal string and split into minor units exactly,
// refusing anything with more precision than the currency carries (fail secure, constitution art. 3/6).
import { money, type Currency, type Money } from '@kesher/domain';

export function decimalToMinor(value: unknown, currency: Currency): Money {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : undefined;
  const m = text ? /^(\d+)(?:\.(\d{1,2}))?$/.exec(text) : null;
  if (!m) throw new RangeError(`Not a non-negative 2-decimal amount: ${typeof value}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(2, '0'));
  return money(whole * 100n + frac, currency);
}
