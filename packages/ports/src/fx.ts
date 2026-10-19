// FxPort (REQ-FX-001/002): USD<->ILS quotes locked for 30 s with rate, markup and total; the markup
// comes from plan config and is stored on the journal (fx_markup_bps). Rates are fixed-point bigints
// scaled by 1e6 so no float ever touches money.
import type { Currency, Money } from '@kesher/domain';

export const RATE_SCALE = 1_000_000n;

export interface FxQuote {
  quoteId: string;
  from: Money;
  to: Currency;
  /** Mid-market rate × 1e6 (e.g. 3.71 ILS per USD → 3_710_000n). */
  rateScaled: bigint;
  markupBps: bigint;
  /** What the member receives after markup, in `to`. */
  total: Money;
  /** Markup taken, in `to`. */
  markup: Money;
  expiresAt: string;
}

export interface FxConversion {
  conversionId: string;
  quoteId: string;
  from: Money;
  total: Money;
  markup: Money;
  rateScaled: bigint;
  markupBps: bigint;
  status: 'settled' | 'failed';
}

export interface FxPort {
  quote(input: { from: Money; to: Currency; markupBps: bigint }): Promise<FxQuote>;
  /** Converts a live quote; QUOTE_EXPIRED after 30 s. Idempotent by key. */
  convert(quoteId: string, idempotencyKey: string): Promise<FxConversion>;
}

export type FxErrorCode = 'QUOTE_EXPIRED' | 'UNKNOWN_QUOTE' | 'UNSUPPORTED_PAIR' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class FxError extends Error {
  readonly code: FxErrorCode;
  constructor(
    code: FxErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'FxError';
  }
}

/** Fixed-point conversion: amount × rate / 1e6, half-up. */
export function applyRate(minor: bigint, rateScaled: bigint): bigint {
  const scaled = minor * rateScaled;
  const q = scaled / RATE_SCALE;
  const r = scaled % RATE_SCALE;
  return r * 2n >= RATE_SCALE ? q + 1n : q;
}
