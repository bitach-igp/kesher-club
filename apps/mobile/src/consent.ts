// The terms at sign-up and at re-accept (T-0062). A plain model over `createStore`; the screen takes it.
//
// What the member sees is the documents in force (public GET /legal/documents) that are pending for them
// (GET /me/consents: never accepted, or a material change since). Each one shows a short summary and a link to
// its web page, and needs its own tap: nothing starts ticked and there is no "accept all". One POST then records
// exactly the versions shown, in the language the app is in. A failure records nothing and offers the same
// button again. A returning member is found by the same `pending` list right after sign-in (`routeIfPending`);
// the server-side `consent_required` gate that would refuse their calls is T-0066 and is not built, so the app
// does not wait for one.
import { createContext, useContext } from 'react';
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
 * chosen yet, so no domain is written here. Without a base (or with one that is not https) there is simply no link: the
 * full text is always shown in the app, so accepting never depends on the web page. The path is a placeholder too, for
 * the web card (T-0048) to confirm.
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
 * The build-time web base, spelled out in full so Expo inlines it. `EXPO_PUBLIC_LEGAL_BASE_URL` is a placeholder key
 * with no value anywhere yet (no web domain is decided); the link is an optional extra and its absence blocks nothing.
 */
export const legalBuild = (): { webBaseUrl: string | undefined } => ({ webBaseUrl: process.env.EXPO_PUBLIC_LEGAL_BASE_URL });

/**
 * Whether this member still owes a consent, held at the root so the route guard can keep them on the consent screen
 * (T-0062). Set when `GET /me/consents` lists anything pending, or when that check itself fails; cleared only after a
 * successful POST (or when nothing is pending, or on sign-out).
 */
export type ConsentGate = Store<{ pending: boolean }>;
export const createConsentGate = (): ConsentGate => createStore<{ pending: boolean }>({ pending: false });
export const ConsentGateContext = createContext<ConsentGate | undefined>(undefined);
export const ConsentGateProvider = ConsentGateContext.Provider;
export function useConsentGate(): ConsentGate {
  const g = useContext(ConsentGateContext);
  if (!g) throw new Error('ConsentGateProvider is missing');
  return g;
}

export interface ConsentItem {
  docKey: LegalDocKey;
  version: number;
  title: string;
  summary: string;
  /** The full text in the app's language, shown in the app so accepting never depends on the web page. */
  body: string;
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
  /** The session ended (401): the only way on is to sign in again. */
  signedOut: boolean;
}

export interface ConsentDeps {
  legal: LegalApi;
  router: Router;
  gate: ConsentGate;
  locale: Locale;
  /** From `EXPO_PUBLIC_LEGAL_BASE_URL`; optional. */
  webBaseUrl: string | undefined;
  /** Where to go when done (validated by `safeReturnTo`). */
  returnTo?: string | undefined;
  openURL?: ((url: string) => Promise<void>) | undefined;
  /** Ends the session (the consent screen's way out). */
  signOut?: (() => void) | undefined;
  signInHref?: string | undefined;
}

export interface ConsentModel {
  store: Store<ConsentState>;
  load(): Promise<void>;
  /** The member's own choice on one document; setting the same value twice changes nothing. */
  set(docKey: LegalDocKey, accepted: boolean): void;
  canContinue(): boolean;
  submit(): Promise<void>;
  open(docKey: LegalDocKey): Promise<void>;
  signOut(): void;
}

/** A request that never got an answer is a `TypeError` from fetch; anything else unknown is our bug, not the network. */
const failure = (e: unknown): CopyKey => {
  if (errorIs(e, { status: 401 })) return 'consent.error.session';
  if (errorIs(e, { status: 422 }) || errorIs(e, { status: 409 }) || errorIs(e, { code: 'VALIDATION_FAILED' })) return 'consent.error.changed';
  if (errorIs(e, { status: 503 }) || errorIs(e, { code: 'PROVIDER_UNAVAILABLE' })) return 'common.error.unavailable';
  if (e instanceof TypeError) return 'consent.error.offline';
  return 'common.error.generic';
};

