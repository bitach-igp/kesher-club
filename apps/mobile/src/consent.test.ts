// T-0062: the terms at sign-up and re-accept. The model is driven directly; the view takes it.
import { describe, expect, it } from 'vitest';
import type { LegalApi, LegalDocument, MyConsents, PendingLegalDocument } from './api.ts';
import { createConsentGate, createConsentModel, legalLink, routeIfPending, safeReturnTo, summaryOf, type ConsentDeps } from './consent.ts';
import { memoryRouter } from './navigation.ts';

class ApiProblem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const doc = (docKey: LegalDocument['docKey'], version = 1, extra: Partial<LegalDocument> = {}): LegalDocument => ({
  docKey,
  version,
  title: { en: `${docKey} title`, he: `כותרת ${docKey}` },
  body: { en: `Body of ${docKey}. `.repeat(60), he: `נוסח ${docKey}. `.repeat(60) },
  hash: `h-${docKey}-${version}`,
  material: true,
  effectiveAt: '2026-11-01T00:00:00Z',
  ...extra,
});
const pending = (d: LegalDocument, reason: PendingLegalDocument['reason'] = 'first'): PendingLegalDocument => ({ ...d, reason });

function fakeLegal(opts: { inForce?: LegalDocument[]; pending?: PendingLegalDocument[]; accepted?: MyConsents['accepted']; failRecord?: unknown[]; failDocuments?: unknown; afterFailure?: () => void } = {}) {
  const inForce = opts.inForce ?? [doc('terms'), doc('privacy')];
  const posts: Parameters<LegalApi['record']>[0][] = [];
  const failures = [...(opts.failRecord ?? [])];
  const api: LegalApi = {
    async documents() {
      if (opts.failDocuments) throw opts.failDocuments;
      return { items: opts.inForce ?? inForce };
    },
    async mine() {
      return { accepted: opts.accepted ?? [], pending: opts.pending ?? (opts.inForce ?? inForce).map((d) => pending(d)) };
    },
    async record(input) {
      posts.push(input);
      const failure = failures.shift();
      if (failure) {
        opts.afterFailure?.();
        throw failure;
      }
      return { accepted: input.documents.map((d) => ({ ...d, hash: 'h', locale: input.locale, acceptedAt: '2026-11-01T09:00:00Z' })) };
    },
  };
  return { api, posts };
}

function setup(opts: Parameters<typeof fakeLegal>[0] = {}, deps: Partial<ConsentDeps> = {}) {
  const legal = fakeLegal(opts);
  const router = memoryRouter('/(auth)/consent');
  const opened: string[] = [];
  const gate = createConsentGate();
  gate.set({ pending: true });
  const model = createConsentModel({ legal: legal.api, router, gate, locale: 'en', webBaseUrl: 'https://legal.example.test', openURL: async (u) => void opened.push(u), ...deps });
  return { model, router, opened, gate, ...legal };
}

