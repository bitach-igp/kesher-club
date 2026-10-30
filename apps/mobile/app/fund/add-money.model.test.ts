// T-0524 P07 add money (screen rows of TST-WAL-002 card and wallet loads, TST-WAL-003 ACH hold,
// TST-WAL-006 the other purse at the club rate). Money is compared as bigint.
import { describe, expect, it } from 'vitest';
import type { FundApi, FxQuote, Load } from '../../src/api.ts';
import { createAddMoneyModel, type PaymentSheet } from './add-money.model.ts';

const NOW = new Date('2026-11-01T09:00:00Z');
const SELF = '0190a0a0-0000-7000-8000-000000000001';

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const quoteFor = (fromMinor: string, totalMinor: string, expiresInS = 30): FxQuote => ({ quoteId: 'q1', from: { minor: fromMinor, currency: 'USD' }, total: { minor: totalMinor, currency: 'ILS' }, markup: { minor: '278', currency: 'ILS' }, markupBps: 75, rate: '3.7000', rateVersion: 12, quotedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + expiresInS * 1000).toISOString() });

function setup(opts: { ach?: boolean; loads?: (Load | Error)[]; quotes?: (FxQuote | Error)[]; sheet?: 'completed' | 'cancelled'; now?: () => Date } = {}) {
  const loads: { input: Parameters<FundApi['createLoad']>[0]; key: string }[] = [];
  const quotes: unknown[] = [];
  const sheets: string[] = [];
  const queue = [...(opts.loads ?? [])];
  const quoteQueue = [...(opts.quotes ?? [])];
  let n = 0;
  const fund: FundApi = {
    members: async () => [{ partyId: SELF, self: true }],
    async createLoad(input, key) {
      loads.push({ input, key });
      await Promise.resolve();
      const next = queue.shift() ?? { id: 'l1', amount: input.amount, state: 'settled' };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const paymentSheet: PaymentSheet = {
    async present(clientSecret) {
      sheets.push(clientSecret);
      return opts.sheet ?? 'completed';
    },
  };
  const model = createAddMoneyModel({
    fund,
    fx: {
      async quote(input) {
        quotes.push(input);
        const next = quoteQueue.shift() ?? quoteFor(input.from.minor, '37000');
        if (next instanceof Error) throw next;
        return next;
      },
    },
    capabilities: async () => ({ features: { 'funding.ach': opts.ach ?? false } }),
    paymentSheet,
    newKey: () => `key-${++n}`,
    now: opts.now ?? (() => NOW),
  });
  return { model, loads, quotes, sheets };
}

describe('P07 add money (T-0524)', () => {
  it('a card load into the same purse settles once and the receipt shows what was paid and credited', async () => {
    const { model, loads } = setup();
    await model.load();
    expect(model.store.get()).toMatchObject({ mode: 'ready', memberPartyId: SELF, method: 'card' });
    model.setAmount('50');
    await model.confirm();
    expect(loads).toEqual([{ input: { memberPartyId: SELF, amount: { minor: '5000', currency: 'USD' }, method: 'card', purseCurrency: 'USD' }, key: 'key-1' }]);
    const r = model.store.get().receipt!;
    expect(r.paid.minor).toBe(5000n);
    expect(r.credited.minor).toBe(5000n);
    expect(r.state).toBe('settled');
  });

  it('the purse choice drives the quote; the receipt keeps both amounts and the rate version (TST-WAL-006)', async () => {
    const { model, quotes, loads } = setup({ loads: [{ id: 'l1', amount: { minor: '10000', currency: 'USD' }, credited: { minor: '37000', currency: 'ILS' }, rateVersion: 12, state: 'settled' }] });
    await model.load();
    model.setAmount('100');
    expect(quotes).toEqual([]);
    await model.setPurse('ILS');
    expect(quotes).toEqual([{ from: { minor: '10000', currency: 'USD' }, to: 'ILS' }]);
    expect(model.store.get().quote).toMatchObject({ rateVersion: 12, total: { minor: '37000' } });
    await model.confirm();
    expect(loads[0]!.input).toMatchObject({ amount: { minor: '10000', currency: 'USD' }, purseCurrency: 'ILS' });
    const r = model.store.get().receipt!;
    expect([r.paid.minor, r.paid.currency, r.credited.minor, r.credited.currency, r.rateVersion]).toEqual([10000n, 'USD', 37000n, 'ILS', 12]);
  });

  it('an expired quote asks again instead of loading, and QUOTE_EXPIRED from the server re-quotes too', async () => {
    let now = NOW;
    const { model, quotes, loads } = setup({ now: () => now, loads: [new Problem('QUOTE_EXPIRED', 409)] });
    await model.load();
    model.setAmount('100');
    await model.setPurse('ILS');
    now = new Date(NOW.getTime() + 31_000);
    model.tick();
    expect(model.store.get()).toMatchObject({ quote: undefined, notice: { key: 'fund.quote.expired' } });
    await model.confirm();
    expect(loads).toHaveLength(0);
    expect(quotes).toHaveLength(2);

    now = NOW;
    await model.confirm();
    expect(loads).toHaveLength(1);
    expect(quotes).toHaveLength(3);
    expect(model.store.get().notice).toEqual({ key: 'fund.quote.expired' });
  });

  it('requires_action hands the client secret to the payment sheet; completed shows processing, cancelled keeps the attempt', async () => {
    const pending: Load = { id: 'l1', amount: { minor: '2500', currency: 'USD' }, state: 'requires_action', clientSecret: 'pi_secret_1' };
    const done = setup({ loads: [pending] });
    await done.model.load();
    done.model.setAmount('25');
    await done.model.confirm();
    expect(done.sheets).toEqual(['pi_secret_1']);
    expect(done.model.store.get().receipt).toMatchObject({ state: 'processing' });

    const cancelled = setup({ loads: [pending, pending], sheet: 'cancelled' });
    await cancelled.model.load();
    cancelled.model.setAmount('25');
    await cancelled.model.confirm();
    expect(cancelled.model.store.get()).toMatchObject({ receipt: undefined, notice: { key: 'fund.sheet.cancelled' }, attemptKey: 'key-1' });
    await cancelled.model.confirm();
    expect(cancelled.loads.map((l) => l.key)).toEqual(['key-1', 'key-1']);
  });

  it('ACH shows only while funding.ach is on, and an on_hold load shows its release date (TST-WAL-003)', async () => {
    const off = setup({ ach: false });
    await off.model.load();
    off.model.setMethod('ach');
    expect(off.model.store.get().method).toBe('card');

    const on = setup({ ach: true, loads: [{ id: 'l1', amount: { minor: '5000', currency: 'USD' }, state: 'on_hold', holdUntil: '2026-11-04' }] });
    await on.model.load();
    on.model.setMethod('ach');
    on.model.setAmount('50');
    await on.model.confirm();
    expect(on.loads[0]!.input.method).toBe('ach');
    expect(on.model.store.get().receipt).toMatchObject({ state: 'on_hold', holdUntil: '2026-11-04' });
    expect(on.model.store.get().receipt!.credited.minor).toBe(5000n);
  });

  it('LIMIT_EXCEEDED and FEATURE_OFF show their copy; a declined load says nothing was charged', async () => {
    for (const [error, key] of [[new Problem('LIMIT_EXCEEDED', 422), 'fund.limit'], [new Problem('FEATURE_OFF', 404), 'fund.off']] as const) {
      const { model } = setup({ loads: [error] });
      await model.load();
      model.setAmount('50');
      await model.confirm();
      expect(model.store.get().error).toEqual({ key });
    }
    const declined = setup({ loads: [{ id: 'l1', amount: { minor: '5000', currency: 'USD' }, state: 'failed' }] });
    await declined.model.load();
    declined.model.setAmount('50');
    await declined.model.confirm();
    expect(declined.model.store.get()).toMatchObject({ error: { key: 'fund.declined' }, receipt: undefined });
  });

  it('a double tap is one load, and a retry after a network error reuses the attempt key', async () => {
    const { model, loads } = setup({ loads: [new TypeError('Failed to fetch')] });
    await model.load();
    model.setAmount('50');
    await Promise.all([model.confirm(), model.confirm()]);
    expect(loads).toHaveLength(1);
    expect(model.store.get().error).toEqual({ key: 'common.error.generic' });
    await Promise.all([model.confirm(), model.confirm()]);
    expect(loads.map((l) => l.key)).toEqual(['key-1', 'key-1']);
    expect(model.store.get().receipt!.paid.minor).toBe(5000n);
    await model.confirm();
    expect(loads).toHaveLength(2);
  });

  it('a step-up refusal asks for the passkey and keeps the attempt; changing the amount starts a new one', async () => {
    const { model, loads } = setup({ loads: [new Problem('STEP_UP_REQUIRED', 401)] });
    await model.load();
    model.setAmount('50');
    await model.confirm();
    expect(model.store.get()).toMatchObject({ needsStepUp: true, attemptKey: 'key-1' });
    model.setAmount('60');
    expect(model.store.get()).toMatchObject({ needsStepUp: false, attemptKey: undefined });
    await model.confirm();
    expect(loads.map((l) => [l.key, l.input.amount.minor])).toEqual([['key-1', '5000'], ['key-2', '6000']]);
  });
});
