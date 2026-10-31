// T-0311 P13 billing in funder mode (TST-BIL-004 at the screen): only the memberships the funder pays for; renews or
// ends on a date; Cancel takes two taps, and the confirm says the membership runs to the end of the paid period and
// the member keeps their money; a retry keeps its key; a cancelled one reads "Ends on {date}" in both languages;
// refusals read as sentences.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import type { FunderApi, MembershipRow } from '../../src/api.ts';
import { COPY, t } from '../../src/i18n.ts';
import { createBillingModel, dateText, lineOf, refusal } from './billing.model.ts';

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const PERIOD_END = '2026-12-10T12:00:00Z';
const DANA: MembershipRow = { id: 'm-dana', role: 'funder', memberPartyId: 'p-dana', memberName: 'Dana E.', planCode: 'demo-club-us', status: 'active', price: { minor: '4900', currency: 'USD' }, currentPeriodEnd: PERIOD_END };
const OWN: MembershipRow = { id: 'm-own', role: 'member', memberPartyId: 'p-ben', planCode: 'demo-club-us', status: 'active', price: { minor: '4900', currency: 'USD' } };

function setup(fail: Error[] = []) {
  let rows: MembershipRow[] = [DANA, OWN];
  const cancels: { id: string; key: string }[] = [];
  let n = 0;
  const funder: Pick<FunderApi, 'memberships' | 'cancelMembership'> = {
    async memberships() {
      return { items: rows };
    },
    async cancelMembership(id, key) {
      cancels.push({ id, key });
      const f = fail.shift();
      if (f) throw f;
      rows = rows.map((r) => (r.id === id ? { ...r, cancelAt: PERIOD_END } : r));
      return rows.find((r) => r.id === id)!;
    },
  };
  return { model: createBillingModel({ funder, newKey: () => `cancel-${++n}-000` }), cancels, end: () => (rows = rows.map((r) => ({ ...r, status: 'cancelled' as const }))) };
}

describe('T-0311 P13 billing in funder mode', () => {
  it("lists only what the funder pays for: who, plan, price, and when it renews", async () => {
    const { model } = setup();
    await model.load();
    const s = model.store.get();
    expect(s.mode).toBe('ready');
    expect(s.rows).toEqual([{ id: 'm-dana', name: 'Dana E.', planCode: 'demo-club-us', price: money(4_900n, 'USD'), status: 'active', line: { key: 'billing.renewsOn', date: PERIOD_END }, cancellable: true }]);
  });

  it('two taps to cancel: the first asks and sends nothing, Keep it backs out, the second cancels', async () => {
    const { model, cancels } = setup();
    await model.load();
    model.askCancel('m-dana');
    expect(model.store.get().confirming).toBe('m-dana');
    expect(cancels).toEqual([]);
    model.keep();
    expect(model.store.get().confirming).toBeUndefined();
    await model.confirmCancel();
    expect(cancels).toEqual([]);

    model.askCancel('m-dana');
    await model.confirmCancel();
    const s = model.store.get();
    expect(cancels).toHaveLength(1);
    expect(s).toMatchObject({ confirming: undefined, notice: 'billing.cancelled' });
    expect(s.rows[0]).toMatchObject({ line: { key: 'billing.endsOn', date: PERIOD_END }, cancellable: false });
    // Once cancelled, Cancel is not offered again.
    model.askCancel('m-dana');
    expect(model.store.get().confirming).toBeUndefined();
  });

  it('the confirm says what happens to the membership and to the money, in both languages', () => {
    expect(COPY.en['billing.cancel.confirm']).toMatch(/end of the paid period/);
    expect(COPY.en['billing.cancel.confirm']).toMatch(/money already loaded stays theirs/);
    expect(COPY.he['billing.cancel.confirm']).toMatch(/הכסף שכבר נטען נשאר שלהם/);
  });

  it('a retry keeps its key', async () => {
    const { model, cancels } = setup([new Problem('PROVIDER_UNAVAILABLE', 503)]);
    await model.load();
    model.askCancel('m-dana');
    await model.confirmCancel();
    expect(model.store.get()).toMatchObject({ error: 'common.error.unavailable', confirming: 'm-dana' });
    await model.confirmCancel();
    expect(cancels.map((c) => c.key)).toEqual(['cancel-1-000', 'cancel-1-000']);
    expect(model.store.get().notice).toBe('billing.cancelled');
  });

  it('ends-on reads in both languages; an ended membership reads Ended, and past due as a sentence', () => {
    expect(t('billing.endsOn', 'en', { date: dateText(PERIOD_END, 'en') })).toBe('Ends on December 10, 2026');
    expect(t('billing.endsOn', 'he', { date: dateText(PERIOD_END, 'he') })).toBe('מסתיימת ב־10 בדצמבר 2026');
    expect(lineOf({ status: 'cancelled', cancelAt: PERIOD_END })).toEqual({ key: 'billing.ended' });
    expect(lineOf({ status: 'past_due' })).toEqual({ key: 'billing.pastDue' });
    expect(COPY.he['billing.pastDue']).toMatch(/\.$/);
  });

  it('an ended membership answers 409 and the list is read again; refusals read as sentences', async () => {
    const { model, end } = setup([new Problem('IDEMPOTENCY_CONFLICT', 409)]);
    await model.load();
    model.askCancel('m-dana');
    end();
    await model.confirmCancel();
    expect(model.store.get()).toMatchObject({ error: 'billing.error.ended', confirming: undefined });
    expect(model.store.get().rows[0]).toMatchObject({ line: { key: 'billing.ended' }, cancellable: false });
    expect(refusal(new Problem('FORBIDDEN', 403))).toBe('billing.error.notFunder');
    expect(refusal(new Problem('NOT_FOUND', 404))).toBe('billing.error.notFound');
    expect(refusal(new Error('boom'))).toBe('common.error.generic');
  });
});
