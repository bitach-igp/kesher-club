// Invites and the onboarding funnel (T-0602, REQ-INS-002). One invite per family from a committed
// roster, by email to the funder (SMS fallback when only a phone is known), with an opaque token;
// the console's funnel invited → verified → active is a partition of the roster.
//
// The student opens the link, previews it and accepts it signed in (T-0626): their party becomes the
// roster member's, verified at once and active once their identity is approved at T1 or above, which is
// what receiving an allowance needs. Linking a funder is the memberships' job, not the invite's.
import { createHash, randomBytes } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import type { KycTier, NotifyPort } from '@kesher/ports';
import { isPgError, PG, type Database } from '../db.ts';
import { ok, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';

const INVITE_TTL_MS = 30 * 86_400_000;
/** The member app's invite screen (M04) reads the token from the query (T-0626). */
const INVITE_BASE_URL = 'https://app.kesher.example/invite?token=';

export interface Funnel {
  invited: number;
  verified: number;
  active: number;
  declined: number;
  total: number;
}

export interface InvitePreview {
  institutionName: string;
  memberName: string;
  programme?: string;
  status: 'open' | 'expired' | 'accepted';
}

export interface InviteAcceptance {
  memberId: string;
  status: 'verified' | 'active';
}

/** The one question activation asks of KYC. */
export interface IdentityCheck {
  isApproved(partyId: string, tier: KycTier): Promise<boolean>;
}

/** Receiving money needs T1 (REQ-PAY-001), so that is what an active roster member needs too. */
const ACTIVE_TIER: KycTier = 'T1';

interface InviteRow {
  id: string;
  member_id: string;
  institution_id: string;
  invite_status: string;
  expires_at: string | Date;
  member_status: string;
  member_party_id: string | null;
  member_name: string;
  programme: string | null;
  institution_name: string;
}

export class InviteService {
  private readonly db: Database;
  private readonly notify: NotifyPort;
  private readonly identity: IdentityCheck;
  constructor(
    db: Database,
    notify: NotifyPort,
    identity: IdentityCheck,
  ) {
    this.db = db;
    this.notify = notify;
    this.identity = identity;
  }

  /** Sends an invite for every member of the import that has none yet. */
  async fanOut(importId: string, now: Date): Promise<{ sent: number; skipped: number }> {
    const rows = await this.db.query<{ id: string; member_name: string; funder_email: string | null; funder_phone: string | null; invited: boolean }>(
      `select m.id, m.member_name, r.funder_email, r.funder_phone, exists (select 1 from org.invite i where i.member_id = m.id) as invited
         from org.member m join org.roster_row r on r.import_id = m.import_id and r.row_number = m.row_number
        where m.import_id = $1 order by m.row_number`,
      [importId],
    );
    let sent = 0;
    let skipped = 0;
    for (const r of rows.rows) {
      if (r.invited) {
        skipped += 1;
        continue;
      }
      const channel = r.funder_email ? 'email' : r.funder_phone ? 'sms' : undefined;
      const to = r.funder_email ?? r.funder_phone;
      if (!channel || !to) {
        skipped += 1;
        continue;
      }
      await this.send(r.id, channel, to, r.member_name, 'institution.invite', now);
      sent += 1;
    }
    return { sent, skipped };
  }

  /** What the link shows before sign-in. Only an unknown token is a 404: a used or superseded link says so. */
  async preview(token: string, now: Date): Promise<InvitePreview> {
    const inv = await this.find(token);
    if (!inv) throw new DomainError('NOT_FOUND', 'Invite not found');
    const status = inv.invite_status === 'accepted' ? 'accepted' : this.isOpen(inv, now) ? 'open' : 'expired';
    return { institutionName: inv.institution_name, memberName: inv.member_name, ...(inv.programme ? { programme: inv.programme } : {}), status };
  }

  /**
   * The signed-in student takes the roster row. The same member accepting again gets the same answer (a retry
   * after a lost response); anyone else finds a used invite gone. A member already on this institution's roster
   * may not take a second row.
   */
  async accept(token: string, parties: { memberPartyId: string; funderPartyId?: string | undefined }, now: Date): Promise<InviteAcceptance> {
    const inv = await this.find(token);
    if (inv?.invite_status === 'accepted' && inv.member_party_id === parties.memberPartyId) return this.promote(inv.member_id, parties.memberPartyId, now);
    if (!inv || !this.isOpen(inv, now)) throw new DomainError('NOT_FOUND', 'Invite not found or no longer valid');
    const other = await this.db.query('select 1 from org.member where institution_id = $1 and member_party_id = $2 and id <> $3 and status <> $4', [inv.institution_id, parties.memberPartyId, inv.member_id, 'removed']);
    if (other.rows.length > 0) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Already on this institution\'s roster');
    const taken = await this.db.transaction(async (tx) => {
      // Two accepts racing for one link: the conditional updates let exactly one through.
      const i = await tx.query(`update org.invite set status = 'accepted', accepted_at = $2 where id = $1 and status in ('sent', 'opened')`, [inv.id, now]);
      if (i.rowCount === 0) return false;
      const m = await tx.query(`update org.member set status = 'verified', funder_party_id = coalesce($2, funder_party_id), member_party_id = $3, updated_at = $4 where id = $1 and status = 'invited'`, [inv.member_id, parties.funderPartyId ?? null, parties.memberPartyId, now]);
      if (m.rowCount === 0) throw new DomainError('NOT_FOUND', 'Invite not found or no longer valid');
      return true;
    });
    if (!taken) throw new DomainError('NOT_FOUND', 'Invite not found or no longer valid');
    return this.promote(inv.member_id, parties.memberPartyId, now);
  }

  /**
   * A KYC approval landed for the party (the kyc webhook): every roster row they accepted becomes active.
   * Idempotent, so a replayed decision changes nothing. Returns how many rows moved.
   */
  async onIdentityApproved(partyId: string, now: Date): Promise<number> {
    const r = await this.db.query(`update org.member set status = 'active', updated_at = $2 where member_party_id = $1 and status = 'verified'`, [partyId, now]);
    return r.rowCount ?? 0;
  }

  /** Verified → active when the member's identity already passed; otherwise it waits for the approval. */
  private async promote(memberId: string, partyId: string, now: Date): Promise<InviteAcceptance> {
    if (await this.identity.isApproved(partyId, ACTIVE_TIER)) {
      await this.db.query(`update org.member set status = 'active', updated_at = $2 where id = $1 and status = 'verified'`, [memberId, now]);
    }
    const r = await this.db.query<{ status: 'verified' | 'active' }>('select status from org.member where id = $1', [memberId]);
    return { memberId, status: r.rows[0]!.status };
  }

  private async find(token: string): Promise<InviteRow | undefined> {
    const r = await this.db.query<InviteRow>(
      `select i.id, i.member_id, m.institution_id, i.status as invite_status, i.expires_at, m.status as member_status, m.member_party_id, m.member_name, m.programme, o.name as institution_name
         from org.invite i join org.member m on m.id = i.member_id join org.institution o on o.id = m.institution_id
        where i.token_hash = $1`,
      [hash(token)],
    );
    return r.rows[0];
  }

  private isOpen(inv: InviteRow, now: Date): boolean {
    return (inv.invite_status === 'sent' || inv.invite_status === 'opened') && inv.member_status === 'invited' && new Date(inv.expires_at).getTime() > now.getTime();
  }

  async funnel(institutionId: string): Promise<Funnel> {
    const r = await this.db.query<{ status: string; n: number }>(`select status, count(*)::int as n from org.member where institution_id = $1 and status <> 'removed' group by status`, [institutionId]);
    const by = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
    const f = { invited: by['invited'] ?? 0, verified: by['verified'] ?? 0, active: by['active'] ?? 0, declined: by['declined'] ?? 0 };
    return { ...f, total: f.invited + f.verified + f.active + f.declined };
  }

  /** Re-sends to families still invited (fresh token, old one expires). */
  async remind(institutionId: string, now: Date): Promise<{ sent: number }> {
    const rows = await this.db.query<{ id: string; member_name: string; funder_email: string | null; funder_phone: string | null }>(
      `select m.id, m.member_name, r.funder_email, r.funder_phone from org.member m
         join org.roster_row r on r.import_id = m.import_id and r.row_number = m.row_number
        where m.institution_id = $1 and m.status = 'invited'`,
      [institutionId],
    );
    let sent = 0;
    for (const r of rows.rows) {
      const to = r.funder_email ?? r.funder_phone;
      if (!to) continue;
      await this.db.query(`update org.invite set status = 'expired' where member_id = $1 and status = 'sent'`, [r.id]);
      await this.send(r.id, r.funder_email ? 'email' : 'sms', to, r.member_name, 'institution.invite_reminder', now);
      sent += 1;
    }
    return { sent };
  }

  private async send(memberId: string, channel: 'email' | 'sms', to: string, memberName: string, template: string, now: Date): Promise<void> {
    const token = randomBytes(24).toString('base64url');
    const key = `invite:${memberId}:${template}:${now.getTime()}`;
    try {
      await this.db.query(`insert into org.invite (id, idempotency_key, member_id, channel, recipient_hash, token_hash, status, sent_at, expires_at) values ($1, $2, $3, $4, $5, $6, 'sent', $7, $8)`, [uuidv7(now), key, memberId, channel, hash(to.toLowerCase()), hash(token), now, new Date(now.getTime() + INVITE_TTL_MS)]);
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) return;
      throw e;
    }
    await this.notify.send({ channel, to, template, locale: 'en', data: { memberName, inviteUrl: `${INVITE_BASE_URL}${token}` }, category: 'service' }, key);
  }
}

const hash = (s: string): string => createHash('sha256').update(s).digest('base64url');

/** The invite link's two operations (REQ-INS-002): a public preview, and the signed-in accept. */
export function inviteHandlers(invites: InviteService): Record<string, Handler> {
  return {
    getInvite: route(async (req) => ok(await invites.preview(req.params['token'] ?? '', req.now))),
    acceptInvite: route(async (req) => {
      const p = requirePrincipal(req);
      requireIdempotencyKey(req);
      return ok(await invites.accept(req.params['token'] ?? '', { memberPartyId: p.partyId }, req.now));
    }),
  };
}
