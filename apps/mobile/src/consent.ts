// The terms at sign-up and at re-accept (T-0062). A plain model over `createStore`; the screen takes it.
//
// What the member sees is the documents in force (public GET /legal/documents) that are pending for them
// (GET /me/consents: never accepted, or a material change since). Each one shows a short summary and a link to
// its web page, and needs its own tap: nothing starts ticked and there is no "accept all". One POST then records
// exactly the versions shown, in the language the app is in. A failure records nothing and offers the same
// button again. A returning member is found by the same `pending` list right after sign-in (`routeIfPending`);
// the server-side `consent_required` gate that would refuse their calls is T-0066 and is not built, so the app
// does not wait for one.
import { errorIs, type LegalApi, type LegalDocKey, type LegalDocument, type PendingLegalDocument } from './api.ts';
import type { CopyKey, Locale } from './i18n.ts';
import { createStore, type Store } from './model.ts';
import { href, type Router } from './navigation.ts';

export const CONSENT_HREF = '/(auth)/consent';
export const LEGAL_SETTINGS_HREF = '/settings/legal';
/** The summary is the first characters of the text when the version carries no change summary. */
export const SUMMARY_MAX = 280;

/**
 * The web page of a document. The base comes from `EXPO_PUBLIC_LEGAL_BASE_URL`, a PLACEHOLDER key: no web site is
 * chosen yet, so no domain is written here. Without a base (or with one that is not https) there is no link, and a
 * non-development build refuses to take consent (`linkRequired`), so a missing key fails closed instead of asking for
 * agreement to text the member cannot open. The path is a placeholder too, for the web card to confirm.
 */
export function legalLink(base: string | undefined, docKey: LegalDocKey, locale: Locale): string | undefined {
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  return `${url.href.replace(/\/$/, '')}/legal/${docKey}?lang=${locale}`;
}

/** A returnTo is a route inside the app; anything else (another scheme, a host, `//x`) is dropped. */
export function safeReturnTo(raw: string | undefined): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/';
}

/** The short text under a document's title. */
export function summaryOf(doc: Pick<LegalDocument, 'body' | 'changeSummary'>, locale: Locale, reason?: PendingLegalDocument['reason']): string {
  const change = reason === 'material_change' ? doc.changeSummary?.[locale]?.trim() : undefined;
  if (change) return change;
  const body = doc.body[locale].replace(/\s+/g, ' ').trim();
  return body.length <= SUMMARY_MAX ? body : `${body.slice(0, SUMMARY_MAX).trimEnd()}…`;
}

/**
 * The two build-time values the consent and Legal screens need, spelled out in full so Expo inlines them.
 * `EXPO_PUBLIC_LEGAL_BASE_URL` is a placeholder key with no value anywhere yet (no web domain is decided);
 * only a development or test build may run without it.
 */
export const legalBuild = (): { webBaseUrl: string | undefined; linkRequired: boolean } => ({
  webBaseUrl: process.env.EXPO_PUBLIC_LEGAL_BASE_URL,
  linkRequired: process.env.EXPO_PUBLIC_APP_ENV !== 'development' && process.env.EXPO_PUBLIC_APP_ENV !== 'test',
});

export interface ConsentItem {
  docKey: LegalDocKey;
  version: number;
  title: string;
  summary: string;
  /** The web page; undefined where no base URL is configured. */
  url?: string | undefined;
  reason: PendingLegalDocument['reason'];
  /** True only after the member's own tap. */
  accepted: boolean;
}

export type ConsentMode = 'loading' | 'ready' | 'error' | 'done';

export interface ConsentState {
  mode: ConsentMode;
  items: ConsentItem[];
  busy: boolean;
  error?: CopyKey | undefined;
}

export interface ConsentDeps {
  legal: LegalApi;
  router: Router;
  locale: Locale;
  /** From `EXPO_PUBLIC_LEGAL_BASE_URL`. */
  webBaseUrl: string | undefined;
  /** True outside development builds: no web link, no consent screen. */
  linkRequired: boolean;
  /** Where to go when done (validated by `safeReturnTo`). */
  returnTo?: string | undefined;
  openURL?: ((url: string) => Promise<void>) | undefined;
}

