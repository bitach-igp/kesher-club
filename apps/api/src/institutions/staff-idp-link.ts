// Staff IdP link (T-0789, REQ-AUTH-008): maps an institution's IdP subject (`OrgIdentity.subject`, `ScimEvent.subject`) to a
// staff party, so a directory event can find who to deprovision. Dark: no route and no flag read here; the callers are T-0790
// (find) and T-0792 (link).
// - The IdP's subject is the key, never an email address: an address an attacker controls IdP-side must not reach a staff row.
// - Only ACTIVE staff of that institution can be linked. A subject has one live party; a party has one live link, so it cannot
//   sit in two institutions. A repeat of the same link is a no-op.
// - Insert-only: unlink sets `unlinked_at`; a later link is a new row. The grants allow nothing else.
// - Every link and unlink writes an audit row. The subject is not copied into it, only the party and institution.
import { DomainError, uuidv7 } from '@kesher/domain';
import type { AuditService } from '../audit/service.ts';
import type { Database } from '../db.ts';
import { iso } from '../dates.ts';

export interface StaffIdpLink {
  id: string;
  institutionId: string;
  subject: string;
  partyId: string;
  linkedAt: string;
}

export interface LinkActor {
  actorId: string;
  actorRole: string;
}

interface LinkRow {
  id: string;
  institution_id: string;
  idp_subject: string;
  party_id: string;
  linked_at: string | Date;
}

const COLUMNS = 'id, institution_id, idp_subject, party_id, linked_at';
const view = (r: LinkRow): StaffIdpLink => ({ id: r.id, institutionId: r.institution_id, subject: r.idp_subject, partyId: r.party_id, linkedAt: iso(r.linked_at) });
// eslint-disable-next-line no-control-regex
const BAD_SUBJECT = /[\u0000-\u001F\u007F]/;

/** The subject comes from an IdP: untrusted text, kept exactly as given and only checked for shape. */
const checkedSubject = (subject: string): string => {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 255 || BAD_SUBJECT.test(subject)) throw new DomainError('VALIDATION_FAILED', 'The IdP subject must be 1 to 255 characters, without control characters');
  return subject;
};

export interface StaffIdpLinksDeps {
  db: Database;
  audit: AuditService;
}

export class StaffIdpLinks {
  private readonly d: StaffIdpLinksDeps;
  constructor(deps: StaffIdpLinksDeps) {
    this.d = deps;
  }

  /** Links `subject` to an active staff member of the institution, once; the same link again returns the existing one. */
  async link(institutionId: string, subject: string, partyId: string, actor: LinkActor, now: Date): Promise<StaffIdpLink> {
    checkedSubject(subject);
    const staff = await this.d.db.query('select 1 from org.staff where party_id = $1 and institution_id = $2 and active', [partyId, institutionId]);
    if (!staff.rowCount) throw new DomainError('NOT_FOUND', 'Not active staff of this institution');
    const id = uuidv7(now);
    const inserted = await this.d.db.query<LinkRow>(`insert into org.staff_idp_link (id, institution_id, idp_subject, party_id, linked_at) values ($1, $2, $3, $4, $5) on conflict do nothing returning ${COLUMNS}`, [id, institutionId, subject, partyId, now]);
    if (inserted.rows[0]) {
      await this.d.audit.record({ actorId: actor.actorId, actorRole: actor.actorRole, action: 'institution.staff.idp_link', subject: partyId, reason: 'Linked a staff member to an IdP identity', payload: { institutionId, linkId: id } }, now);
      return view(inserted.rows[0]);
    }
    // A live row already holds the subject or the party: the same pair is a repeat, anything else a conflict.
    const same = await this.d.db.query<LinkRow>(`select ${COLUMNS} from org.staff_idp_link where institution_id = $1 and idp_subject = $2 and party_id = $3 and unlinked_at is null`, [institutionId, subject, partyId]);
    if (same.rows[0]) return view(same.rows[0]);
    throw new DomainError('IDEMPOTENCY_CONFLICT', 'This IdP subject or staff member is already linked');
  }

  /** The party a live link points to, or undefined. */
  async find(institutionId: string, subject: string): Promise<string | undefined> {
    const r = await this.d.db.query<{ party_id: string }>('select party_id from org.staff_idp_link where institution_id = $1 and idp_subject = $2 and unlinked_at is null', [institutionId, subject]);
    return r.rows[0]?.party_id;
  }

  /** Ends the live link; false when there was none. The row stays. */
  async unlink(institutionId: string, subject: string, actor: LinkActor, now: Date): Promise<boolean> {
    const r = await this.d.db.query<{ id: string; party_id: string }>('update org.staff_idp_link set unlinked_at = $3 where institution_id = $1 and idp_subject = $2 and unlinked_at is null returning id, party_id', [institutionId, subject, now]);
    const row = r.rows[0];
    if (!row) return false;
    await this.d.audit.record({ actorId: actor.actorId, actorRole: actor.actorRole, action: 'institution.staff.idp_unlink', subject: row.party_id, reason: 'Unlinked a staff member from an IdP identity', payload: { institutionId, linkId: row.id } }, now);
    return true;
  }
}