describe('the consent model (T-0062)', () => {
  it('shows each pending document with a summary and a web link, nothing ticked', async () => {
    const { model } = setup();
    await model.load();
    const s = model.store.get();
    expect(s.mode).toBe('ready');
    expect(s.items.map((i) => [i.docKey, i.version, i.accepted])).toEqual([
      ['terms', 1, false],
      ['privacy', 1, false],
    ]);
    expect(s.items[0]?.summary.length).toBeLessThanOrEqual(281);
    expect(s.items[0]?.body).toContain('Body of terms.');
    expect(s.items[0]?.url).toBe('https://legal.example.test/legal/terms?lang=en');
    expect(model.canContinue()).toBe(false);
  });

  it('needs an explicit tap per document: one tap does not accept the other, and submit stays closed until all are tapped', async () => {
    const { model, posts } = setup();
    await model.load();
    model.set('terms', true);
    expect(model.canContinue()).toBe(false);
    await model.submit();
    expect(posts).toEqual([]);
    model.set('privacy', true);
    expect(model.canContinue()).toBe(true);
    model.set('privacy', true); // the same value twice (a double-fired switch) changes nothing
    expect(model.canContinue()).toBe(true);
    model.set('privacy', false);
    expect(model.canContinue()).toBe(false);
  });

  it('posts exactly the documents shown, once, with the UI locale, and continues to returnTo', async () => {
    const { model, posts, router } = setup({}, { locale: 'he', returnTo: '/card' });
    await model.load();
    model.set('terms', true);
    model.set('privacy', true);
    await model.submit();
    expect(posts).toEqual([{ documents: [{ docKey: 'terms', version: 1 }, { docKey: 'privacy', version: 1 }], locale: 'he' }]);
    expect(model.store.get().mode).toBe('done');
    expect(router.current()).toBe('/card');
  });

  it('shows only what the member still owes, with the changed text for a material change', async () => {
    const privacy = doc('privacy', 2, { changeSummary: { en: 'We added a retention period.', he: 'הוספנו תקופת שמירה.' } });
    const { model } = setup({ inForce: [doc('terms'), privacy], pending: [pending(privacy, 'material_change')] });
    await model.load();
    const items = model.store.get().items;
    expect(items.map((i) => i.docKey)).toEqual(['privacy']);
    expect(items[0]).toMatchObject({ reason: 'material_change', summary: 'We added a retention period.', version: 2 });
  });

  it('a failure records nothing, says why, and the same button tries again', async () => {
    const { model, posts, router } = setup({ failRecord: [new TypeError('Network request failed')] });
    await model.load();
    model.set('terms', true);
    model.set('privacy', true);
    await model.submit();
    expect(model.store.get()).toMatchObject({ mode: 'ready', busy: false, error: 'consent.error.offline' });
    expect(router.current()).toBe('/(auth)/consent');
    expect(model.canContinue()).toBe(true);
    await model.submit();
    expect(posts).toHaveLength(2);
    expect(model.store.get().mode).toBe('done');
    expect(router.current()).toBe('/');
  });

  it('a 422 or 409 reads the documents again and asks for new taps', async () => {
    for (const status of [422, 409]) {
      const { model, posts } = setup({ failRecord: [new ApiProblem(status === 422 ? 'VALIDATION_FAILED' : 'IDEMPOTENCY_CONFLICT', status)] });
      await model.load();
      model.set('terms', true);
      model.set('privacy', true);
      await model.submit();
      const s = model.store.get();
      expect(s.error).toBe('consent.error.changed');
      expect(s.items.every((i) => !i.accepted)).toBe(true);
      expect(posts).toHaveLength(1);
    }
  });

  it('a 503 reads as unavailable; a failed load offers retry', async () => {
    const down = setup({ failRecord: [new ApiProblem('PROVIDER_UNAVAILABLE', 503)] });
    await down.model.load();
    down.model.set('terms', true);
    down.model.set('privacy', true);
    await down.model.submit();
    expect(down.model.store.get().error).toBe('common.error.unavailable');

    const offline = setup({ failDocuments: new TypeError('Network request failed') });
    await offline.model.load();
    expect(offline.model.store.get()).toMatchObject({ mode: 'error', error: 'consent.error.offline' });
  });

  it('nothing pending goes straight on', async () => {
    const { model, router } = setup({ pending: [] }, { returnTo: '/pay' });
    await model.load();
    expect(router.current()).toBe('/pay');
  });

  it('without a web base URL there is no link and nothing is blocked: the full text is in the app', async () => {
    const { model, posts } = setup({}, { webBaseUrl: undefined });
    await model.load();
    expect(model.store.get().mode).toBe('ready');
    expect(model.store.get().items.every((i) => i.url === undefined && i.body.length > 0)).toBe(true);
    model.set('terms', true);
    model.set('privacy', true);
    await model.submit();
    expect(posts).toHaveLength(1);
  });

  it('a double submit sends one POST, and success clears the consent gate', async () => {
    const { model, posts, gate } = setup();
    await model.load();
    model.set('terms', true);
    model.set('privacy', true);
    await Promise.all([model.submit(), model.submit()]);
    expect(posts).toHaveLength(1);
    expect(gate.get().pending).toBe(false);
  });

  it('a failure leaves the consent gate held', async () => {
    const { model, gate } = setup({ failRecord: [new TypeError('x')] });
    await model.load();
    model.set('terms', true);
    model.set('privacy', true);
    await model.submit();
    expect(gate.get().pending).toBe(true);
  });

  it('after a 422 the new version is shown and the next POST carries it', async () => {
    const live = { inForce: [doc('terms', 1), doc('privacy', 1)] };
    const legal = fakeLegal({
      inForce: live.inForce,
      failRecord: [new ApiProblem('VALIDATION_FAILED', 422)],
      afterFailure: () => void (live.inForce[0] = doc('terms', 2)),
    });
    const router = memoryRouter('/(auth)/consent');
    const model = createConsentModel({ legal: legal.api, router, gate: createConsentGate(), locale: 'en', webBaseUrl: undefined });
    await model.load();
    model.set('terms', true);
    model.set('privacy', true);
    await model.submit();
    expect(model.store.get().items.find((i) => i.docKey === 'terms')?.version).toBe(2);
    expect(model.store.get().error).toBe('consent.error.changed');
    model.set('terms', true);
    model.set('privacy', true);
    await model.submit();
    expect(legal.posts[1]?.documents).toEqual([{ docKey: 'terms', version: 2 }, { docKey: 'privacy', version: 1 }]);
  });

  it('fails closed when a pending document is not in force or at another version: error, never "done"', async () => {
    const missing = setup({ inForce: [doc('terms')], pending: [pending(doc('terms')), pending(doc('privacy'))] });
    await missing.model.load();
    expect(missing.model.store.get()).toMatchObject({ mode: 'error', error: 'consent.error.changed', items: [] });
    expect(missing.router.current()).toBe('/(auth)/consent');
    expect(missing.gate.get().pending).toBe(true);

    const other = setup({ inForce: [doc('terms', 3)], pending: [pending(doc('terms', 2))] });
    await other.model.load();
    expect(other.model.store.get().mode).toBe('error');
  });

  it('uses the pending entry\'s reason and change summary', async () => {
    const terms = doc('terms', 2, { changeSummary: { en: 'Fees changed.', he: 'העמלות השתנו.' } });
    const { model } = setup({ inForce: [terms], pending: [pending(terms, 'material_change')] });
    await model.load();
    expect(model.store.get().items[0]).toMatchObject({ summary: 'Fees changed.', reason: 'material_change', version: 2 });
  });

  it('tells a network failure from a bug, and a 401 sends the member to sign in instead of retrying', async () => {
    const bug = setup({ failRecord: [new Error('undefined is not a function')] });
    await bug.model.load();
    bug.model.set('terms', true);
    bug.model.set('privacy', true);
    await bug.model.submit();
    expect(bug.model.store.get().error).toBe('common.error.generic');

    const expired = setup({ failRecord: [new ApiProblem('UNAUTHENTICATED', 401)] });
    await expired.model.load();
    expired.model.set('terms', true);
    expired.model.set('privacy', true);
    await expired.model.submit();
    expect(expired.model.store.get()).toMatchObject({ mode: 'error', error: 'consent.error.session', signedOut: true });
  });

  it('signing out ends the session, releases the gate and goes to sign-in', () => {
    let out = 0;
    const { model, router, gate } = setup({}, { signOut: () => void (out += 1) });
    model.signOut();
    expect([out, gate.get().pending, router.current()]).toEqual([1, false, '/(auth)/sign-in']);
  });

  it('a rejected openURL is caught and shown', async () => {
    const { model } = setup({}, { openURL: async () => Promise.reject(new Error('no handler')) });
    await model.load();
    await model.open('terms');
    expect(model.store.get()).toMatchObject({ mode: 'ready', error: 'consent.error.link' });
  });

  it('opens a document\'s web page', async () => {
    const { model, opened } = setup();
    await model.load();
    await model.open('privacy');
    expect(opened).toEqual(['https://legal.example.test/legal/privacy?lang=en']);
  });
});

