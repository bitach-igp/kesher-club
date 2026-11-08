// Publishing a legal text through the two-person flow (T-0065). LegalService.publish writes a version straight into
// legal.document_version, so no one calls it directly over HTTP: an admin proposes a version (an ops.approval_request of
// kind 'legal_publish' holding the whole text), and a second, different admin approves it; only then does the version
// publish, once, with an audit entry, in the one transaction that records the approval. The proposer is the first of the
// two approvers (as for plan versions, T-0932) and so cannot approve again (409). A request left unapproved for the
// approvals service's seven days expires and publishes nothing.
//
// The request's subject is the document key and the hash of both bodies, so proposing the same text for the same document
// again finds the request already made (and does not make a second). A text that was published, refused or expired cannot
// be proposed again verbatim: change a word, or ask for the earlier request to be reopened by a follow-up card.
// An effective date cannot be in the past when proposed; if the approval comes after it, the version is in force from the
// approval (a published text never takes effect retroactively, since members may have been asked to accept the old one).
import { createHash } from 'node:crypto';
import { DomainError } from '@kesher/domain';
import { requireStaff } from '../admin/staff-token.ts';
import { ApprovalService, type ApprovalRequest, type Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { Database } from '../db.ts';
import { created, ok, route, type Handler } from '../http.ts';
import { DOC_KEYS, wireDocument } from './routes.ts';
import { LegalService, type DocKey, type DocumentVersion, type Localised } from './service.ts';

const MAX_TITLE = 200;
const MAX_BODY = 200_000;
const MAX_SUMMARY = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LegalDraft {
  docKey: DocKey;
  title: Localised;
  body: Localised;
  material: boolean;
  changeSummary?: Localised;
  effectiveAt: Date;
}

export interface LegalProposal extends LegalDraft {
  id: string;
  status: ApprovalRequest['status'];
  approvals: number;
  requestedBy: string;
  expiresAt: string;
  published?: DocumentVersion;
}

/** One request per document and text. */
export const legalSubject = (draft: Pick<LegalDraft, 'docKey' | 'body'>): string =>
  `legal_publish:${draft.docKey}:${createHash('sha256').update(`${draft.docKey}\n${draft.body.en}\n${draft.body.he}`).digest('hex')}`;

export class LegalAdmin {
  private readonly db: Database;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  constructor(db: Database, approvals: ApprovalService, audit: AuditService) {
    this.db = db;
    this.approvals = approvals;
    this.audit = audit;
  }

  /** The first admin proposes. A second proposal of the same text answers the request already made. */
  async propose(draft: LegalDraft, by: Approver, now: Date): Promise<{ proposal: LegalProposal; existing: boolean }> {
    const subject = legalSubject(draft);
    const before = await this.approvals.find('legal_publish', subject);
    const payload = { ...draft, effectiveAt: draft.effectiveAt.toISOString() };
    const req = await this.approvals.request({ kind: 'legal_publish', subject, scope: 'platform', requestedBy: by, payload }, now);
    const decided = !before && req.approvals === 0 && req.requestedBy === by.partyId ? await this.approvals.decide(req.id, by, 'approve', now, 'proposed') : req;
    return { proposal: toProposal(decided), existing: before !== undefined };
  }

  /** The second admin approves; the version publishes in the same transaction, once. */
  async approve(requestId: string, by: Approver, now: Date): Promise<LegalProposal> {
    const pre = await this.approvals.get(requestId);
    if (!pre || pre.kind !== 'legal_publish') throw new DomainError('NOT_FOUND', 'Legal document proposal not found');
    if ((pre.status === 'pending' || pre.status === 'awaiting_second_approval') && Date.parse(pre.expiresAt) <= now.getTime()) {
      await this.approvals.expire(requestId, now);
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Request expired');
    }
    return this.db.transaction(async (tx) => {
      const txDb: Database = { query: tx.query, transaction: async (fn) => fn(tx) };
      const approval = await new ApprovalService(txDb).decide(requestId, by, 'approve', now);
      if (approval.status !== 'approved') return toProposal(approval);
      const draft = toDraft(approval.payload);
      // The decision row and this publish commit together, and a second approval is refused above, so a text publishes once.
      const published = await new LegalService(txDb).publish({ ...draft, effectiveAt: draft.effectiveAt.getTime() < now.getTime() ? now : draft.effectiveAt, publishedBy: approval.requestedBy });
      await this.audit.record(
        { actorId: by.partyId, actorRole: by.role, action: 'legal_document.publish', subject: `${published.docKey}:${published.version}`, reason: draft.changeSummary?.en ?? `Approved ${published.docKey} version ${published.version}`, before: null, after: { hash: published.hash, material: published.material, effectiveAt: published.effectiveAt }, payload: { approvalId: approval.id, proposedBy: approval.requestedBy } },
        now,
        txDb,
      );
      return { ...toProposal(approval), published };
    });
  }
}

function toDraft(p: Record<string, unknown>): LegalDraft {
  const d = p as unknown as Omit<LegalDraft, 'effectiveAt'> & { effectiveAt: string };
  return { docKey: d.docKey, title: d.title, body: d.body, material: d.material, ...(d.changeSummary ? { changeSummary: d.changeSummary } : {}), effectiveAt: new Date(d.effectiveAt) };
}

function toProposal(r: ApprovalRequest): LegalProposal {
  return { ...toDraft(r.payload), id: r.id, status: r.status, approvals: r.approvals, requestedBy: r.requestedBy, expiresAt: r.expiresAt };
}

const wireProposal = (p: LegalProposal) => ({
  id: p.id,
  docKey: p.docKey,
  title: p.title,
  body: p.body,
  material: p.material,
  ...(p.changeSummary ? { changeSummary: p.changeSummary } : {}),
  effectiveAt: p.effectiveAt.toISOString(),
  status: p.status,
  approvals: p.approvals,
  requestedBy: p.requestedBy,
  expiresAt: p.expiresAt,
  ...(p.published ? { published: wireDocument(p.published) } : {}),
});

const bad = (field: string, message: string) => new DomainError('VALIDATION_FAILED', message, { field });

function localised(raw: unknown, field: string, max: number): Localised {
  const v = (raw ?? {}) as { en?: unknown; he?: unknown };
  for (const lang of ['en', 'he'] as const) {
    const s = v[lang];
    if (typeof s !== 'string' || !s.trim()) throw bad(field, `${field}.${lang} is required`);
    if (s.length > max) throw bad(field, `${field}.${lang} is longer than ${max} characters`);
  }
  return { en: v.en as string, he: v.he as string };
}

/** The proposal body, checked before anything is written. */
export function parseDraft(raw: unknown, now: Date): LegalDraft {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b['docKey'] !== 'string' || !DOC_KEYS.includes(b['docKey'] as DocKey)) throw bad('docKey', 'docKey is not a legal document');
  if (typeof b['material'] !== 'boolean') throw bad('material', 'material must be true or false');
  if (typeof b['effectiveAt'] !== 'string' || Number.isNaN(Date.parse(b['effectiveAt']))) throw bad('effectiveAt', 'effectiveAt must be a date-time');
  const effectiveAt = new Date(b['effectiveAt']);
  if (effectiveAt.getTime() < now.getTime()) throw bad('effectiveAt', 'effectiveAt cannot be in the past');
  return {
    docKey: b['docKey'] as DocKey,
    title: localised(b['title'], 'title', MAX_TITLE),
    body: localised(b['body'], 'body', MAX_BODY),
    material: b['material'],
    ...(b['changeSummary'] !== undefined ? { changeSummary: localised(b['changeSummary'], 'changeSummary', MAX_SUMMARY) } : {}),
    effectiveAt,
  };
}

export function legalAdminHandlers(admin: LegalAdmin): Record<string, Handler> {
  return {
    proposeAdminLegalDocument: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const draft = parseDraft(req.body, req.now);
      const r = await admin.propose(draft, { partyId: p.partyId, role: 'admin' }, req.now);
      return r.existing ? ok(wireProposal(r.proposal)) : created(wireProposal(r.proposal));
    }),
    approveAdminLegalDocument: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const id = req.params['requestId'] ?? '';
      if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 'Legal document proposal not found');
      return ok(wireProposal(await admin.approve(id, { partyId: p.partyId, role: 'admin' }, req.now)));
    }),
  };
}
