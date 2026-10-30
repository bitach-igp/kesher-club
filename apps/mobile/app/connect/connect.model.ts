// "Connect an assistant" (T-1017, REQ-AGT-010, ADR-009): an assistant asked for access and the browser landed
// here. The screen shows who is asking (their name and home page, their own words: shown as text) and each
// scope in plain words, grouped by what it lets them do: read, act, propose payments. Every scope starts ticked
// except the propose tier, which the member opts into. "Connect" runs the passkey step-up (the API client
// asks for it) and opens the redirect the API answers; "Not now" denies. An expired or decided request
// offers neither.
import { errorIs, type AgentApi, type AgentConsent } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';

export type Tier = AgentConsent['scopes'][number]['tier'];
export const TIER_LABEL: Record<Tier, CopyKey> = { T0: 'connect.tier.read', T1: 'connect.tier.act', T2: 'connect.tier.propose' };
/** Each scope of REQ-AGT-005 in words; a scope with no words yet is shown as its name. */
export const SCOPE_WORDS: Readonly<Record<string, CopyKey>> = {
  'balances:read': 'connect.scope.balancesRead',
  'transactions:read': 'connect.scope.transactionsRead',
  'card:status:read': 'connect.scope.cardStatusRead',
  'esim:read': 'connect.scope.esimRead',
  'card:freeze': 'connect.scope.cardFreeze',
  'limits:propose': 'connect.scope.limitsPropose',
  'p2p:propose': 'connect.scope.p2pPropose',
  'load:propose': 'connect.scope.loadPropose',
};

export interface ConnectState {
  mode: 'loading' | 'ready' | 'gone' | 'error';
  request?: AgentConsent | undefined;
  /** The scopes the member keeps. */
  kept: string[];
  busy: boolean;
  needsStepUp: boolean;
  error?: CopyKey | undefined;
  /** Where the browser goes once decided: the assistant's own redirect URI. */
  redirect?: string | undefined;
}

export interface ConnectModel {
  store: Store<ConnectState>;
  load(): Promise<void>;
  toggle(scope: string): void;
  connect(): Promise<void>;
  decline(): Promise<void>;
}

/** The scopes grouped by tier, read first, in the order the assistant asked for them. */
export function groups(r: AgentConsent): { tier: Tier; label: CopyKey; scopes: string[] }[] {
  return (['T0', 'T1', 'T2'] as const).map((tier) => ({ tier, label: TIER_LABEL[tier], scopes: r.scopes.filter((s) => s.tier === tier).map((s) => s.scope) })).filter((g) => g.scopes.length);
}

export function createConnectModel(deps: { agent: AgentApi; id: string; open: (url: string) => void }): ConnectModel {
  const store = createStore<ConnectState>({ mode: 'loading', kept: [], busy: false, needsStepUp: false });
  const settle = (redirect: string) => {
    store.patch({ busy: false, redirect });
    deps.open(redirect);
  };
  const fail = (e: unknown) => {
    if (errorIs(e, { code: 'STEP_UP_REQUIRED' })) return store.patch({ busy: false, needsStepUp: true });
    if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' }) || errorIs(e, { code: 'NOT_FOUND' })) return store.patch({ busy: false, mode: 'gone' });
    store.patch({ busy: false, error: 'common.error.generic' });
  };
  return {
    store,
    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        const request = await deps.agent.consent(deps.id);
        // Propose-payment scopes start unticked: the member opts into them.
        store.patch({ mode: 'ready', request, kept: request.scopes.filter((s) => s.tier !== 'T2').map((s) => s.scope) });
      } catch (e) {
        if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' }) || errorIs(e, { code: 'NOT_FOUND' })) return store.patch({ mode: 'gone' });
        store.patch({ mode: 'error', error: 'common.error.generic' });
      }
    },
    toggle(scope) {
      const s = store.get();
      if (!s.request?.scopes.some((x) => x.scope === scope)) return;
      store.patch({ kept: s.kept.includes(scope) ? s.kept.filter((k) => k !== scope) : [...s.kept, scope], error: undefined });
    },
    async connect() {
      const s = store.get();
      if (s.busy || s.mode !== 'ready') return;
      if (!s.kept.length) return store.patch({ error: 'connect.keepOne' });
      store.patch({ busy: true, error: undefined, needsStepUp: false });
      try {
        settle((await deps.agent.approveConsent(deps.id, s.kept)).redirect);
      } catch (e) {
        fail(e);
      }
    },
    async decline() {
      if (store.get().busy) return;
      store.patch({ busy: true, error: undefined });
      try {
        settle((await deps.agent.denyConsent(deps.id)).redirect);
      } catch (e) {
        fail(e);
      }
    },
  };
}