describe('helpers', () => {
  it('legalLink needs an https base', () => {
    expect(legalLink('https://x.test/', 'terms', 'he')).toBe('https://x.test/legal/terms?lang=he');
    expect(legalLink('http://x.test', 'terms', 'en')).toBeUndefined();
    expect(legalLink('not a url', 'terms', 'en')).toBeUndefined();
    expect(legalLink(undefined, 'terms', 'en')).toBeUndefined();
  });

  it('safeReturnTo keeps in-app routes only', () => {
    expect([safeReturnTo('/card?x=1'), safeReturnTo('//evil.test'), safeReturnTo('https://evil.test'), safeReturnTo(undefined)]).toEqual(['/card?x=1', '/', '/', '/']);
  });

  it('summaryOf cuts long text and prefers the change summary only for a material change', () => {
    const d = doc('terms', 2, { changeSummary: { en: 'Changed.', he: 'שונה.' } });
    expect(summaryOf(d, 'en', 'material_change')).toBe('Changed.');
    expect(summaryOf(d, 'en', 'first').endsWith('…')).toBe(true);
    expect(summaryOf(d, 'he', 'material_change')).toBe('שונה.');
  });
});

describe('a returning member (the server gate, T-0066, is not built: the app asks GET /me/consents)', () => {
  it('pending consents route to the consent screen with returnTo, and the screen sends them back', async () => {
    const legal = fakeLegal();
    const router = memoryRouter('/(auth)/sign-in');
    const gate = createConsentGate();
    expect(await routeIfPending({ legal: legal.api, router, gate }, '/card/lost')).toBe(true);
    expect(gate.get().pending).toBe(true);
    expect(router.current()).toBe('/(auth)/consent?returnTo=%2Fcard%2Flost');

    const returnTo = decodeURIComponent(router.current().split('returnTo=')[1] ?? '');
    const model = createConsentModel({ legal: legal.api, router, gate, locale: 'en', webBaseUrl: 'https://legal.example.test', returnTo });
    await model.load();
    model.set('terms', true);
    model.set('privacy', true);
    await model.submit();
    expect(router.current()).toBe('/card/lost');
    expect(gate.get().pending).toBe(false);
  });

  it('nothing pending stays put; a failed check goes to the screen, which asks again', async () => {
    const none = fakeLegal({ pending: [] });
    const r1 = memoryRouter('/');
    const g1 = createConsentGate();
    g1.set({ pending: true });
    expect(await routeIfPending({ legal: none.api, router: r1, gate: g1 }, '/')).toBe(false);
    expect(g1.get().pending).toBe(false);
    expect(r1.current()).toBe('/');

    const r2 = memoryRouter('/');
    const broken = { async mine(): Promise<MyConsents> { throw new TypeError('offline'); } };
    const g2 = createConsentGate();
    expect(await routeIfPending({ legal: broken, router: r2, gate: g2 }, '/')).toBe(true);
    expect(g2.get().pending).toBe(true);
    expect(r2.current()).toBe('/(auth)/consent?returnTo=%2F');
  });
});
