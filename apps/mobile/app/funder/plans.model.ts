// P01–P03 in funder mode (T-0308, REQ-BIL-001, REQ-BIL-002): a signed-in adult pays for someone's membership. They
// choose a market and see its plans side by side (price for the term, the term, the price a month, what each
// includes), save a card on the billing vendor's sheet, then invite the member (P04). Paying needs the funder's
// identity verified at T1: before that the screen sends them to verification first. The card stays with the vendor;
// the app only learns whether the sheet completed.
import { format, fromWire, type Money } from '@kesher/domain';
import { errorIs, type FunderApi, type KycApi, type OfferedPlan } from '../../src/api.ts';
import { intlLocale, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type Market = 'IL' | 'US';

/** The vendor's card sheet: completes once the card is saved, or is cancelled. */
export interface CardSheet {
  present(clientSecret: string): Promise<'completed' | 'cancelled'>;
}

export interface PlanCard {
  planCode: string;
  name: string;
  price: Money;
  termMonths: number;
  monthly: Money;
  /** What the plan includes, as copy keys with their numbers. */
  includes: { key: CopyKey; vars: Record<string, string> }[];
}

export interface PlansState {
  mode: 'loading' | 'ready' | 'error';
  market: Market;
  plans: PlanCard[];
  chosen?: string | undefined;
  /** True once the funder's identity is approved at T1 or above. */
  verified: boolean;
  cardSaved: boolean;
  busy: boolean;
  error?: CopyKey | undefined;
  notice?: CopyKey | undefined;
}

export interface PlansDeps {
  funder: Pick<FunderApi, 'plans' | 'setupSheet'>;
  kyc: Pick<KycApi, 'status'>;
  sheet: CardSheet;
  router: Router;
}

const INCLUDES: Record<string, CopyKey> = { 'esim.dataGb': 'funder.includes.esim', 'concierge.calls': 'funder.includes.concierge' };

/** An offered plan as a card on the screen: amounts in bigint, entitlements the app knows put in words. */
export function planCard(p: OfferedPlan): PlanCard {
  const includes = Object.entries(p.entitlements)
    .filter(([key]) => key in INCLUDES)
    .map(([key, e]) => ({ key: INCLUDES[key]!, vars: { count: e.limit } }));
  return { planCode: p.planCode, name: p.name, price: fromWire(p.price), termMonths: p.termMonths, monthly: fromWire(p.monthlyPrice), includes };
}

export const fmt = (m: Money, locale: Locale): string => format(m, intlLocale(locale));

export interface PlansModel {
  store: Store<PlansState>;
  load(): Promise<void>;
  setMarket(m: Market): Promise<void>;
  choose(planCode: string): void;
  /** Opens the vendor's sheet; the card is saved on the funder's customer, never in the app. */
  saveCard(): Promise<void>;
  /** On to P04 with the chosen plan; to identity verification first while T1 is not approved. */
  next(): void;
}

export function createPlansModel(deps: PlansDeps, market: Market = 'US'): PlansModel {
  const store = createStore<PlansState>({ mode: 'loading', market, plans: [], verified: false, cardSaved: false, busy: false });
  const fetchPlans = async (m: Market) => {
    const { items } = await deps.funder.plans(m);
    const plans = items.map(planCard);
    const chosen = store.get().chosen;
    store.patch({ plans, chosen: plans.some((p) => p.planCode === chosen) ? chosen : plans[0]?.planCode });
  };
  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const [kyc] = await Promise.all([deps.kyc.status(), fetchPlans(store.get().market)]);
        store.patch({ mode: 'ready', verified: kyc.approvedTier === 'T1' || kyc.approvedTier === 'T2' });
      } catch (e) {
        store.patch({ mode: 'error', error: errorIs(e, { code: 'FEATURE_OFF' }) ? 'funder.off' : 'common.error.generic' });
      }
    },

    async setMarket(m) {
      if (m === store.get().market) return;
      store.patch({ market: m, busy: true, error: undefined });
      try {
        await fetchPlans(m);
        store.patch({ busy: false });
      } catch {
        store.patch({ busy: false, error: 'common.error.generic' });
      }
    },

    choose(planCode) {
      if (store.get().plans.some((p) => p.planCode === planCode)) store.patch({ chosen: planCode, notice: undefined });
    },

    async saveCard() {
      if (store.get().busy) return;
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        const { clientSecret } = await deps.funder.setupSheet();
        const outcome = await deps.sheet.present(clientSecret);
        store.patch(outcome === 'completed' ? { busy: false, cardSaved: true } : { busy: false, notice: 'funder.card.cancelled' });
      } catch (e) {
        store.patch({ busy: false, error: errorIs(e, { code: 'FEATURE_OFF' }) ? 'funder.off' : 'common.error.generic' });
      }
    },

    next() {
      const s = store.get();
      if (!s.verified) return deps.router.push('/kyc');
      if (!s.chosen) return store.patch({ notice: 'funder.plan.none' });
      if (!s.cardSaved) return store.patch({ notice: 'funder.card.needed' });
      deps.router.push(`/funder/invite?plan=${encodeURIComponent(s.chosen)}`);
    },
  };
}