export function createConsentModel(deps: ConsentDeps): ConsentModel {
  const store = createStore<ConsentState>({ mode: 'loading', items: [], busy: false, signedOut: false });
  const returnTo = safeReturnTo(deps.returnTo);
  const fail = (e: unknown) => {
    const error = failure(e);
    store.patch({ mode: 'error', items: [], busy: false, error, signedOut: error === 'consent.error.session' });
  };

  const load = async () => {
    store.patch({ mode: 'loading', error: undefined, signedOut: false });
    try {
      const [inForce, mine] = await Promise.all([deps.legal.documents(), deps.legal.mine()]);
      if (mine.pending.length === 0) {
        deps.gate.set({ pending: false });
        store.patch({ mode: 'done', items: [] });
        return deps.router.replace(returnTo);
      }
      // Fail closed: a document the server says is owed must be one in force, at that version; otherwise the two reads
      // disagree (a publish in between) and the member is never shown "nothing to accept".
      const current = new Map(inForce.items.map((d) => [d.docKey, d.version] as const));
      if (mine.pending.some((p) => current.get(p.docKey) !== p.version)) {
        return store.patch({ mode: 'error', items: [], error: 'consent.error.changed' });
      }
      // The text, reason and change summary come from the pending entry: that is what is owed.
      const items = mine.pending.map<ConsentItem>((p) => {
        const url = legalLink(deps.webBaseUrl, p.docKey, deps.locale);
        return { docKey: p.docKey, version: p.version, title: p.title[deps.locale], summary: summaryOf(p, deps.locale, p.reason), body: p.body[deps.locale], ...(url ? { url } : {}), reason: p.reason, accepted: false };
      });
      store.patch({ mode: 'ready', items });
    } catch (e) {
      fail(e);
    }
  };

  return {
    store,
    load,

    set(docKey, accepted) {
      const s = store.get();
      if (s.mode !== 'ready' || s.busy) return;
      store.patch({ items: s.items.map((i) => (i.docKey === docKey ? { ...i, accepted } : i)), error: undefined });
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
      } catch (e) {
        const error = failure(e);
        if (error === 'consent.error.session') return fail(e);
        store.patch({ busy: false, error });
        // The text moved on under the member (a newer version, or one already settled): read it again, taps start over.
        if (error === 'consent.error.changed') {
          await load();
          if (store.get().mode === 'ready') store.patch({ error });
        }
        return;
      }
      deps.gate.set({ pending: false });
      store.patch({ busy: false, mode: 'done' });
      deps.router.replace(returnTo);
    },

    async open(docKey) {
      const url = store.get().items.find((i) => i.docKey === docKey)?.url;
      if (!url || !deps.openURL) return;
      try {
        await deps.openURL(url);
      } catch {
        store.patch({ error: 'consent.error.link' });
      }
    },

    signOut() {
      deps.signOut?.();
      deps.gate.set({ pending: false });
      deps.router.replace(deps.signInHref ?? '/(auth)/sign-in');
    },
  };
}

/**
 * Right after sign-in: does this member owe a consent? If so, hold the gate (the route guard keeps them on the consent
 * screen), go there with `returnTo`, and come back to what they were doing. When the check itself fails (offline), the
 * screen is the safer answer: it asks again. Returns whether it routed.
 */
export async function routeIfPending(deps: { legal: Pick<LegalApi, 'mine'>; router: Router; gate: ConsentGate }, returnTo: string): Promise<boolean> {
  try {
    const mine = await deps.legal.mine();
    if (mine.pending.length === 0) {
      deps.gate.set({ pending: false });
      return false;
    }
  } catch {
    // fall through to the screen
  }
  deps.gate.set({ pending: true });
  deps.router.replace(href(CONSENT_HREF, { returnTo }));
  return true;
}
