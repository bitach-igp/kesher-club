// M33-ish Assistants settings (T-1006): every agent grant with client name, scopes and last use;
// one-tap revoke, effective within 60 s (REQ-AGT-008). 429s from the gateway explain the 60/min
// per-grant limit (REQ-AGT-009) instead of retrying.
import { errorIs, type AgentGrant, type GrantsApi } from '../../../src/api.ts';
import type { CopyKey } from '../../../src/i18n.ts';
import { createStore, type Store } from '../../../src/model.ts';

export interface GrantRow {
  id: string;
  clientName: string;
  clientId: string;
  scopes: readonly string[];
  createdAt: string;
  lastUsedAt?: string | undefined;
  revoking: boolean;
}

export interface GrantsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  grants: GrantRow[];
  notice?: CopyKey | undefined;
  error?: CopyKey | undefined;
}

const SCOPE_COPY = new Set<string>(['balances:read', 'transactions:read', 'card:status:read', 'esim:read', 'card:freeze', 'limits:propose', 'p2p:propose', 'load:propose']);

/** Copy key for a scope; unknown scopes render through `grants.scope.unknown` with the raw scope as data. */
export const scopeCopy = (scope: string): { key: CopyKey; vars: Record<string, string> } =>
  SCOPE_COPY.has(scope) ? { key: `grants.scope.${scope}` as CopyKey, vars: {} } : { key: 'grants.scope.unknown', vars: { scope } };

export function relativeTime(iso: string | undefined, now: Date): { key: CopyKey; vars: Record<string, string | number> } {
  if (!iso) return { key: 'grants.neverUsed', vars: {} };
  const ms = now.getTime() - Date.parse(iso);
  if (ms < 60_000) return { key: 'time.justNow', vars: {} };
  if (ms < 3_600_000) return { key: 'time.minutesAgo', vars: { n: Math.floor(ms / 60_000) } };
  if (ms < 86_400_000) return { key: 'time.hoursAgo', vars: { n: Math.floor(ms / 3_600_000) } };
  return { key: 'time.daysAgo', vars: { n: Math.floor(ms / 86_400_000) } };
}

const row = (g: AgentGrant): GrantRow => ({ id: g.id, clientName: g.clientName, clientId: g.clientId, scopes: g.scopes, createdAt: g.createdAt, ...(g.lastUsedAt ? { lastUsedAt: g.lastUsedAt } : {}), revoking: false });

export interface GrantsModel {
  store: Store<GrantsState>;
  load(): Promise<void>;
  revoke(id: string): Promise<void>;
}

export function createGrantsModel(deps: { grants: GrantsApi }): GrantsModel {
  const store = createStore<GrantsState>({ status: 'idle', grants: [] });
  const limited = (e: unknown) => errorIs(e, { code: 'RATE_LIMITED' }) || errorIs(e, { status: 429 });
  return {
    store,
    async load() {
      store.patch({ status: 'loading', error: undefined });
      try {
        const page = await deps.grants.listAgentGrants();
        store.patch({ status: 'ready', grants: page.items.map(row) });
      } catch (e) {
        store.patch({ status: 'error', error: limited(e) ? 'grants.rateLimited' : 'common.error.generic' });
      }
    },
    async revoke(id) {
      const g = store.get().grants.find((x) => x.id === id);
      if (!g || g.revoking) return;
      store.set((s) => ({ ...s, notice: undefined, error: undefined, grants: s.grants.map((x) => (x.id === id ? { ...x, revoking: true } : x)) }));
      try {
        await deps.grants.revokeAgentGrant(id);
        store.set((s) => ({ ...s, notice: 'grants.revoked', grants: s.grants.filter((x) => x.id !== id) }));
      } catch (e) {
        store.set((s) => ({ ...s, error: limited(e) ? 'grants.rateLimited' : 'grants.revokeFailed', grants: s.grants.map((x) => (x.id === id ? { ...x, revoking: false } : x)) }));
      }
    },
  };
}
