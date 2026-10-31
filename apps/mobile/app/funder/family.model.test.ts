// T-0535 P05 family dashboard (TST-WAL-007 at the screen): a card per funded member in bigint, dollars first for the
// funder with shekels one tap away, a purse the API left out reading as zero; past-due reads as a sentence and still
// shows the balance; invited members show with Send again; Add money opens P07 with that member; an empty household
// offers an invite; the wallet off reads as a sentence.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import type { FunderApi, Household } from '../../src/api.ts';
import { createFamilyModel, memberCard, statusKey } from './family.model.ts';

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const BEN = '0190a0a0-0000-7000-8000-0000000000b0';
const DANA = '0190a0a0-0000-7000-8000-0000000000d0';
const household = (over: Partial<Household> = {}): Household => ({
  id: BEN,
  funderId: BEN,
  members: [{ partyId: DANA, displayName: 'Dana E.', membershipStatus: 'active', membershipId: 'm1', planCode: 'demo-club-us', balances: [{ minor: '50000', currency: 'USD' }, { minor: '9007199254740993', currency: 'ILS' }], lastSpend: { amount: { minor: '1200', currency: 'USD' }, at: '2026-11-10T09:00:00Z', mcc: '5814', country: 'IL' } }],
  invites: [{ inviteId: 'i1', memberName: 'Avi Example', membershipStatus: 'invited', planCode: 'demo-club-us', expiresAt: '2026-11-17T09:00:00Z' }],
  ...over,
});

function setup(answer: Household | Error) {
  const routed: string[] = [];
  const resent: string[] = [];
  const funder: Pick<FunderApi, 'household' | 'resend'> = {
    async household() {
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async resend(id) {
      resent.push(id);
      return {} as Awaited<ReturnType<FunderApi['resend']>>;
    },
  };
  const model = createFamilyModel({ funder, router: { push: (h) => void routed.push(h), replace: () => undefined, back: () => undefined } });
  return { model, routed, resent };
}

describe('T-0535 P05 family dashboard', () => {
  it('a card per member in bigint, dollars first and shekels one tap away; a purse left out reads as zero', async () => {
    const { model } = setup(household());
    await model.load();
    const s = model.store.get();
    expect(s.mode).toBe('ready');
    expect(s.shown).toBe('USD');
    expect(s.members[0]).toEqual({ partyId: DANA, name: 'Dana E.', status: 'active', balances: { USD: money(50_000n, 'USD'), ILS: money(9_007_199_254_740_993n, 'ILS') }, lastSpend: { amount: money(1_200n, 'USD'), at: '2026-11-10T09:00:00Z' } });
    model.toggleCurrency();
    expect(model.store.get().shown).toBe('ILS');
    expect(memberCard({ partyId: DANA, displayName: 'Dana E.', membershipStatus: 'active', balances: [{ minor: '100', currency: 'USD' }] }).balances.ILS).toEqual(money(0n, 'ILS'));
  });

  it('past-due reads as a sentence and keeps the balance; active needs none', () => {
    const card = memberCard({ partyId: DANA, displayName: 'Dana E.', membershipStatus: 'past_due', balances: [{ minor: '50000', currency: 'USD' }] });
    expect([statusKey(card), card.balances.USD]).toEqual(['family.status.past_due', money(50_000n, 'USD')]);
    expect(statusKey({ status: 'active' })).toBeUndefined();
  });

  it('invited members show with Send again; Add money opens P07 with the member; empty offers an invite', async () => {
    const { model, routed, resent } = setup(household());
    await model.load();
    expect(model.store.get().invited).toEqual([{ inviteId: 'i1', name: 'Avi Example', planCode: 'demo-club-us' }]);
    await model.resend('i1');
    expect([resent, model.store.get().notice]).toEqual([['i1'], 'funder.invite.resent']);
    model.addMoney(DANA);
    expect(routed).toEqual([`/fund/add-money?member=${DANA}`]);

    const empty = setup(household({ members: [], invites: [] }));
    await empty.model.load();
    expect(empty.model.store.get().mode).toBe('empty');
    empty.model.inviteSomeone();
    expect(empty.routed).toEqual(['/funder/plans']);
  });

  it('with the wallet off, the household reads as a sentence', async () => {
    const { model } = setup(new Problem('FEATURE_OFF', 404));
    await model.load();
    expect([model.store.get().mode, model.store.get().error]).toEqual(['error', 'family.off']);
  });
});
