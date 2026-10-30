// eSIM view model for M26 plans, M27 install and M28 usage (T-0713, REQ-ESIM-001). Buying is an
// add-on order (T-0711) charged to the wallet or covered by the monthly credit (REQ-ESIM-002).
import { fromWire, zero, type Money } from '@kesher/domain';
import type { EsimUsage } from '@kesher/ports';
import { errorIs, type AddonOrder, type CatalogueItem, type ClubApi, type EsimUsageApi } from '../../src/api.ts';
import { supportsOneTapInstall, type Device } from '../../src/device.ts';
import type { CopyKey } from '../../src/i18n.ts';
import type { Opener } from '../../src/linking.ts';
import { createStore, type Store } from '../../src/model.ts';
import { href, type Router } from '../../src/navigation.ts';

export interface PlanRow {
  sku: string;
  title: string;
  price: Money;
  dataGb: number | undefined;
  days: number | undefined;
  covered: boolean;
}

export interface Checkout {
  plan: PlanRow;
  creditApplied: boolean;
  total: Money;
}

export interface OrderView {
  id: string;
  state: AddonOrder['state'];
  iccid?: string | undefined;
  installUrl?: string | undefined;
}

export interface InstallView {
  oneTap: boolean;
  installUrl: string;
  /** Activation code for the QR and the manual path. */
  lpa: string;
  steps: 'install.steps.ios' | 'install.steps.android';
}

export interface UsageView {
  iccid: string;
  remainingGb: number;
  totalGb: number;
  pctLeft: number;
  daysLeft: number;
  low: boolean;
  expiring: boolean;
  expired: boolean;
}

export type EsimStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface EsimState {
  status: EsimStatus;
  /**
   * This phone cannot hold an eSIM (T-0731). The plans still list, under a warning, because a member can buy one
   * for another device, as the warning says; installing on this phone is what it cannot do.
   */
  notCapable?: boolean;
  plans: PlanRow[];
  credit?: { remaining: number; unit: string };
  checkout?: Checkout | undefined;
  busy: boolean;
  order?: OrderView | undefined;
  install?: InstallView | undefined;
  usage?: UsageView | undefined;
  copied: boolean;
  error?: CopyKey | undefined;
}

export interface EsimDeps {
  club: ClubApi;
  esim: EsimUsageApi;
  device: Device;
  opener: Opener;
  router: Router;
  now: () => Date;
  newKey: () => string;
}

const GB = /(\d+(?:\.\d+)?)\s*GB/i;
const DAYS = /(\d+)\s*(?:days?|d)\b/i;

export function planRow(item: CatalogueItem): PlanRow {
  const gb = GB.exec(item.title)?.[1];
  const days = DAYS.exec(item.title)?.[1];
  return { sku: item.sku, title: item.title, price: fromWire(item.price), dataGb: gb ? Number(gb) : undefined, days: days ? Number(days) : undefined, covered: item.creditApplies === true };
}

/** iOS universal links carry the LPA string in `carddata`; Android links may carry it in `lpa` or be the LPA itself. */
export function lpaFromInstallUrl(url: string): string | undefined {
  if (url.startsWith('LPA:')) return url;
  try {
    const u = new URL(url);
    const v = u.searchParams.get('carddata') ?? u.searchParams.get('lpa');
    return v && v.startsWith('LPA:') ? v : undefined;
  } catch {
    return undefined;
  }
}

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function usageView(u: EsimUsage, now: Date): UsageView {
  const remainingMb = Math.max(0, u.totalMb - u.usedMb);
  const pctLeft = u.totalMb > 0 ? Math.round((remainingMb / u.totalMb) * 100) : 0;
  const msLeft = Date.parse(u.expiresAt) - now.getTime();
  const daysLeft = msLeft <= 0 ? 0 : Math.ceil(msLeft / DAY_MS);
  const expired = msLeft <= 0 || remainingMb === 0;
  return { iccid: u.iccid, remainingGb: round1(remainingMb / 1024), totalGb: round1(u.totalMb / 1024), pctLeft, daysLeft, low: !expired && pctLeft < 20, expiring: !expired && daysLeft <= 3, expired };
}

export interface EsimModel {
  store: Store<EsimState>;
  loadPlans(): Promise<void>;
  select(sku: string): void;
  clearSelection(): void;
  buy(): Promise<void>;
  installOneTap(): Promise<void>;
  copyActivationCode(): Promise<void>;
  installFailed(): void;
  installed(): void;
  loadUsage(iccid: string): Promise<void>;
  topUp(): void;
}

