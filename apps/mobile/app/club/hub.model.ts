// M25 club hub (T-0713): entitlements left this period and the add-ons grid. Feature-off add-ons
// show the "Coming soon" card from Tab 2 instead of disappearing.
import { errorIs, type Capabilities, type ClubApi } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type AddonKind = 'esim' | 'insurance' | 'concierge';

export interface EntitlementRow {
  key: string;
  remaining: number;
  unit: string;
  resetsAt?: string | undefined;
}

export interface AddonTile {
  kind: AddonKind;
  on: boolean;
  href: string;
}

export interface HubState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  entitlements: EntitlementRow[];
  addons: AddonTile[];
  error?: CopyKey | undefined;
}

/** Flag key per add-on kind (config/flags.json); the API reports them under `features`. */
export const ADDON_FLAGS: Readonly<Record<AddonKind, string>> = { esim: 'esim.airalo', insurance: 'insurance.coverGenius', concierge: 'concierge.partner' };
export const ADDON_ROUTES: Readonly<Record<AddonKind, string>> = { esim: '/club/esim', insurance: '/club/insurance', concierge: '/help' };

export function hubView(caps: Capabilities): Pick<HubState, 'entitlements' | 'addons'> {
  const entitlements = Object.entries(caps.entitlements).map(([key, e]) => ({ key, remaining: Number(e.remaining), unit: e.unit ?? '', ...(e.resetsAt ? { resetsAt: e.resetsAt } : {}) }));
  const addons = (Object.keys(ADDON_FLAGS) as AddonKind[]).map((kind) => ({ kind, on: caps.features[ADDON_FLAGS[kind]] === true, href: ADDON_ROUTES[kind] }));
  return { entitlements, addons };
}

export interface HubModel {
  store: Store<HubState>;
  load(): Promise<void>;
  open(kind: AddonKind): void;
}

export function createHubModel(deps: { club: ClubApi; router: Router }): HubModel {
  const store = createStore<HubState>({ status: 'idle', entitlements: [], addons: [] });
  return {
    store,
    async load() {
      store.patch({ status: 'loading', error: undefined });
      try {
        store.patch({ status: 'ready', ...hubView(await deps.club.getCapabilities()) });
      } catch (e) {
        store.patch({ status: 'error', error: errorIs(e, { status: 503 }) ? 'common.error.unavailable' : 'common.error.generic' });
      }
    },
    open(kind) {
      const tile = store.get().addons.find((a) => a.kind === kind);
      if (tile?.on) deps.router.push(tile.href);
    },
  };
}
