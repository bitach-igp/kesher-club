// T-0533: the 30-second lock is timed from the quote's arrival on the phone, so a phone clock that is off (by
// a minute, or by the demo's days) neither expires a quote before it is shown nor keeps one alive for ever.
import { describe, expect, it } from 'vitest';
import type { FxQuote } from './api.ts';
import { hold, secondsLeft } from './quote-lock.ts';

const SERVER = new Date('2026-11-04T10:15:00Z');
const quote = (over: Partial<FxQuote> = {}): FxQuote => ({ quoteId: 'q', from: { minor: '10000', currency: 'USD' }, total: { minor: '36822', currency: 'ILS' }, markup: { minor: '278', currency: 'ILS' }, markupBps: 75, rate: '3.710000', quotedAt: SERVER.toISOString(), expiresAt: new Date(SERVER.getTime() + 30_000).toISOString(), ...over });

describe('the rate lock on the phone (T-0533)', () => {
  it('counts the server\'s 30 seconds from arrival, whatever the phone\'s clock says', () => {
    for (const phone of [new Date('2026-10-30T10:15:00Z'), SERVER, new Date(SERVER.getTime() + 90_000)]) {
      const held = hold(quote(), phone);
      expect(secondsLeft(held, phone)).toBe(30);
      expect(secondsLeft(held, new Date(phone.getTime() + 29_100))).toBe(1);
      expect(secondsLeft(held, new Date(phone.getTime() + 30_000))).toBe(0);
    }
  });

  it('a quote that is already spent, or whose times are not dates, holds for nothing; no quote, nothing left', () => {
    expect(secondsLeft(hold(quote({ expiresAt: SERVER.toISOString() }), SERVER), SERVER)).toBe(0);
    expect(secondsLeft(hold(quote({ quotedAt: 'soon' }), SERVER), SERVER)).toBe(0);
    expect(secondsLeft(undefined, SERVER)).toBe(0);
  });
});
