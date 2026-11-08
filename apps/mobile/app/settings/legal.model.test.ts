// T-0062: Settings > Legal is read-only: the documents in force and the version and day the member accepted.
import { describe, expect, it } from 'vitest';
import type { LegalApi, LegalDocument } from '../../src/api.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { createLegalModel } from './legal.model.ts';

const doc = (docKey: LegalDocument['docKey'], version: number): LegalDocument => ({
  docKey,
  version,
  title: { en: `${docKey} EN`, he: `${docKey} HE` },
  body: { en: `text ${docKey} EN`, he: `text ${docKey} HE` },
  hash: 'h',
  material: true,
  effectiveAt: '2026-11-01T00:00:00Z',
});

function setup(fail = false) {
  const legal: Pick<LegalApi, 'documents' | 'mine'> = {
    async documents() {
      if (fail) throw new Error('boom');
      return { items: [doc('terms', 2), doc('privacy', 1)] };
    },
    async mine() {
      return {
        accepted: [
          { docKey: 'terms', version: 1, hash: 'a', locale: 'en', acceptedAt: '2026-10-01T00:00:00Z' },
          { docKey: 'privacy', version: 1, hash: 'b', locale: 'en', acceptedAt: '2026-10-01T00:00:00Z' },
        ],
        pending: [{ ...doc('terms', 2), reason: 'material_change' }],
      };
    },
  };
  const router = memoryRouter('/settings/legal');
  const opened: string[] = [];
  return { model: createLegalModel({ legal, router, locale: 'he', webBaseUrl: 'https://legal.example.test', openURL: async (u) => void opened.push(u) }), router, opened };
}

describe('the Legal settings model (T-0062)', () => {
  it('lists each document in the app language with the accepted version, and marks the one with a newer version waiting', async () => {
    const { model } = setup();
    await model.load();
    const rows = model.store.get().rows;
    expect(rows.map((r) => [r.docKey, r.title, r.version, r.acceptedVersion, r.pending])).toEqual([
      ['terms', 'terms HE', 2, 1, true],
      ['privacy', 'privacy HE', 1, 1, false],
    ]);
  });

  it('shows a document\'s text on request, only one at a time, and links the web page', async () => {
    const { model, opened } = setup();
    await model.load();
    model.toggleText('terms');
    expect(model.store.get().open).toBe('terms');
    model.toggleText('privacy');
    expect(model.store.get().open).toBe('privacy');
    model.toggleText('privacy');
    expect(model.store.get().open).toBeUndefined();
    await model.openWeb('terms');
    expect(opened).toEqual(['https://legal.example.test/legal/terms?lang=he']);
  });

  it('review sends the member to the consent screen and back here; a failed load offers retry', async () => {
    const { model, router } = setup();
    await model.load();
    model.review();
    expect(router.current()).toBe('/(auth)/consent?returnTo=%2Fsettings%2Flegal');
    const bad = setup(true);
    await bad.model.load();
    expect(bad.model.store.get()).toMatchObject({ status: 'error', error: 'common.error.generic' });
  });
});
