// @vitest-environment jsdom
// T-0524 screen smoke test through react-native-web: each state of P07 renders (form, the club-rate
// quote, ACH with its notice, the receipt settled, held and processing, an error), in English and Hebrew.
// Behaviour lives in add-money.model.test.ts.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FundApi, Load } from '../../src/api.ts';
import { LocaleProvider, type Locale } from '../../src/i18n.ts';
import { createAddMoneyModel } from './add-money.model.ts';
import { AddMoneyView } from './add-money.tsx';

const NOW = new Date('2026-11-01T09:00:00Z');

function mount(load: Load, opts: { ach?: boolean; locale?: Locale } = {}) {
  const fund: FundApi = { members: async () => [{ partyId: 'p1', self: true }], createLoad: async () => load };
  const model = createAddMoneyModel({
    fund,
    fx: { quote: async (i) => ({ quoteId: 'q', from: i.from, total: { minor: '37000', currency: 'ILS' }, markup: { minor: '278', currency: 'ILS' }, markupBps: 75, rate: '3.7000', rateVersion: 12, expiresAt: new Date(NOW.getTime() + 30_000).toISOString() }) },
    capabilities: async () => ({ features: { 'funding.ach': opts.ach ?? false } }),
    paymentSheet: { present: async () => 'completed' },
    newKey: () => 'k',
    now: () => NOW,
  });
  render(
    <LocaleProvider value={opts.locale ?? 'en'}>
      <AddMoneyView model={model} />
    </LocaleProvider>,
  );
  return model;
}

afterEach(cleanup);

describe('P07 add money screen (T-0524)', () => {
  it('shows the form, then the receipt with what was paid and credited', async () => {
    const model = mount({ id: 'l1', amount: { minor: '5000', currency: 'USD' }, state: 'settled' });
    await screen.findByTestId('fund-amount');
    expect(screen.queryByTestId('fund-method-ach')).toBeNull();
    await act(async () => model.setAmount('50'));
    expect(screen.getByTestId('fund-confirm').textContent).toContain('$50.00');
    await act(async () => model.confirm());
    expect(screen.getByTestId('fund-receipt-paid').textContent).toContain('$50.00');
    expect(screen.getByTestId('fund-receipt-credited').textContent).toContain('$50.00');
  });

  it('shows the club-rate quote for the other purse, with what lands and the rate version', async () => {
    const model = mount({ id: 'l1', amount: { minor: '10000', currency: 'USD' }, credited: { minor: '37000', currency: 'ILS' }, rateVersion: 12, state: 'settled' });
    await screen.findByTestId('fund-amount');
    await act(async () => model.setAmount('100'));
    await act(async () => model.setPurse('ILS'));
    const quote = screen.getByTestId('fund-quote-card').textContent!;
    expect(quote).toContain('370.00');
    expect(quote).toContain('version 12');
    await act(async () => model.confirm());
    expect(screen.getByTestId('fund-receipt-credited').textContent).toContain('370.00');
  });

  it('offers ACH while funding.ach is on, says it is held, and shows the release date on the receipt', async () => {
    const model = mount({ id: 'l1', amount: { minor: '5000', currency: 'USD' }, state: 'on_hold', holdUntil: '2026-11-04T00:00:00Z' }, { ach: true });
    await screen.findByTestId('fund-method-ach');
    await act(async () => model.setMethod('ach'));
    expect(screen.getByTestId('fund-ach-notice')).toBeTruthy();
    await act(async () => model.setAmount('50'));
    await act(async () => model.confirm());
    expect(screen.getByTestId('fund-receipt-hold').textContent).toContain('Nov');
  });

  it('shows processing after the payment sheet, and an error banner on a refusal', async () => {
    const model = mount({ id: 'l1', amount: { minor: '2500', currency: 'USD' }, state: 'requires_action', clientSecret: 's' });
    await screen.findByTestId('fund-amount');
    await act(async () => model.setAmount('abc'));
    await act(async () => model.confirm());
    expect(screen.getByTestId('fund-error')).toBeTruthy();
    await act(async () => model.setAmount('25'));
    await act(async () => model.confirm());
    expect(screen.getByTestId('fund-receipt-processing')).toBeTruthy();
  });

  it('renders in Hebrew', async () => {
    mount({ id: 'l1', amount: { minor: '5000', currency: 'USD' }, state: 'settled' }, { locale: 'he' });
    await screen.findByTestId('fund-amount');
    expect(screen.getByTestId('screen-add-money').textContent).toContain('הוספת כסף');
  });
});