export interface ConsentModel {
  store: Store<ConsentState>;
  load(): Promise<void>;
  /** The member's tap on one document. */
  toggle(docKey: LegalDocKey): void;
  canContinue(): boolean;
  submit(): Promise<void>;
  open(docKey: LegalDocKey): Promise<void>;
}

const failure = (e: unknown): CopyKey => {
  if (errorIs(e, { status: 422 }) || errorIs(e, { status: 409 }) || errorIs(e, { code: 'VALIDATION_FAILED' })) return 'consent.error.changed';
  if (errorIs(e, { status: 503 }) || errorIs(e, { code: 'PROVIDER_UNAVAILABLE' })) return 'common.error.unavailable';
  // No status at all: the request never got an answer.
  if (typeof e === 'object' && e !== null && (e as { status?: unknown }).status === undefined) return 'consent.error.offline';
  return 'common.error.generic';
};

export function createConsentModel(deps: ConsentDeps): ConsentModel {
  const store = createStore<ConsentState>({ mode: 'loading', items: [], busy: false });
  const returnTo = safeReturnTo(deps.returnTo);

  const load = async () => {
    store.patch({ mode: 'loading', error: undefined });
    if (deps.linkRequired && !legalLink(deps.webBaseUrl, 'terms', deps.locale)) return store.patch({ mode: 'error', items: [], error: 'consent.error.unavailable' });
    try {
      const [inForce, mine] = await Promise.all([deps.legal.documents(), deps.legal.mine()]);
      const reasons = new Map(mine.pending.map((p) => [p.docKey, p.reason] as const));
      // The text comes from what is in force now; `pending` only says which of them this member still owes.
      const items = inForce.items
        .filter((d) => reasons.has(d.docKey))
        .map<ConsentItem>((d) => {
          const reason = reasons.get(d.docKey) ?? 'first';
          const url = legalLink(deps.webBaseUrl, d.docKey, deps.locale);
          return { docKey: d.docKey, version: d.version, title: d.title[deps.locale], summary: summaryOf(d, deps.locale, reason), ...(url ? { url } : {}), reason, accepted: false };
        });
      if (items.length === 0) {
        store.patch({ mode: 'done', items: [] });
        return deps.router.replace(returnTo);
      }
      store.patch({ mode: 'ready', items });
    } catch (e) {
      store.patch({ mode: 'error', items: [], error: failure(e) });
    }
  };

  return {
    store,
    load,

    toggle(docKey) {
      const s = store.get();
      if (s.mode !== 'ready' || s.busy) return;
      store.patch({ items: s.items.map((i) => (i.docKey === docKey ? { ...i, accepted: !i.accepted } : i)), error: undefined });
    },

    canContinue() {
      const s = store.get();
      return s.mode === 'ready' && !s.busy && s.items.length > 0 && s.items.every((i) => i.accepted);
    },

    async submit() {
      if (!this.canContinue()) return;
      const shown = store.get().items;
      store.patch({ busy: true, error: undefined });
      try {
        await deps.legal.record({ documents: shown.map((i) => ({ docKey: i.docKey, version: i.version })), locale: deps.locale });
        store.patch({ busy: false, mode: 'done' });
        deps.router.replace(returnTo);
      } catch (e) {
        const error = failure(e);
        store.patch({ busy: false, error });
        // The text moved on under the member (a newer version, or one already settled): read it again, taps start over.
        if (error === 'consent.error.changed') await load();
        store.patch({ error });
      }
    },

    async open(docKey) {
      const url = store.get().items.find((i) => i.docKey === docKey)?.url;
      if (url && deps.openURL) await deps.openURL(url);
    },
  };
}

/**
 * Right after sign-in: does this member owe a consent? If so, go to the consent screen with `returnTo` and come back
 * to what they were doing. When the check itself fails (offline), the screen is the safer answer: it asks again.
 * Returns whether it routed.
 */
export async function routeIfPending(deps: { legal: Pick<LegalApi, 'mine'>; router: Router }, returnTo: string): Promise<boolean> {
  try {
    const mine = await deps.legal.mine();
    if (mine.pending.length === 0) return false;
  } catch {
    // fall through to the screen
  }
  deps.router.replace(href(CONSENT_HREF, { returnTo }));
  return true;
}
