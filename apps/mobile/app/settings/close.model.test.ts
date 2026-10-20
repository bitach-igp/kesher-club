// T-0526 M34 close account (screen rows of TST-WAL-005): money left shows the refund plan and offers
// "refund and close", never a bare close, and the account closes only after the refund ($30 to the
// funder's source, REQ-WAL-005); an empty account closes directly; "already closing" shows progress;
// holds block the close with the reason; a step-up refusal keeps the attempt key.
import { describe, expect, it } from 'vitest';
import type { Closure, ClosureApi } from '../../src/api.ts';
import { amountsText, createCloseModel, phaseOf, refundPlan } from './close.model.ts';

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const usd = (minor: string) => ({ minor, currency: 'USD' as const });
const ils = (minor: string) => ({ minor, currency: 'ILS' as const });
const closure = (over: Partial<Closure> = {}): Closure => ({ state: 'open', balances: [{ currency: 'USD', available: usd('3000'), holds: usd('0') }, { currency: 'ILS', available: ils('0'), holds: ils('0') }], refunds: [], ...over });

function setup(reads: Closure[], closes: (Closure | Error)[]) {
  const keys: string[] = [];
  let n = 0;
  const api: ClosureApi = {
    get: async () => reads.shift() ?? reads[0]!,
    async close(key) {
      keys.push(key);
      const r = closes.shift();
      if (!r) throw new Error('unexpected close');
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { model: createCloseModel({ closure: api, newKey: () => `key-${++n}` }), keys };
}

describe('M34 close account (T-0526)', () => {
  it('$30 left: shows the refund plan and offers refund-and-close, then closes only once the refund arrives', async () => {
    const refunding = closure({ state: 'refunding', balances: [{ currency: 'USD', available: usd('0'), holds: usd('0') }, { currency: 'ILS', available: ils('0'), holds: ils('0') }], refunds: [{ id: 'r1', amount: usd('3000'), state: 'pending' }] });
    const closed = closure({ state: 'closed', balances: refunding.balances, refunds: [{ id: 'r1', amount: usd('3000'), state: 'settled' }], closedAt: '2026-11-01T10:00:00Z' });
    const { model, keys } = setup([closure(), closed], [refunding]);
    await model.load();
    const open = model.store.get().closure!;
    expect(phaseOf(open)).toBe('refund_first');
    expect(refundPlan(open)).toEqual([{ minor: 3_000n, currency: 'USD' }]);
    expect(amountsText(refundPlan(open), 'en')).toBe('$30.00');
    await model.close();
    expect(keys).toEqual(['key-1']);
    expect(phaseOf(model.store.get().closure!)).toBe('refunding');
    // While refunding nothing more can be pressed.
    await model.close();
    expect(keys).toEqual(['key-1']);
    await model.load();
    expect(phaseOf(model.store.get().closure!)).toBe('closed');
  });

  it('an empty account closes directly', async () => {
    const empty = closure({ balances: [{ currency: 'USD', available: usd('0'), holds: usd('0') }, { currency: 'ILS', available: ils('0'), holds: ils('0') }] });
    const { model } = setup([empty], [{ ...empty, state: 'closed', closedAt: '2026-11-01T10:00:00Z' }]);
    await model.load();
    expect(phaseOf(model.store.get().closure!)).toBe('empty');
    await model.close();
    expect(phaseOf(model.store.get().closure!)).toBe('closed');
  });

  it('already closing (IDEMPOTENCY_CONFLICT) shows progress, not an error', async () => {
    const refunding = closure({ state: 'refunding', refunds: [{ id: 'r1', amount: usd('3000'), state: 'pending' }] });
    const { model } = setup([closure(), refunding], [new Problem('IDEMPOTENCY_CONFLICT', 409)]);
    await model.load();
    await model.close();
    expect(model.store.get()).toMatchObject({ error: undefined, notice: { key: 'close.inProgress' }, closure: { state: 'refunding' } });
  });

  it('holds block the close and say why; there is nothing to press', async () => {
    const blocked = closure({ state: 'blocked', blockedReason: 'HOLDS_OUTSTANDING', balances: [{ currency: 'USD', available: usd('3000'), holds: usd('1500') }, { currency: 'ILS', available: ils('0'), holds: ils('0') }] });
    const { model, keys } = setup([blocked], []);
    await model.load();
    expect(phaseOf(model.store.get().closure!)).toBe('blocked');
    await model.close();
    expect(keys).toEqual([]);
  });

  it('a step-up refusal keeps the attempt key for the retry, so the close runs once', async () => {
    const { model, keys } = setup([closure()], [new Problem('STEP_UP_REQUIRED', 401), closure({ state: 'refunding', refunds: [{ id: 'r1', amount: usd('3000'), state: 'pending' }] })]);
    await model.load();
    await model.close();
    expect(model.store.get()).toMatchObject({ needsStepUp: true, attemptKey: 'key-1' });
    await model.close();
    expect(keys).toEqual(['key-1', 'key-1']);
    expect(model.store.get()).toMatchObject({ needsStepUp: false, attemptKey: undefined, closure: { state: 'refunding' } });
  });

  it('both purses with money: the plan names both, in Hebrew too', () => {
    const both = closure({ balances: [{ currency: 'USD', available: usd('3000'), holds: usd('0') }, { currency: 'ILS', available: ils('12000'), holds: ils('0') }] });
    expect(amountsText(refundPlan(both), 'en')).toBe('$30.00 and ₪120.00');
    expect(amountsText(refundPlan(both), 'he')).toContain(' ו־');
  });
});
