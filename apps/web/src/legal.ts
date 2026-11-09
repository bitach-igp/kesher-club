// The legal documents, fetched from the API at BUILD time (T-0048, T-0061) and rendered as plain text. The build fails closed: a failed
// fetch, a malformed answer, or any document kind without a published version stops the build, so the site never ships with a gap that
// the app, Stripe or a store would link to.
export const DOC_KEYS = ['terms', 'privacy', 'cardholder', 'esim', 'insurance', 'p2p', 'funder'] as const;
export type DocKey = (typeof DOC_KEYS)[number];
export type Lang = 'en' | 'he';
export const LANGS: readonly Lang[] = ['en', 'he'];

export interface LegalDoc {
  docKey: DocKey;
  version: number;
  title: Record<Lang, string>;
  body: Record<Lang, string>;
  hash: string;
  /** ISO calendar date (UTC) the version came into force. */
  effectiveDate: string;
}

export class LegalBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalBuildError';
  }
}

export const isDocKey = (s: string): s is DocKey => (DOC_KEYS as readonly string[]).includes(s);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function localised(v: unknown, what: string): Record<Lang, string> {
  if (!isRecord(v) || typeof v.en !== 'string' || typeof v.he !== 'string' || v.en.trim() === '' || v.he.trim() === '') {
    throw new LegalBuildError(`${what} must carry non-empty text in both languages`);
  }
  return { en: v.en, he: v.he };
}

/** Validates the answer of GET /legal/documents. Every DOC_KEYS entry must be present exactly once; unknown kinds are ignored. */
export function parseLegalDocuments(payload: unknown): Record<DocKey, LegalDoc> {
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw new LegalBuildError('the legal API answer has no items list');
  const found = new Map<DocKey, LegalDoc>();
  for (const raw of payload.items as unknown[]) {
    if (!isRecord(raw) || typeof raw.docKey !== 'string') throw new LegalBuildError('a legal document has no docKey');
    if (!isDocKey(raw.docKey)) continue;
    const key = raw.docKey;
    if (found.has(key)) throw new LegalBuildError(`${key} is listed twice`);
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) throw new LegalBuildError(`${key} has no valid version`);
    if (typeof raw.hash !== 'string' || raw.hash === '') throw new LegalBuildError(`${key} has no hash`);
    const effective = typeof raw.effectiveAt === 'string' ? new Date(raw.effectiveAt) : undefined;
    if (!effective || Number.isNaN(effective.getTime())) throw new LegalBuildError(`${key} has no valid effectiveAt`);
    found.set(key, {
      docKey: key,
      version: raw.version,
      title: localised(raw.title, `${key} title`),
      body: localised(raw.body, `${key} body`),
      hash: raw.hash,
      effectiveDate: effective.toISOString().slice(0, 10),
    });
  }
  const missing = DOC_KEYS.filter((k) => !found.has(k));
  if (missing.length > 0) throw new LegalBuildError(`no published version for: ${missing.join(', ')}`);
  return Object.fromEntries(DOC_KEYS.map((k) => [k, found.get(k) as LegalDoc])) as Record<DocKey, LegalDoc>;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: 'error' }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** `${base}/legal/documents`, public and unauthenticated. Never follows a redirect; never echoes the response into the error. */
export async function fetchLegalDocuments(base: string, fetchFn: FetchLike = fetch): Promise<Record<DocKey, LegalDoc>> {
  const url = `${base.replace(/\/+$/, '')}/legal/documents`;
  let res;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  } catch {
    throw new LegalBuildError('the legal API could not be reached');
  }
  if (!res.ok) throw new LegalBuildError(`the legal API answered ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LegalBuildError('the legal API answer is not JSON');
  }
  return parseLegalDocuments(json);
}

let cached: Promise<Record<DocKey, LegalDoc>> | undefined;
/** One fetch per build process; the pages share it. */
export function legalDocuments(base: string): Promise<Record<DocKey, LegalDoc>> {
  cached ??= fetchLegalDocuments(base);
  return cached;
}