export function createEsimModel(deps: EsimDeps): EsimModel {
  const store = createStore<EsimState>({ status: 'idle', plans: [], busy: false, copied: false });
  let checkoutKey: string | undefined;

  const failure = (e: unknown): CopyKey =>
    errorIs(e, { code: 'PROVIDER_UNAVAILABLE' }) || errorIs(e, { code: 'FEATURE_OFF' }) || errorIs(e, { status: 503 }) ? 'common.error.unavailable' : errorIs(e, { code: 'NOT_FOUND' }) ? 'checkout.notFound' : 'common.error.generic';

  const installFor = (order: OrderView): InstallView | undefined => {
    if (!order.installUrl) return undefined;
    const lpa = lpaFromInstallUrl(order.installUrl) ?? order.installUrl;
    return { oneTap: supportsOneTapInstall(deps.device.info), installUrl: order.installUrl, lpa, steps: deps.device.info.platform === 'ios' ? 'install.steps.ios' : 'install.steps.android' };
  };

  return {
    store,

    async loadPlans() {
      store.patch({ status: 'loading', error: undefined, notCapable: !deps.device.info.esimCapable });
      try {
        const [page, caps] = await Promise.all([deps.club.listCatalogue(), deps.club.getCapabilities().catch(() => undefined)]);
        const plans = page.items.filter((i) => i.kind === 'esim').map(planRow);
        const ent = caps?.entitlements['esim.data'];
        const credit = ent ? { remaining: Number(ent.remaining), unit: ent.unit ?? 'GB' } : undefined;
        store.patch({ status: plans.length ? 'ready' : 'empty', plans, ...(credit ? { credit } : {}) });
      } catch (e) {
        store.patch({ status: 'error', error: failure(e) });
      }
    },

    select(sku) {
      const plan = store.get().plans.find((p) => p.sku === sku);
      if (!plan) return store.patch({ error: 'checkout.notFound' });
      checkoutKey = deps.newKey();
      const creditApplied = plan.covered && (store.get().credit?.remaining ?? 0) > 0;
      store.patch({ checkout: { plan, creditApplied, total: creditApplied ? zero(plan.price.currency) : plan.price }, error: undefined, order: undefined, install: undefined });
    },

    clearSelection() {
      checkoutKey = undefined;
      store.patch({ checkout: undefined, error: undefined });
    },

    async buy() {
      const s = store.get();
      if (!s.checkout || !checkoutKey || s.busy) return;
      store.patch({ busy: true, error: undefined });
      try {
        const o = await deps.club.createAddonOrder({ sku: s.checkout.plan.sku }, checkoutKey);
        const order: OrderView = { id: o.id, state: o.state, ...(o.fulfilment?.iccid ? { iccid: o.fulfilment.iccid } : {}), ...(o.fulfilment?.installUrl ? { installUrl: o.fulfilment.installUrl } : {}) };
        const install = installFor(order);
        store.patch({ busy: false, order, ...(install ? { install } : { install: undefined }), copied: false });
        if (o.state === 'failed') return store.patch({ error: 'common.error.generic' });
        deps.router.push('/club/esim/install');
      } catch (e) {
        store.patch({ busy: false, error: failure(e) });
      }
    },

    async installOneTap() {
      const i = store.get().install;
      if (!i) return;
      await deps.opener.openURL(i.installUrl);
    },

    async copyActivationCode() {
      const i = store.get().install;
      if (!i) return;
      await deps.device.clipboard.copy(i.lpa);
      store.patch({ copied: true });
    },

    installFailed() {
      deps.router.push('/help');
    },

    installed() {
      const iccid = store.get().order?.iccid;
      deps.router.replace(iccid ? href('/club/esim/usage', { iccid }) : '/club');
    },

    async loadUsage(iccid) {
      store.patch({ status: 'loading', error: undefined });
      try {
        const u = await deps.esim.getUsage(iccid);
        store.patch({ status: 'ready', usage: usageView(u, deps.now()) });
      } catch (e) {
        store.patch({ status: 'error', error: failure(e) });
      }
    },

    topUp() {
      const iccid = store.get().usage?.iccid;
      deps.router.push(href('/club/esim', iccid ? { iccid } : {}));
    },
  };
}
