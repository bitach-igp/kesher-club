// T-0612 I09 Payouts (screen rows of TST-PO-001, TST-PO-002, TST-INS-004): a bad IBAN never reaches the
// API; a new payee over ₪2,000 shows when its cooling-off ends; the requester cannot approve; a reject
// needs a reason; a step-up keeps the attempt key; more than the account holds is caught before the call.
import { describe, expect, it } from 'vitest';
import type { Result } from './api.ts';
import { approvePayout, canDecide, checkDraft, parseShekels, rejectPayout, submitPayout, type InstitutionPayout, type PayoutDeps, type PayoutRequest } from './payouts.ts';
import { withStepUp } from './step-up.ts';

const GOOD = 'IL62 0108 0000 0009 9999 999';
const payout = (over: Partial<InstitutionPayout> = {}): InstitutionPayout => ({ id: 'p1', state: 'awaiting_second_approval', amount: { minor: '600000', currency: 'ILS' }, payee: { name: 'Building Supplies Ltd', ibanLast4: '9999' }, reference: 'roof', createdAt: '2026-11-10T09:00:00Z', approvedBy: [{ displayName: 'Finance •••• 0109' }], requiredApprovals: 2, requestedByMe: false, ...over });

function fake(answers: Result<InstitutionPayout>[], stepUp = true) {
  const calls = { create: [] as { body: PayoutRequest; key: string }[], approve: [] as string[], reject: [] as { id: string; reason: string }[], stepUp: 0 };
  let n = 0;
  const next = () => answers.shift() ?? { ok: false as const, code: 'NOT_FOUND' };
  const deps: PayoutDeps = {
    async create(body, key) {
      calls.create.push({ body, key });
      return next();
    },
    async approve(_id, key) {
      calls.approve.push(key);
      return next();
    },
    async reject(id, reason) {
      calls.reject.push({ id, reason });
      return next();
    },
    async stepUp() {
      calls.stepUp += 1;
      return stepUp;
    },
    newKey: () => `key-${++n}`,
  };
  return { deps, calls };
}

describe('I09 payouts (T-0612)', () => {
  it('a bad IBAN never reaches the API: a wrong checksum, a foreign IBAN, garbage', async () => {
    for (const iban of ['IL62 0108 0000 0009 9999 998', 'GB29 NWBK 6016 1331 9268 19', 'not an iban']) {
      const { deps, calls } = fake([]);
      expect(await submitPayout(deps, { name: 'Supplier', iban, amountText: '100', reference: 'x' }, 10_000_000n)).toEqual({ kind: 'invalid', problems: ['iban'] });
      expect(calls.create).toEqual([]);
    }
  });

  it('a good draft goes out normalised, in agorot as a string; over the account balance is caught first', () => {
    expect(checkDraft({ name: '  Building   Supplies Ltd ', iban: GOOD, amountText: '6,000.50', reference: ' roof ' }, 1_000_000n)).toEqual({ ok: true, body: { payee: { iban: 'IL620108000000099999999', name: 'Building Supplies Ltd' }, amount: { minor: '600050', currency: 'ILS' }, reference: 'roof' } });
    expect(checkDraft({ name: 'S', iban: GOOD, amountText: '10000.01', reference: 'r' }, 1_000_000n)).toEqual({ ok: false, problems: ['over_balance'] });
    expect([parseShekels('0'), parseShekels('1.234'), parseShekels('12.5')]).toEqual([undefined, undefined, 1_250n]);
  });

  it('a new payee over ₪2,000 comes back cooling off with its end time; the step-up keeps the attempt key', async () => {
    const cooling = payout({ state: 'cooling_off', amount: { minor: '300000', currency: 'ILS' }, coolOffEndsAt: '2026-11-11T09:00:00Z', requiredApprovals: 0, approvedBy: [], requestedByMe: true });
    const { deps, calls } = fake([{ ok: false, code: 'STEP_UP_REQUIRED' }, { ok: true, value: cooling }]);
    expect(await submitPayout(deps, { name: 'New Supplier', iban: GOOD, amountText: '3000', reference: 'chairs' }, 10_000_000n)).toEqual({ kind: 'done', payout: cooling });
    expect([calls.create.map((c) => c.key), calls.stepUp]).toEqual([['key-1', 'key-1'], 1]);
  });

  it('the requester cannot approve; a second finance member can; staff never can; a cancelled step-up moves nothing', async () => {
    expect(canDecide(payout({ requestedByMe: true }), 'finance')).toBe(false);
    expect(canDecide(payout(), 'finance')).toBe(true);
    expect(canDecide(payout(), 'staff')).toBe(false);
    expect(canDecide(payout({ state: 'cooling_off' }), 'finance')).toBe(false);
    const { deps, calls } = fake([{ ok: false, code: 'STEP_UP_REQUIRED' }], false);
    expect(await approvePayout(deps, 'p1')).toEqual({ kind: 'cancelled' });
    expect(calls.approve).toEqual(['key-1']);
  });

  it('a reject needs a reason: a blank one is never sent', async () => {
    const { deps, calls } = fake([{ ok: true, value: payout({ state: 'rejected', failureCode: 'REJECTED' }) }]);
    expect(await rejectPayout(deps, 'p1', '   ')).toEqual({ kind: 'invalid', problems: ['reference'] });
    expect(calls.reject).toEqual([]);
    expect(await rejectPayout(deps, 'p1', ' Wrong supplier ')).toMatchObject({ kind: 'done', payout: { state: 'rejected' } });
    expect(calls.reject).toEqual([{ id: 'p1', reason: 'Wrong supplier' }]);
  });

  it('withStepUp passes anything but STEP_UP_REQUIRED straight through', async () => {
    let tries = 0;
    expect(await withStepUp(async () => (tries++, { ok: false, code: 'INSUFFICIENT_FUNDS' }), async () => true)).toEqual({ ok: false, code: 'INSUFFICIENT_FUNDS' });
    expect(tries).toBe(1);
  });
});
