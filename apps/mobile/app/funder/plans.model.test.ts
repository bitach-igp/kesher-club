// T-0308 P01–P03 (TST-BIL-001 and TST-BIL-002 at the screen): the plans offered in a market as cards, money in bigint
// and the monthly price as the API worked it out; switching market lists that market's plans; the card is saved on the
// vendor's sheet, and a cancelled sheet saves nothing; Continue goes to identity verification while T1 is not
// approved, asks for a plan and a card first, and only then opens the invite with the chosen plan.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import type { FunderApi, KycApi, OfferedPlan } from '../../src/api.ts';
import { createPlansModel, planCard, type CardSheet } from './plans.model.ts';

const US: OfferedPlan = { planCode: 'demo-club-us', name: 'Demo Club US', version: 1, market: 'US', price: { minor: '4900', currency: 'USD' }, termMonths: 10, monthlyPrice: { minor: '490', currency: 'USD' }, entitlements: { 'esim.dataGb': { limit: '5', unit: 'gb', period: 'month' }, 'p2p.monthlySendMinor': { limit: '100', unit: 'minor', period: 'month' } }, fxMarkupBps: 75 };
const IL: OfferedPlan = { ...US, planCode: 'demo-club-il', name: 'Demo Club Israel', market: 'IL', price: { minor: '18000', currency: 'ILS' }, monthlyPrice: { minor: '1800', currency: 'ILS' }, entitlements: { 'concierge.calls': { limit: '3', unit: 'calls', period: 'term' } } };

function setup(opts: { tier?: 'T1' | 'T2'; sheet?: 'completed' | 'cancelled' } = {}) {
  const pushed: string[] = [];
  const secrets: string[] = [];
  const funder: Pick<FunderApi, 'plans' | 'setupSheet'> = {
    plans: async (market) => ({ items: market === 'US' ? [US] : [IL] }),
    setupSheet: async () => ({ clientSecret: 'seti_cus_1_secret_sim', wallets: { applePay: true, googlePay: false } }),
  };
  const kyc: Pick<KycApi, 'status'> = { status: async () => ({ status: opts.tier ? 'approved' : 'none', ...(opts.tier ? { approvedTier: opts.tier } : {}) }) as Awaited<ReturnType<KycApi['status']>> };
  const sheet: CardSheet = {
    async present(secret) {
      secrets.push(secret);
      return opts.sheet ?? 'completed';
    },
  };
  const model = createPlansModel({ funder, kyc, sheet, router: { push: (h) => void pushed.push(h), replace: () => undefined, back: () => undefined } });
  return { model, pushed, secrets };
}

describe('T-0308 plans in funder mode', () => {
  it('shows the offered plans in bigint with the monthly price, and only the entitlements the app can put in words', async () => {
    expect(planCard(US)).toEqual({ planCode: 'demo-club-us', name: 'Demo Club US', price: money(4_900n, 'USD'), termMonths: 10, monthly: money(490n, 'USD'), includes: [{ key: 'funder.includes.esim', vars: { count: '5' } }] });
    const { model } = setup({ tier: 'T1' });
    await model.load();
    expect(model.store.get()).toMatchObject({ mode: 'ready', market: 'US', chosen: 'demo-club-us', verified: true });
    await model.setMarket('IL');
    expect(model.store.get().plans.map((p) => [p.planCode, p.price])).toEqual([['demo-club-il', money(18_000n, 'ILS')]]);
    expect(model.store.get().chosen).toBe('demo-club-il');
  });

  it('a funder not yet verified at T1 goes to verification first', async () => {
    const { model, pushed } = setup();
    await model.load();
    expect(model.store.get().verified).toBe(false);
    model.next();
    expect(pushed).toEqual(['/kyc']);
  });

  it('asks for a card before inviting; a cancelled sheet saves nothing; then Continue opens P04 with the chosen plan', async () => {
    const cancelled = setup({ tier: 'T2', sheet: 'cancelled' });
    await cancelled.model.load();
    await cancelled.model.saveCard();
    expect(cancelled.model.store.get()).toMatchObject({ cardSaved: false, notice: 'funder.card.cancelled' });
    cancelled.model.next();
    expect(cancelled.model.store.get().notice).toBe('funder.card.needed');
    expect(cancelled.pushed).toEqual([]);

    const { model, pushed, secrets } = setup({ tier: 'T1' });
    await model.load();
    await model.saveCard();
    expect(secrets).toEqual(['seti_cus_1_secret_sim']);
    expect(model.store.get().cardSaved).toBe(true);
    model.next();
    expect(pushed).toEqual(['/funder/invite?plan=demo-club-us']);
  });
});
