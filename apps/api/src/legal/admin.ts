// Publishing a legal text through the two-person flow (T-0065). LegalService.publish writes a version straight into
// legal.document_version, so no one calls it directly over HTTP: an admin proposes a version (an ops.approval_request of
// kind 'legal_publish' holding the whole draft), and a second, different admin approves it; only then does the version
// publish, once, with an audit entry, in the one transaction that records the approval. The proposer is the first of the
// two approvers (as for plan versions, T-0932) and so cannot approve again (409). A request left unapproved for the
// approvals service's seven days expires and publishes nothing.
//
// Every proposal is its own request (subject `legal_publish:{docKey}:{uuid}`), so a corrected draft, or the same text again
// after an earlier request was approved, refused or expired, is a new request. Only an OPEN request with the same
// draft hash (a hash of the whole draft: key, titles, bodies, material, summary, effective instant) is returned instead of
// a new one, so a double-click or a second admin proposing the same draft finds the pending request. The lookup and the
// insert are one transaction under an advisory lock on the hash.
//
// The effective date cannot be in the past when proposed, and an approval that comes after it is refused (409) rather than
// taking effect late: the approver lets it lapse and the proposer proposes again. LegalService.current() picks the highest
// version already in force, so a later-numbered version with an earlier date would shadow an earlier future-dated one;
// a proposal or approval dated before an already scheduled version of the same document is therefore refused.
// Texts are plain text, never markup. Limits count code points.
import { createHash } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import { requireStaff } from '../admin/staff-token.ts';
import { ApprovalService, type ApprovalRequest, type Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { Database, SqlClient } from '../db.ts';
import { created, ok, route, type Handler } from '../http.ts';
import { DOC_KEYS, wireDocument } from './routes.ts';
import { LegalService, lockDocument, type DocKey, type DocumentVersion, type Localised } from './service.ts';

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

const OPEN = ['pending', 'awaiting_second_approval'];

/** A hash of the whole draft, the effective date as an instant, so the same draft in another notation is the same draft. */
export const draftHash = (d: LegalDraft): string =>
  createHash('sha256')
    .update(JSON.stringify([d.docKey, d.title.en, d.title.he, d.body.en, d.body.he, d.material, d.changeSummary?.en ?? null, d.changeSummary?.he ?? null, d.effectiveAt.toISOString()]))
    .digest('hex');

export class LegalAdmin {
  private readonly db: Database;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  constructor(db: Database, approvals: ApprovalService, audit: AuditService) {
    this.db = db;
    this.approvals = approvals;
    this.audit = audit;
  }

  /** The first admin proposes. The same draft while a request for it is open answers that request. */
  async propose(draft: LegalDraft, by: Approver, now: Date): Promise<{ proposal: LegalProposal; existing: boolean }> {
    const hash = draftHash(draft);
    return this.db.transaction(async (tx) => {
      const txDb: Database = { query: tx.query, transaction: async (fn) => fn(tx) };
      const approvals = new ApprovalService(txDb);
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('legal-propose:' || $1::text, 0))`, [hash]);
      const open = await tx.query<{ id: string }>(
        `select id from ops.approval_request where kind = 'legal_publish' and status = any($1::text[]) and expires_at > $2 and payload->>'draftHash' = $3 order by created_at desc limit 1`,
        [OPEN, now, hash],
      );
      if (open.rows[0]) return { proposal: toProposal((await approvals.get(open.rows[0].id))!), existing: true };
      await assertNotShadowing(tx, draft, 'VALIDATION_FAILED');
      const payload = { ...draft, effectiveAt: draft.effectiveAt.toISOString(), draftHash: hash };
      const req = await approvals.request({ kind: 'legal_publish', subject: `legal_publish:${draft.docKey}:${uuidv7(now)}`, scope: 'platform', requestedBy: by, payload }, now);
      // The request is new and holds two approvers, so the proposer's decision cannot complete it; both writes commit together.
      return { proposal: toProposal(await approvals.decide(req.id, by, 'approve', now, 'proposed')), existing: false };
    });
  }

  /** The second admin approves; the version publishes in the same transaction, once. */
  async approve(requestId: string, by: Approver, now: Date): Promise<LegalProposal> {
    const pre = await this.approvals.get(requestId);
    if (!pre || pre.kind !== 'legal_publish') throw new DomainError('NOT_FOUND', 'Legal document proposal not found');
    if ((pre.status === 'pending' || pre.status === 'awaiting_second_approval') && Date.parse(pre.expiresAt) <= now.getTime()) {
      await this.approvals.expire(requestId, now);
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Request expired');
    }
    if (OPEN.includes(pre.status) && toDraft(pre.payload).effectiveAt.getTime() < now.getTime()) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'The effective date has passed; propose the document again with a new effective date');
    }
    return this.db.transaction(async (tx) => {
      const txDb: Database = { query: tx.query, transaction: async (fn) => fn(tx) };
      const approval = await new ApprovalService(txDb).decide(requestId, by, 'approve', now);
      if (approval.status !== 'approved') return toProposal(approval);
      const draft = toDraft(approval.payload);
      // Lock order: the approval row (decide), the document, the audit chain. A refusal below rolls the decision back too.
      await lockDocument(tx, draft.docKey);
      await assertNotShadowing(tx, draft, 'IDEMPOTENCY_CONFLICT');
      // The decision row and this publish commit together, and a second approval is refused above, so a text publishes once.
      const published = await new LegalService(txDb).publish({ ...draft, publishedBy: approval.requestedBy });
      await this.audit.record(
        { actorId: by.partyId, actorRole: by.role, action: 'legal_document.publish', subject: `${published.docKey}:${published.version}`, reason: draft.changeSummary?.en ?? `Approved ${published.docKey} version ${published.version}`, before: null, after: { hash: published.hash, material: published.material, effectiveAt: published.effectiveAt }, payload: { approvalId: approval.id, proposedBy: approval.requestedBy } },
        now,
        txDb,
      );
      return { ...toProposal(approval), published };
    });
  }
}

/** A new version is numbered highest, so one dated before a scheduled version of the document would shadow it. */
async function assertNotShadowing(tx: SqlClient, d: LegalDraft, code: 'VALIDATION_FAILED' | 'IDEMPOTENCY_CONFLICT'): Promise<void> {
  const r = await tx.query('select 1 from legal.document_version where doc_key = $1 and effective_at > $2 limit 1', [d.docKey, d.effectiveAt]);
  if (r.rows.length) throw new DomainError(code, `${d.docKey} already has a version scheduled after this effective date; choose a later date`, code === 'VALIDATION_FAILED' ? { field: 'effectiveAt' } : {});
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

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

/** A control character other than the listed whitespace, DEL, or a bidirectional override or isolate. */
function hasForbidden(s: string, allowWhitespace: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x09) {
      if (!allowWhitespace) return true;
    } else if (c <= 0x1f || c === 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

function localised(raw: unknown, field: string, max: number, allowWhitespace: boolean): Localised {
  const v = (raw ?? {}) as { en?: unknown; he?: unknown };
  for (const lang of ['en', 'he'] as const) {
    const s = v[lang];
    if (typeof s !== 'string' || !s.trim()) throw bad(field, `${field}.${lang} is required`);
    if ([...s].length > max) throw bad(field, `${field}.${lang} is longer than ${max} characters`);
    if (hasForbidden(s, allowWhitespace)) throw bad(field, `${field}.${lang} has a control or bidirectional-override character`);
  }
  return { en: v.en as string, he: v.he as string };
}

/** RFC 3339 with Z or an offset; a date alone, a date-time without an offset, or a day the month lacks is refused. */
function instant(raw: unknown): Date {
  const m = typeof raw === 'string' ? RFC3339.exec(raw) : null;
  if (!m) throw bad('effectiveAt', 'effectiveAt must be an RFC 3339 date-time with Z or an offset');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) throw bad('effectiveAt', 'effectiveAt is not a calendar date');
  const at = new Date(raw as string);
  if (Number.isNaN(at.getTime())) throw bad('effectiveAt', 'effectiveAt is not a date-time');
  return at;
}

/** The proposal body, checked before anything is written. Texts are plain text. */
export function parseDraft(raw: unknown, now: Date): LegalDraft {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b['docKey'] !== 'string' || !DOC_KEYS.includes(b['docKey'] as DocKey)) throw bad('docKey', 'docKey is not a legal document');
  if (typeof b['material'] !== 'boolean') throw bad('material', 'material must be true or false');
  const effectiveAt = instant(b['effectiveAt']);
  if (effectiveAt.getTime() < now.getTime()) throw bad('effectiveAt', 'effectiveAt cannot be in the past');
  return {
    docKey: b['docKey'] as DocKey,
    title: localised(b['title'], 'title', MAX_TITLE, false),
    body: localised(b['body'], 'body', MAX_BODY, true),
    material: b['material'],
    ...(b['changeSummary'] !== undefined ? { changeSummary: localised(b['changeSummary'], 'changeSummary', MAX_SUMMARY, true) } : {}),
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
