// Money is always bigint minor units plus an ISO currency (constitution art. 3).
// Never use `number` for amounts.

export type Currency = 'USD' | 'ILS';

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export const money = (minor: bigint, currency: Currency): Money => ({ minor, currency });

export const zero = (currency: Currency): Money => money(0n, currency);

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export const add = (a: Money, b: Money): Money => (same(a, b), money(a.minor + b.minor, a.currency));
export const sub = (a: Money, b: Money): Money => (same(a, b), money(a.minor - b.minor, a.currency));
export const neg = (a: Money): Money => money(-a.minor, a.currency);
export const isNegative = (a: Money): boolean => a.minor < 0n;

/** Basis-point markup, rounded half-up away from zero in minor units. */
export function applyBps(a: Money, bps: bigint): Money {
  const scaled = a.minor * bps;
  const q = scaled / 10_000n;
  const r = scaled % 10_000n;
  const absR = r < 0n ? -r : r;
  const bump = absR * 2n >= 10_000n ? (scaled < 0n ? -1n : 1n) : 0n;
  return money(q + bump, a.currency);
}

/** Wire format: minor units as a decimal string so bigint survives JSON. */
export const toWire = (a: Money) => ({ minor: a.minor.toString(), currency: a.currency });
export function fromWire(w: { minor: string; currency: string }): Money {
  if (w.currency !== 'USD' && w.currency !== 'ILS') throw new Error(`Unsupported currency ${w.currency}`);
  if (!/^-?\d+$/.test(w.minor)) throw new Error('minor must be an integer string');
  return money(BigInt(w.minor), w.currency);
}

/** Display only; never parse this back. Uses U+2212 for negatives. */
export function format(a: Money, locale: 'en-US' | 'he-IL' = 'en-US'): string {
  const negative = a.minor < 0n;
  const abs = negative ? -a.minor : a.minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = a.currency === 'USD' ? '$' : '₪';
  const body = locale === 'he-IL' ? `${grouped}.${frac} ${symbol}` : `${symbol}${grouped}.${frac}`;
  return negative ? `−${body}` : body;
}
