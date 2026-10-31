// T-0538 P06 child detail (TST-WAL-009 at the screen): this month's spend as bars in the currency shown, largest first
// and each a share of the largest, in bigint; shekels one tap away; transactions in words, signed from the member's
// side, a P2P saying which way and never who; a card opens P09; a member no longer funded reads as a sentence.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import type { FunderApi, MemberActivity } from '../../src/api.ts';
import { barsFor, createMemberModel, rowFor } from './member.model.ts';

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const DANA = '0190a0a0-0000-7000-8000-0000000000d0';
const activity: MemberActivity = {
  partyId: DANA,
  displayName: 'Dana E.',
  transactions: [
    { id: 't3', kind: 'p2p', direction: 'out', amount: { minor: '2000', currency: 'USD' }, at: '2026-11-10T09:02:00Z', state: 'settled' },
    { id: 't2', kind: 'card', direction: 'out', amount: { minor: '1200', currency: 'USD' }, at: '2026-11-10T09:01:00Z', state: 'pending', mcc: '5814', country: 'IL' },
    { id: 't1', kind: 'load', direction: 'in', amount: { minor: '50000', currency: 'USD' }, at: '2026-11-10T09:00:00Z', state: 'settled' },
  ],
  spendByCategory: [
    { category: 'food_drink', amount: { minor: '1200', currency: 'USD' } },
    { category: 'groceries', amount: { minor: '3000', currency: 'USD' } },
    { category: 'transport', amount: { minor: '9007199254740993', currency: 'ILS' } },
  ],
  cards: [{ id: 'c1', type: 'virtual', status: 'active', last4: '4242', lockedByFunder: ['atm'] }],
};

function setup(answer: MemberActivity | Error) {
  const routed: string[] = [];
  const funder: Pick<FunderApi, 'member'> = {
    async member(id) {
      expect(id).toBe(DANA);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { model: createMemberModel({ funder, router: { push: (h) => void routed.push(h), replace: () => undefined, back: () => undefined } }, DANA), routed };
}

describe('T-0538 P06 child detail', () => {
  it('bars in the currency shown, largest first, each a share of the largest, in bigint; shekels one tap away', async () => {
    expect(barsFor(activity.spendByCategory, 'USD')).toEqual([
      { category: 'groceries', amount: money(3_000n, 'USD'), percent: 100 },
      { category: 'food_drink', amount: money(1_200n, 'USD'), percent: 40 },
    ]);
    const { model } = setup(activity);
    await model.load();
    expect(model.store.get().bars.map((b) => b.category)).toEqual(['groceries', 'food_drink']);
    model.toggleCurrency();
    expect(model.store.get().bars).toEqual([{ category: 'transport', amount: money(9_007_199_254_740_993n, 'ILS'), percent: 100 }]);
  });

  it('transactions in words, signed from the member, a P2P never naming anyone; a card opens P09', async () => {
    expect(activity.transactions.map(rowFor).map((r) => [r.title, r.amount, r.state])).toEqual([
      ['member.tx.p2p.out', money(-2_000n, 'USD'), 'settled'],
      ['member.tx.card', money(-1_200n, 'USD'), 'pending'],
      ['member.tx.load', money(50_000n, 'USD'), 'settled'],
    ]);
    expect(rowFor({ ...activity.transactions[0]!, direction: 'in' }).title).toBe('member.tx.p2p.in');
    const { model, routed } = setup(activity);
    await model.load();
    expect(model.store.get()).toMatchObject({ mode: 'ready', name: 'Dana E.', cards: [{ id: 'c1', last4: '4242' }] });
    model.openControls('c1');
    expect(routed).toEqual(['/funder/controls?card=c1']);
  });

  it('a member no longer funded, or the wallet off, reads as a sentence', async () => {
    const gone = setup(new Problem('NOT_FOUND', 404));
    await gone.model.load();
    expect([gone.model.store.get().mode, gone.model.store.get().error]).toEqual(['error', 'member.notFound']);
    const off = setup(new Problem('FEATURE_OFF', 404));
    await off.model.load();
    expect(off.model.store.get().error).toBe('family.off');
  });
});
