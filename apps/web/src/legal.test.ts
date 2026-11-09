import { describe, expect, it } from 'vitest';
import { fixtureItems } from './build-fixture.ts';
import { DOC_KEYS, fetchLegalDocuments, LegalBuildError, parseLegalDocuments } from './legal.ts';

const answer = (items: unknown[], status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({ items }) });

describe('legal documents at build time (T-0048)', () => {
  it('reads all seven kinds, both languages', async () => {
    const docs = await fetchLegalDocuments('https://api.example.test/v1', answer(fixtureItems()));
    expect(Object.keys(docs)).toEqual([...DOC_KEYS]);
    expect(docs.terms.title.he).toBe('terms כותרת');
    expect(docs.terms.effectiveDate).toBe('2026-03-04');
  });

  it('asks for GET {base}/legal/documents, without a trailing-slash accident, and never follows a redirect', async () => {
    let seen: { url: string; redirect: string | undefined } | undefined;
    await fetchLegalDocuments('https://api.example.test/v1/', async (url, init) => {
      seen = { url, redirect: init?.redirect };
      return { ok: true, status: 200, json: async () => ({ items: fixtureItems() }) };
    });
    expect(seen).toEqual({ url: 'https://api.example.test/v1/legal/documents', redirect: 'error' });
  });

  it.each(DOC_KEYS)('fails the build when %s has no published version', async (kind) => {
    await expect(fetchLegalDocuments('https://x.test/v1', answer(fixtureItems({ omit: [kind] })))).rejects.toThrow(new LegalBuildError(`no published version for: ${kind}`));
  });

  it('names every missing kind at once', () => {
    expect(() => parseLegalDocuments({ items: fixtureItems({ omit: ['esim', 'funder'] }) })).toThrow(/esim, funder/);
  });

  it('fails closed on an error status, an unreachable API, a non-JSON answer and a malformed document', async () => {
    await expect(fetchLegalDocuments('https://x.test/v1', answer([], 503))).rejects.toThrow(/answered 503/);
    await expect(fetchLegalDocuments('https://x.test/v1', async () => { throw new Error('ECONNREFUSED'); })).rejects.toThrow(/could not be reached/);
    await expect(fetchLegalDocuments('https://x.test/v1', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }))).rejects.toThrow(/not JSON/);
    const bad = (patch: Record<string, unknown>) => fixtureItems().map((d, i) => (i === 0 ? { ...(d as object), ...patch } : d));
    expect(() => parseLegalDocuments({ items: bad({ body: { en: 'only english', he: '' } }) })).toThrow(/both languages/);
    expect(() => parseLegalDocuments({ items: bad({ version: 0 }) })).toThrow(/valid version/);
    expect(() => parseLegalDocuments({ items: bad({ effectiveAt: 'soon' }) })).toThrow(/effectiveAt/);
    expect(() => parseLegalDocuments({ items: [...fixtureItems(), fixtureItems()[0]] })).toThrow(/twice/);
    expect(() => parseLegalDocuments({})).toThrow(/no items/);
  });

  it('does not put the response into the error (it may carry anything)', async () => {
    const res = async () => ({ ok: false, status: 500, json: async () => ({ detail: 'SECRET-DETAIL' }) });
    await expect(fetchLegalDocuments('https://x.test/v1', res)).rejects.not.toThrow(/SECRET-DETAIL/);
  });

  it('ignores a kind this site does not know, rather than publishing it unreviewed', () => {
    const docs = parseLegalDocuments({ items: [...fixtureItems(), { docKey: 'future', version: 1 }] });
    expect(Object.keys(docs)).toEqual([...DOC_KEYS]);
  });
});
