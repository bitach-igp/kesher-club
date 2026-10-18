// Convert view model (T-0509). TST-FX-001/002 at the screen: the quote shows rate, markup and total and
// counts down from 30 s; confirming an expired quote answers QUOTE_EXPIRED and the screen fetches a
// fresh one; a step-up keeps the quote's key; a fresh quote is a fresh key.
import { describe, expect, it } from 'vitest';
import type { Account, FxApi, FxConversion, FxQuote } from '../../src/api.ts';
import { createFxModel, markupPercent, other, parseAmount, problemFor, secondsLeft } from './fx.model.ts';

const T0 = new Date('2026-11-10T09:00:00Z');
const problem = (code: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(code), { code, status, ...extra });

function fakeFx(opts: { expiredOnce?: boolean; stepUpOnce?: boolean } = {}) {
  const quotes: { key: string; from: string; to: string }[] = [];
  const converts: { quoteId: string; key: string }[] = [];
  let expired = opts.expiredOnce ?? false;
  let stepUp = opts.stepUpOnce ?? false;
  let n = 0;
  let now = T0;
  const api: FxApi = {
    async quote(input, key) {
      quotes.push({ key, from: input.from.minor, to: input.to });
      const minor = BigInt(input.from.minor);
      const gross = input.to === 'ILS' ? minor * 371n / 100n : minor * 269_542n / 1_000_000n;
      const markup = (gross * 75n + 5_000n) / 10_000n;
      const q: FxQuote = { quoteId: `fxq_${++n}`, from: input.from, total: { minor: (gross - markup).toString(), currency: input.to }, markup: { minor: markup.toString(), currency: input.to }, markupBps: 75, rate: input.to === 'ILS' ? '3.710000' : '0.269542', expiresAt: new Date(now.getTime() + 30_000).toISOString() };
      return q;
    },
    async convert(quoteId, key) {
      if (stepUp) {
        stepUp = false;
        throw problem('STEP_UP_REQUIRED', 401);
      }
      if (expired) {
        expired = false;
        throw problem('QUOTE_EXPIRED', 409, { quoteId });
      }
      converts.push({ quoteId, key });
      const c: FxConversion = { conversionId: `fxc_${converts.length}`, quoteId, from: { minor: '10000', currency: 'USD' }, total: { minor: '36822', currency: 'ILS' }, status: 'settled' };
      return c;
    },
  };
  const accounts = async () => ({ items: [{ id: 'u', currency: 'USD', settled: { minor: '50000', currency: 'USD' }, holds: { minor: '0', currency: 'USD' }, available: { minor: '50000', currency: 'USD' } }, { id: 'i', currency: 'ILS', settled: { minor: '0', currency: 'ILS' }, holds: { minor: '0', currency: 'ILS' }, available: { minor: '0', currency: 'ILS' } }] as Account[] });
  return { api, accounts, quotes, converts, setNow: (d: Date) => void (now = d), nowRef: () => now };
}

describe('helpers', () => {
  it('parses amounts, swaps currencies, formats the markup and counts down', () => {
    expect(parseAmount('100', 'USD')).toEqual({ amount: { minor: 10_000n, currency: 'USD' } });
    expect(parseAmount('0', 'USD')).toEqual({ problem: 'fx.amount.zero' });
    expect(parseAmount('x', 'USD')).toEqual({ problem: 'fx.amount.invalid' });
    expect(other('USD')).toBe('ILS');
    expect(other('ILS')).toBe('USD');
    expect(markupPercent(75)).toBe('0.75%');
    expect(markupPercent(100)).toBe('1%');
    expect(markupPercent(0)).toBe('0%');
    const q: FxQuote = { quoteId: 'q', from: { minor: '1', currency: 'USD' }, total: { minor: '1', currency: 'ILS' }, markup: { minor: '0', currency: 'ILS' }, markupBps: 75, rate: '3.71', expiresAt: new Date(T0.getTime() + 30_000).toISOString() };
    expect(secondsLeft(q, T0)).toBe(30);
    expect(secondsLeft(q, new Date(T0.getTime() + 29_100))).toBe(1);
    expect(secondsLeft(q, new Date(T0.getTime() + 30_000))).toBe(0);
    expect(secondsLeft(q, new Date(T0.getTime() + 60_000))).toBe(0);
    expect(secondsLeft(undefined, T0)).toBe(0);
    expect(problemFor(problem('QUOTE_EXPIRED', 409), 'en')).toBe('expired');
    expect(problemFor(problem('INSUFFICIENT_FUNDS', 422, { available: '1234', currency: 'USD' }), 'en')).toEqual({ key: 'fx.insufficient', vars: { available: '$12.34' } });
  });
});

