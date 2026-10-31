// P05 family dashboard in funder mode (T-0535, REQ-WAL-007): a card per member the funder pays for, with their
// balance in dollars first (the spec's design principle for funders) and shekels one tap away, their last card spend
// and their membership's state; an invited member shows "Invite sent" with Send again. Past-due reads as a sentence
// and still shows the balance, because dunning never freezes money already loaded. From a member's card, Add money
// (P07) opens with that member chosen. An empty household offers to invite someone (P01–P04).
import { fromWire, type Currency, type Money } from '@kesher/domain';
import { errorIs, type FunderApi, type Household } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export interface MemberCard {
  partyId: string;
  name: string;
  status: 'active' | 'past_due' | 'paused' | 'cancelled';
  balances: Record<Currency, Money>;
  lastSpend?: { amount: Money; at: string } | undefined;
}

export interface InvitedCard {
  inviteId: string;
  name: string;
  planCode: string;
}

export interface FamilyState {
  mode: 'loading' | 'ready' | 'empty' | 'error';
  /** Dollars first for a funder; shekels one tap away. */
  shown: Currency;
  members: MemberCard[];
  invited: InvitedCard[];
  busy: boolean;
  error?: CopyKey | undefined;
  notice?: CopyKey | undefined;
}

export interface FamilyDeps {
  funder: Pick<FunderApi, 'household' | 'resend'>;
  router: Router;
}

const zero = (c: Currency): Money => ({ minor: 0n, currency: c });

/** A household member as a card: a purse the API did not send reads as zero, never as missing money. */
export function memberCard(m: Household['members'][number]): MemberCard {
  const balances: Record<Currency, Money> = { USD: zero('USD'), ILS: zero('ILS') };
  for (const b of m.balances ?? []) {
    const money = fromWire(b);
    balances[money.currency] = money;
  }
  return {
    partyId: m.partyId,
    name: m.displayName,
    status: m.membershipStatus === 'invited' ? 'active' : m.membershipStatus,
    balances,
    ...(m.lastSpend ? { lastSpend: { amount: fromWire(m.lastSpend.amount), at: m.lastSpend.at } } : {}),
  };
}

/** The membership's state as a sentence; active needs none. */
export const statusKey = (c: Pick<MemberCard, 'status'>): CopyKey | undefined => (c.status === 'active' ? undefined : (`family.status.${c.status}` as CopyKey));

export interface FamilyModel {
  store: Store<FamilyState>;
  load(): Promise<void>;
  /** Dollars and shekels, one tap apart. */
  toggleCurrency(): void;
  addMoney(partyId: string): void;
  /** P06 for one member (T-0538). */
  open(partyId: string): void;
  resend(inviteId: string): Promise<void>;
  inviteSomeone(): void;
}

export function createFamilyModel(deps: FamilyDeps): FamilyModel {
  const store = createStore<FamilyState>({ mode: 'loading', shown: 'USD', members: [], invited: [], busy: false });
  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const h = await deps.funder.household();
        const members = h.members.map(memberCard);
        const invited = (h.invites ?? []).map((i) => ({ inviteId: i.inviteId, name: i.memberName, planCode: i.planCode }));
        store.patch({ mode: members.length || invited.length ? 'ready' : 'empty', members, invited });
      } catch (e) {
        store.patch({ mode: 'error', error: errorIs(e, { code: 'FEATURE_OFF' }) ? 'family.off' : 'common.error.generic' });
      }
    },

    toggleCurrency() {
      store.patch({ shown: store.get().shown === 'USD' ? 'ILS' : 'USD' });
    },

    addMoney(partyId) {
      deps.router.push(`/fund/add-money?member=${encodeURIComponent(partyId)}`);
    },

    open(partyId) {
      deps.router.push(`/funder/member?id=${encodeURIComponent(partyId)}`);
    },

    async resend(inviteId) {
      if (store.get().busy) return;
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        await deps.funder.resend(inviteId);
        store.patch({ busy: false, notice: 'funder.invite.resent' });
      } catch {
        store.patch({ busy: false, error: 'common.error.generic' });
      }
    },

    inviteSomeone() {
      deps.router.push('/funder/plans');
    },
  };
}
