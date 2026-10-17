// M06 identity verification (T-0408, enabling REQ-CRD-001). Starts a T2 session with the card
// partner, polls where it stands, explains a rejection with the partner's reason codes (never a
// document or an image), lets the member try again, and moves on to the card once approved.
import { errorIs, type KycApi, type KycStatus } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type KycMode = 'loading' | 'none' | 'pending' | 'review' | 'approved' | 'rejected' | 'error';

export interface KycState {
  mode: KycMode;
  reasons: { key: CopyKey; vars: Record<string, string> }[];
  busy: boolean;
  /** For the partner's capture SDK; held in memory only, never persisted or logged. */
  clientToken?: string | undefined;
  sessionId?: string | undefined;
  error?: CopyKey | undefined;
}

export interface KycDeps {
  kyc: KycApi;
  router: Router;
  newKey: () => string;
  cardHref?: string;
}

const KNOWN_REASONS = new Set(['DOCUMENT_MISMATCH', 'MANUAL_REVIEW']);
export const reasonCopy = (code: string): { key: CopyKey; vars: Record<string, string> } => (KNOWN_REASONS.has(code) ? { key: `kyc.reason.${code}` as CopyKey, vars: {} } : { key: 'kyc.reason.unknown', vars: { code } });

export function kycMode(status: KycStatus): KycMode {
  if (status.approvedTier === 'T2') return 'approved';
  if (status.status === 'none') return 'none';
  if (status.status === 'approved') return 'none'; // T1 only: T2 is still to do
  return status.status;
}

export interface KycModel {
  store: Store<KycState>;
  load(): Promise<void>;
  start(): Promise<void>;
  /** After a rejection: a fresh session. */
  retry(): Promise<void>;
  refresh(): Promise<void>;
  continueToCard(): void;
}

export function createKycModel(deps: KycDeps): KycModel {
  const store = createStore<KycState>({ mode: 'loading', reasons: [], busy: false });
  const apply = (status: KycStatus) => {
    const mode = kycMode(status);
    store.patch({ mode, reasons: (status.current?.reasons ?? []).map(reasonCopy), sessionId: status.current?.sessionId, error: undefined });
    if (mode === 'approved') deps.router.replace(deps.cardHref ?? '/card');
  };
  const start = async () => {
    store.patch({ busy: true, error: undefined });
    try {
      const s = await deps.kyc.start('T2', deps.newKey());
      store.patch({ mode: 'pending', busy: false, clientToken: s.clientToken, sessionId: s.sessionId, reasons: [] });
    } catch (e) {
      store.patch({ busy: false, mode: store.get().mode === 'loading' ? 'none' : store.get().mode, error: errorIs(e, { code: 'PROVIDER_UNAVAILABLE' }) || errorIs(e, { status: 503 }) ? 'kyc.unavailable' : 'common.error.generic' });
    }
  };
  return {
    store,
    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        apply(await deps.kyc.status());
      } catch {
        store.patch({ mode: 'error', error: 'common.error.generic' });
      }
    },
    start,
    retry: start,
    async refresh() {
      try {
        apply(await deps.kyc.status());
      } catch {
        store.patch({ error: 'common.error.generic' });
      }
    },
    continueToCard() {
      deps.router.replace(deps.cardHref ?? '/card');
    },
  };
}
