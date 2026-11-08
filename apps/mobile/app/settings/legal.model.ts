// Settings, "Legal" (T-0062): the documents in force, read-only, with the version the member accepted and the day. A
// document with a newer material version waiting says so and offers the consent screen, coming back here. Reading
// needs no tap; accepting happens only on the consent screen.
import { errorIs, type LegalApi, type LegalDocKey } from '../../src/api.ts';
import { CONSENT_HREF, legalLink } from '../../src/consent.ts';
import type { CopyKey, Locale } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import { href, type Router } from '../../src/navigation.ts';

export interface LegalRow {
  docKey: LegalDocKey;
  title: string;
  /** Version in force. */
  version: number;
  /** The version the member accepted last, and when (ISO). */
  acceptedVersion?: number | undefined;
  acceptedAt?: string | undefined;
  /** A newer material version than the accepted one is waiting. */
  pending: boolean;
  /** The full text in the app's language, read-only. */
  body: string;
  url?: string | undefined;
}

export interface LegalState {
  status: 'loading' | 'ready' | 'error';
  rows: LegalRow[];
  /** The document whose text is open. */
  open?: LegalDocKey | undefined;
  error?: CopyKey | undefined;
}

export interface LegalDeps {
  legal: Pick<LegalApi, 'documents' | 'mine'>;
  router: Router;
  locale: Locale;
  webBaseUrl: string | undefined;
  openURL?: ((url: string) => Promise<void>) | undefined;
  /** Where the consent screen returns to. */
  selfHref?: string | undefined;
}

export interface LegalModel {
  store: Store<LegalState>;
  load(): Promise<void>;
  toggleText(docKey: LegalDocKey): void;
  openWeb(docKey: LegalDocKey): Promise<void>;
  review(): void;
}

export function createLegalModel(deps: LegalDeps): LegalModel {
  const store = createStore<LegalState>({ status: 'loading', rows: [] });
  return {
    store,

    async load() {
      store.patch({ status: 'loading', error: undefined });
      try {
        const [inForce, mine] = await Promise.all([deps.legal.documents(), deps.legal.mine()]);
        const pending = new Set(mine.pending.map((p) => p.docKey));
        const rows = inForce.items.map<LegalRow>((d) => {
          // The latest acceptance of this document (versions only go up).
          const last = mine.accepted.filter((a) => a.docKey === d.docKey).sort((a, b) => b.version - a.version)[0];
          const url = legalLink(deps.webBaseUrl, d.docKey, deps.locale);
          return { docKey: d.docKey, title: d.title[deps.locale], version: d.version, acceptedVersion: last?.version, acceptedAt: last?.acceptedAt, pending: pending.has(d.docKey), body: d.body[deps.locale], ...(url ? { url } : {}) };
        });
        store.patch({ status: 'ready', rows });
      } catch (e) {
        store.patch({ status: 'error', error: errorIs(e, { status: 503 }) ? 'common.error.unavailable' : 'common.error.generic' });
      }
    },

    toggleText(docKey) {
      store.patch({ open: store.get().open === docKey ? undefined : docKey });
    },

    async openWeb(docKey) {
      const url = store.get().rows.find((r) => r.docKey === docKey)?.url;
      if (url && deps.openURL) await deps.openURL(url);
    },

    review() {
      deps.router.push(href(CONSENT_HREF, { returnTo: deps.selfHref ?? '/settings/legal' }));
    },
  };
}
