// Invites and the onboarding funnel (T-0602, REQ-INS-002). One invite per family from a committed
// roster, by email to the funder (SMS fallback when only a phone is known), with an opaque token;
// the console's funnel invited → verified → active is a partition of the roster.
import { createHash, randomBytes } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import type { NotifyPort } from '@kesher/ports';
import { isPgError, PG, type Database } from '../db.ts';

const INVITE_TTL_MS = 30 * 86_400_000;
const INVITE_BASE_URL = 'https://app.kesher.example/invite/';

export interface Funnel {
  invited: number;
  verified: number;
  active: number;
  declined: number;
  total: number;
}

export class InviteService {
  private readonly db: Database;
  private readonly notify: NotifyPort;
  constructor(
    db: Database,
    notify: NotifyPort,
  ) {
    this.db = db;
    this.notify = notify;
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

  async accept(token: string, parties: { funderPartyId: string; memberPartyId: string }, now: Date): Promise<{ memberId: string; status: 'verified' }> {
    const h = hash(token);
    const r = await this.db.query<{ id: string; member_id: string; expires_at: string | Date; status: string }>('select id, member_id, expires_at, status from org.invite where token_hash = $1', [h]);
    const inv = r.rows[0];
    if (!inv || inv.status !== 'sent' || Date.parse(String(new Date(inv.expires_at).toISOString())) <= now.getTime()) throw new DomainError('NOT_FOUND', 'Invite not found or no longer valid');
    await this.db.transaction(async (tx) => {
      await tx.query(`update org.invite set status = 'accepted', accepted_at = $2 where id = $1`, [inv.id, now]);
      await tx.query(`update org.member set status = 'verified', funder_party_id = $2, member_party_id = $3, updated_at = $4 where id = $1`, [inv.member_id, parties.funderPartyId, parties.memberPartyId, now]);
    });
    return { memberId: inv.member_id, status: 'verified' };
  }

  /** Called when the member reaches T2 and a membership is active (member.onboarded event). */
  async activate(memberId: string, now: Date): Promise<void> {
    const r = await this.db.query(`update org.member set status = 'active', updated_at = $2 where id = $1 and status = 'verified'`, [memberId, now]);
    if (r.rowCount === 0) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Member is not in the verified state');
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
