// The legal documents over HTTP (T-0061). Anyone can read what is in force (the app shows it before sign-up, Stripe and the
// stores link it); a signed-in member sees what they accepted and what is still pending, and records acceptance. The service
// (T-0304) keeps the versions and the consents; this file is only the wire.
//
// Acceptance is recorded against the device the token is bound to and the locale the member read it in. No IP address is
// collected: the consent records none (the column is nullable since T-0067; rows written before it hold 0.0.0.0, which meant the
// same). Recording the same (document, version) again is a no-op.
import { DomainError } from '@kesher/domain';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';
import type { Consent, DocKey, DocumentVersion, LegalService } from './service.ts';

export const DOC_KEYS: readonly DocKey[] = ['terms', 'privacy', 'cardholder', 'esim', 'insurance', 'p2p', 'funder'];
/** A request names at most one version per document. */
const MAX_DOCUMENTS = DOC_KEYS.length;

const wireConsent = (c: Consent) => ({ docKey: c.docKey, version: c.version, hash: c.hash, locale: c.locale, acceptedAt: c.acceptedAt });

/** What the app needs to show and accept a document; the hash lets it prove which text was shown. */
export const wireDocument = (d: DocumentVersion) => ({
  docKey: d.docKey,
  version: d.version,
  title: d.title,
  body: d.body,
  hash: d.hash,
  material: d.material,
  ...(d.changeSummary ? { changeSummary: d.changeSummary } : {}),
  effectiveAt: d.effectiveAt,
});

/** The documents in force that this request could ask about: every key with a version already effective. */
async function inForce(legal: LegalService, at: Date): Promise<DocumentVersion[]> {
  const out: DocumentVersion[] = [];
  for (const key of DOC_KEYS) {
    try {
      out.push(await legal.current(key, at));
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'NOT_FOUND')) throw e;
    }
  }
  return out;
}

export function legalHandlers(legal: LegalService): Record<string, Handler> {
  return {
    getLegalDocuments: route(async (req) => ok({ items: (await inForce(legal, req.now)).map(wireDocument) })),

    getMyConsents: route(async (req) => {
      const p = requirePrincipal(req);
      const [accepted, pending] = await Promise.all([legal.consents(p.partyId), legal.pending(p.partyId, req.now)]);
      return ok({ accepted: accepted.map(wireConsent), pending: pending.map((d) => ({ ...wireDocument(d), reason: d.reason })) });
    }),

    recordConsents: route(async (req) => {
      const p = requirePrincipal(req);
      const body = (req.body ?? {}) as { documents?: unknown; locale?: unknown };
      if (body.locale !== 'en' && body.locale !== 'he') throw new DomainError('VALIDATION_FAILED', 'locale must be en or he', { field: 'locale' });
      if (!Array.isArray(body.documents) || body.documents.length < 1 || body.documents.length > MAX_DOCUMENTS) {
        throw new DomainError('VALIDATION_FAILED', `documents must list 1 to ${MAX_DOCUMENTS} document versions`, { field: 'documents' });
      }
      const seen = new Set<string>();
      const asked = body.documents.map((raw, i) => {
        const d = (raw ?? {}) as { docKey?: unknown; version?: unknown };
        if (typeof d.docKey !== 'string' || !DOC_KEYS.includes(d.docKey as DocKey)) throw new DomainError('VALIDATION_FAILED', `documents[${i}].docKey is not a document`, { field: 'documents' });
        if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1) throw new DomainError('VALIDATION_FAILED', `documents[${i}].version must be a positive integer`, { field: 'documents' });
        if (seen.has(d.docKey)) throw new DomainError('VALIDATION_FAILED', `documents names ${d.docKey} twice`, { field: 'documents' });
        seen.add(d.docKey);
        return { docKey: d.docKey as DocKey, version: d.version };
      });
      // Only a version that is in force can be accepted: a member cannot pre-accept a draft or an old text.
      const current = new Map((await inForce(legal, req.now)).map((d) => [d.docKey, d.version] as const));
      for (const a of asked) {
        if (current.get(a.docKey) !== a.version) throw new DomainError('VALIDATION_FAILED', `${a.docKey} version ${a.version} is not the version in force`, { field: 'documents' });
      }
      const recorded: Consent[] = [];
      for (const a of asked) recorded.push(await legal.accept({ partyId: p.partyId, docKey: a.docKey, version: a.version, deviceId: p.deviceId, locale: body.locale }, req.now));
      return ok({ accepted: recorded.map(wireConsent) }, 201);
    }),
  };
}
