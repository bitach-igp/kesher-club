// Card view model for M20 card home, M21 controls, M22 physical order, M23 lost or stolen and M24
// activation (T-0408). One store over the member's cards; every action is idempotent by a fresh key,
// never retried blindly, and a STEP_UP_REQUIRED answer surfaces as `needsStepUp` for the passkey
// sheet. Nothing here ever holds card data: the details token opens the processor's component.
import { format } from '@kesher/domain';
import { errorIs, type Card, type CardControlsPatch, type CardsApi, type ProvisioningPayload, type ShipTo } from '../../src/api.ts';
import type { CopyKey, Locale } from '../../src/i18n.ts';
import { intlLocale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type CardMode = 'loading' | 'none' | 'ready' | 'error';
export type Wallet = 'apple' | 'google';
export type LostReason = 'lost' | 'stolen' | 'damaged';

export interface ControlRow {
  key: 'atm' | 'online' | 'dailyLimit' | 'monthlyLimit' | 'blockedMccs' | 'allowedCountries' | 'agentPurchases';
  label: CopyKey;
  value: string | boolean;
  locked: boolean;
}

export interface ShippingView {
  shipped: boolean;
  trackingUrl?: string | undefined;
  activated: boolean;
  pinSet: boolean;
}

export interface AddressForm {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: 'US' | 'IL';
}

export interface CardState {
  mode: CardMode;
  cards: Card[];
  selectedId?: string | undefined;
  busy: boolean;
  needsStepUp: boolean;
  notice?: CopyKey | undefined;
  error?: CopyKey | undefined;
  /** Field-level error on the physical order form: the field's copy key. */
  fieldError?: { field: keyof AddressForm; key: CopyKey } | undefined;
  address: AddressForm;
  last4: string;
  payload?: ProvisioningPayload | undefined;
}

export interface CardDeps {
  cards: CardsApi;
  router: Router;
  newKey: () => string;
  deviceId: () => string;
  kycHref?: string;
  physicalHref?: string;
  activateHref?: string;
}

export const EMPTY_ADDRESS: AddressForm = { name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: 'IL' };

// ---- pure views -------------------------------------------------------------------------------

/** The card the screens show: the live one first (active, then frozen, then on its way), physical before virtual. */
export function primaryCard(cards: readonly Card[]): Card | undefined {
  const rank = (c: Card) => ({ active: 0, frozen: 1, inactive: 2, closed: 3 })[c.status] * 2 + (c.type === 'physical' ? 0 : 1);
  return [...cards].sort((a, b) => rank(a) - rank(b))[0];
}

export function statusBanner(card: Card): { key: CopyKey; tone: 'danger' | 'info' | 'warning' } | undefined {
  if (card.status === 'frozen') return { key: 'card.banner.frozen', tone: 'danger' };
  if (card.status === 'inactive') return { key: 'card.banner.inactive', tone: 'info' };
  if (card.status === 'closed') return { key: 'card.banner.closed', tone: 'warning' };
  return undefined;
}

export function shippingView(card: Card): ShippingView | undefined {
  if (card.type !== 'physical') return undefined;
  return { shipped: Boolean(card.shipping?.trackingUrl), trackingUrl: card.shipping?.trackingUrl, activated: card.status !== 'inactive', pinSet: card.shipping?.pinSet ?? false };
}

const money = (m: { minor: string; currency: string } | undefined, locale: Locale): string | undefined => (m ? format({ minor: BigInt(m.minor), currency: m.currency as 'USD' | 'ILS' }, intlLocale(locale)) : undefined);

/** Every control as a row, with the funder's lock and a display value. */
export function controlRows(card: Card, locale: Locale): ControlRow[] {
  const c = card.controls;
  const locked = new Set(card.lockedByFunder);
  const agent = c.agentPurchases.mode === 'under_amount' ? `${c.agentPurchases.mode}:${money(c.agentPurchases.underAmount, locale) ?? ''}` : c.agentPurchases.mode;
  const rows: ControlRow[] = [
    { key: 'atm', label: 'card.controls.atm', value: c.atm, locked: locked.has('atm') },
    { key: 'online', label: 'card.controls.online', value: c.online, locked: locked.has('online') },
    { key: 'dailyLimit', label: 'card.controls.dailyLimit', value: money(c.dailyLimit, locale) ?? '', locked: locked.has('dailyLimit') },
    { key: 'monthlyLimit', label: 'card.controls.monthlyLimit', value: money(c.monthlyLimit, locale) ?? '', locked: locked.has('monthlyLimit') },
    { key: 'blockedMccs', label: 'card.controls.blockedMccs', value: c.blockedMccs.join(', '), locked: locked.has('blockedMccs') },
    { key: 'allowedCountries', label: 'card.controls.allowedCountries', value: (c.allowedCountries ?? []).join(', '), locked: locked.has('allowedCountries') },
    { key: 'agentPurchases', label: 'card.controls.agentPurchases', value: agent, locked: true }, // the funder's alone (REQ-CRD-008)
  ];
  return rows;
}

/** Keys the funder locked, with the one reason the member sees for each (REQ-CRD-005). */
export const lockedReasons = (card: Card): { key: string; reason: CopyKey }[] => card.lockedByFunder.map((key) => ({ key, reason: 'card.locked.hint' }));

/** The first missing field, in form order; a US address needs a state. */
export function addressProblem(a: AddressForm): { field: keyof AddressForm; key: CopyKey } | undefined {
  const required: (keyof AddressForm)[] = ['name', 'line1', 'city', ...(a.country === 'US' ? (['region'] as const) : []), 'postalCode'];
  for (const f of required) if (!a[f].trim()) return { field: f, key: 'card.physical.required' };
  return undefined;
}

export const toShipTo = (a: AddressForm): ShipTo => ({ name: a.name.trim(), line1: a.line1.trim(), ...(a.line2.trim() ? { line2: a.line2.trim() } : {}), city: a.city.trim(), ...(a.region.trim() ? { region: a.region.trim() } : {}), postalCode: a.postalCode.trim(), country: a.country });

// ---- model ------------------------------------------------------------------------------------

export interface CardModel {
  store: Store<CardState>;
  load(): Promise<void>;
  select(id: string): void;
  selected(): Card | undefined;
  goVerify(): void;
  freeze(): Promise<void>;
  unfreeze(): Promise<void>;
  /** M23: close the card as lost, stolen or damaged; a physical card then goes straight to the replacement order. */
  reportLost(reason: LostReason): Promise<void>;
  setToggle(key: 'atm' | 'online', value: boolean): Promise<void>;
  setLimit(key: 'dailyLimit' | 'monthlyLimit', amount: { minor: string; currency: 'USD' | 'ILS' } | null): Promise<void>;
  setAddress(patch: Partial<AddressForm>): void;
  orderPhysical(): Promise<void>;
  setLast4(v: string): void;
  activate(): Promise<void>;
  addToWallet(wallet: Wallet): Promise<void>;
  showDetails(): Promise<{ token: string; expiresAt: string } | undefined>;
  /** After the passkey sheet: clear the flag so the member can retry the action. */
  stepUpDone(): void;
}

export function createCardModel(deps: CardDeps): CardModel {
  const store = createStore<CardState>({ mode: 'loading', cards: [], busy: false, needsStepUp: false, address: EMPTY_ADDRESS, last4: '' });
  const replace = (card: Card) => store.set((s) => ({ ...s, cards: s.cards.some((c) => c.id === card.id) ? s.cards.map((c) => (c.id === card.id ? card : c)) : [card, ...s.cards], selectedId: card.id, mode: 'ready' }));
  const selected = () => {
    const s = store.get();
    return s.cards.find((c) => c.id === s.selectedId) ?? primaryCard(s.cards);
  };
  const fail = (e: unknown, fallback: CopyKey = 'common.error.generic') => {
    if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return store.patch({ busy: false, needsStepUp: true });
    store.patch({ busy: false, error: errorIs(e, { code: 'FEATURE_OFF' }) || errorIs(e, { status: 503 }) ? 'common.error.unavailable' : fallback });
  };
  const act = async (fn: () => Promise<Card>, notice?: CopyKey) => {
    store.patch({ busy: true, error: undefined, notice: undefined });
    try {
      replace(await fn());
      store.patch({ busy: false, ...(notice ? { notice } : {}) });
    } catch (e) {
      fail(e);
    }
  };
  const patchControls = (patch: CardControlsPatch) => {
    const card = selected();
    if (!card) return Promise.resolve();
    store.patch({ busy: true, error: undefined, notice: undefined });
    return deps.cards
      .updateControls(card.id, patch, deps.newKey())
      .then((c) => {
        replace(c);
        store.patch({ busy: false, notice: 'card.controls.saved' });
      })
      .catch((e: unknown) => (errorIs(e, { code: 'FORBIDDEN' }) ? store.patch({ busy: false, error: 'card.locked.refused' }) : fail(e)));
  };

  return {
    store,
    selected,
    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const { items } = await deps.cards.listCards();
        const open = items.filter((c) => c.status !== 'closed');
        store.patch({ mode: open.length ? 'ready' : 'none', cards: [...items], selectedId: primaryCard(open)?.id });
      } catch (e) {
        store.patch({ mode: 'error', error: errorIs(e, { status: 503 }) ? 'common.error.unavailable' : 'common.error.generic' });
      }
    },
    select(id) {
      store.patch({ selectedId: id, error: undefined, notice: undefined });
    },
    goVerify() {
      deps.router.push(deps.kycHref ?? '/kyc');
    },
    async freeze() {
      const card = selected();
      if (card) await act(() => deps.cards.setStatus(card.id, 'frozen', deps.newKey()));
    },
    async unfreeze() {
      const card = selected();
      if (card) await act(() => deps.cards.setStatus(card.id, 'active', deps.newKey()));
    },
    async reportLost(reason) {
      const card = selected();
      if (!card) return;
      await act(() => deps.cards.setStatus(card.id, 'closed', deps.newKey(), reason), 'card.lost.done');
      const after = store.get();
      if (after.error || after.needsStepUp) return;
      const stillOpen = after.cards.filter((c) => c.status !== 'closed');
      store.patch({ selectedId: primaryCard(stillOpen)?.id, mode: stillOpen.length ? 'ready' : 'none' });
      if (card.type === 'physical') deps.router.push(deps.physicalHref ?? '/card/physical');
    },
    setToggle(key, value) {
      return patchControls({ [key]: value });
    },
    setLimit(key, amount) {
      return patchControls({ [key]: amount } as CardControlsPatch);
    },
    setAddress(patch) {
      store.set((s) => ({ ...s, address: { ...s.address, ...patch }, fieldError: undefined, error: undefined }));
    },
    async orderPhysical() {
      const a = store.get().address;
      const problem = addressProblem(a);
      if (problem) return store.patch({ fieldError: problem });
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        replace(await deps.cards.orderPhysical(toShipTo(a), deps.newKey()));
        store.patch({ busy: false, notice: 'card.physical.ordered', address: EMPTY_ADDRESS });
      } catch (e) {
        if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' }) || errorIs(e, { status: 409 })) return store.patch({ busy: false, error: 'card.physical.exists' });
        if (errorIs(e, { code: 'FORBIDDEN' })) {
          store.patch({ busy: false });
          return deps.router.push(deps.kycHref ?? '/kyc');
        }
        fail(e);
      }
    },
    setLast4(v) {
      store.patch({ last4: v.replace(/\D/g, '').slice(0, 4), error: undefined });
    },
    async activate() {
      const card = selected();
      const last4 = store.get().last4;
      if (!card || last4.length !== 4) return store.patch({ error: 'card.activate.wrong' });
      store.patch({ busy: true, error: undefined, notice: undefined });
      try {
        replace(await deps.cards.activate(card.id, last4, deps.newKey()));
        store.patch({ busy: false, notice: 'card.activate.done', last4: '' });
      } catch (e) {
        if (errorIs(e, { code: 'VALIDATION_FAILED' })) return store.patch({ busy: false, error: 'card.activate.wrong' });
        fail(e);
      }
    },
    async addToWallet(wallet) {
      const card = selected();
      if (!card) return;
      store.patch({ busy: true, error: undefined, notice: undefined, payload: undefined });
      try {
        const payload = await deps.cards.startProvisioning(card.id, wallet, deps.deviceId(), {}, deps.newKey());
        store.patch({ busy: false, payload, notice: 'card.wallet.added' });
      } catch (e) {
        if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' })) return store.patch({ busy: false, notice: 'card.wallet.already' });
        fail(e);
      }
    },
    async showDetails() {
      const card = selected();
      if (!card) return undefined;
      store.patch({ error: undefined });
      try {
        return await deps.cards.detailsToken(card.id);
      } catch (e) {
        fail(e);
        return undefined;
      }
    },
    stepUpDone() {
      store.patch({ needsStepUp: false });
    },
  };
}
