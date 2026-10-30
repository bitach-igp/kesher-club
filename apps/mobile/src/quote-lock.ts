// The rate lock (T-0533, REQ-FX-001): a quote's lock is timed on this phone from the moment the quote arrived,
// for as long as the server says it lasts (expiresAt − quotedAt). Compared with expiresAt directly, the phone's
// own clock decides, and it may be off by minutes (or, in the demo, by days): a quote would expire before it is
// shown, or never. The server still has the last word: a conversion it finds late answers QUOTE_EXPIRED, which
// the screens already handle by quoting again.
import type { FxQuote } from './api.ts';

/** A quote as a screen holds it: the wire quote, and when its lock ends on this phone's clock (epoch ms). */
export type HeldQuote = FxQuote & { lockEndsAt: number };

export function hold(quote: FxQuote, receivedAt: Date): HeldQuote {
  const lockMs = Date.parse(quote.expiresAt) - Date.parse(quote.quotedAt);
  return { ...quote, lockEndsAt: receivedAt.getTime() + (Number.isFinite(lockMs) ? Math.max(0, lockMs) : 0) };
}

export const secondsLeft = (quote: HeldQuote | undefined, now: Date): number => (quote ? Math.max(0, Math.ceil((quote.lockEndsAt - now.getTime()) / 1000)) : 0);