describe('TST-FX-001/002 at the screen', () => {
  it('a $100 quote shows rate, markup and total, counts down 30 s, and converts once under the quote\'s key', async () => {
    const f = fakeFx();
    let k = 0;
    const m = createFxModel({ fx: f.api, accounts: f.accounts, newKey: () => `k${++k}`, now: f.nowRef });
    await m.load();
    expect(m.store.get()).toMatchObject({ mode: 'ready', from: 'USD' });
    m.setAmount('100');
    await m.getQuote();
    const s = m.store.get();
    expect(f.quotes).toEqual([{ key: 'k1', from: '10000', to: 'ILS' }]);
    expect(s.quote).toMatchObject({ rate: '3.710000', markupBps: 75, markup: { minor: '278', currency: 'ILS' }, total: { minor: '36822', currency: 'ILS' } });
    expect(s).toMatchObject({ convertKey: 'k2', secondsLeft: 30 });
    f.setNow(new Date(T0.getTime() + 12_000));
    m.tick();
    expect(m.store.get().secondsLeft).toBe(18);
    await m.confirm();
    expect(f.converts).toEqual([{ quoteId: 'fxq_1', key: 'k2' }]);
    expect(m.store.get()).toMatchObject({ result: { conversionId: 'fxc_1', status: 'settled' }, quote: undefined, notice: { key: 'fx.done', vars: { total: '₪368.22' } } });
    m.reset();
    expect(m.store.get()).toMatchObject({ amountText: '', result: undefined });
  });

  it('the countdown reaching zero drops the quote; confirming at zero, or getting QUOTE_EXPIRED, fetches a fresh quote with a fresh key', async () => {
    const f = fakeFx({ expiredOnce: true });
    let k = 0;
    const m = createFxModel({ fx: f.api, accounts: f.accounts, newKey: () => `k${++k}`, now: f.nowRef });
    await m.load();
    m.setAmount('100');
    await m.getQuote();
    expect(m.store.get().quote?.quoteId).toBe('fxq_1');
    // The server says expired (its clock is the one that counts): a fresh quote, a fresh key, and the member is told.
    await m.confirm();
    expect(f.converts).toEqual([]);
    expect(m.store.get()).toMatchObject({ quote: { quoteId: 'fxq_2' }, convertKey: 'k4', notice: { key: 'fx.expired' }, busy: false });
    // The clock runs out locally: the quote is dropped with the notice, and a confirm at zero refreshes instead of calling the server.
    f.setNow(new Date(f.nowRef().getTime() + 31_000));
    m.tick();
    expect(m.store.get()).toMatchObject({ quote: undefined, secondsLeft: 0, notice: { key: 'fx.expired' } });
    await m.getQuote();
    expect(m.store.get().quote?.quoteId).toBe('fxq_3');
    f.setNow(new Date(f.nowRef().getTime() + 31_000));
    await m.confirm();
    expect(f.converts).toEqual([]);
    expect(m.store.get().quote?.quoteId).toBe('fxq_4');
    await m.confirm();
    expect(f.converts).toEqual([{ quoteId: 'fxq_4', key: 'k8' }]);
  });

  it('a step-up keeps the quote and its key; insufficient funds and bad amounts are refused before any quote', async () => {
    const f = fakeFx({ stepUpOnce: true });
    let k = 0;
    const m = createFxModel({ fx: f.api, accounts: f.accounts, newKey: () => `k${++k}`, now: f.nowRef });
    await m.load();
    m.setAmount('abc');
    await m.getQuote();
    expect(m.store.get().error).toEqual({ key: 'fx.amount.invalid' });
    m.setAmount('600');
    await m.getQuote();
    expect(m.store.get().error).toEqual({ key: 'fx.insufficient', vars: { available: '$500.00' } });
    expect(f.quotes).toEqual([]);
    m.swap();
    expect(m.store.get().from).toBe('ILS');
    m.swap();
    m.setAmount('100');
    await m.getQuote();
    await m.confirm();
    expect(m.store.get()).toMatchObject({ needsStepUp: true, quote: { quoteId: 'fxq_1' }, convertKey: 'k2' });
    m.stepUpDone();
    await m.confirm();
    expect(f.converts).toEqual([{ quoteId: 'fxq_1', key: 'k2' }]);
  });
});
