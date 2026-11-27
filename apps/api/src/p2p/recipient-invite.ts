// Invite someone to receive (T-1104, REQ-PAY-001 enabling; phase 1 gap 4b). A phone that is not a member answers the same
// 404 to the lookup (T-0530) and to a send, so nobody can probe who is here. The sender who still wants to pay that person
// says so explicitly: this invite. It moves no money and holds none (ADR-018): no journal, hold or transfer is created or
// referenced. It records the sender, the phone's blind index and a sealed copy, an optional amount hint and a category
// from a closed set, lives 14 days (as REQ-PAY-004 requests do), and sends exactly one text.
//
// States, each entered once (history in ops.recipient_invite_event, unique per invite and state):
//   open -> claimable   the invitee joined and passed T1 (the KYC approval hook), or a number that was already a verified
//                        member is found on the sender's next list or claim (the lazy check below)
//   claimable -> claimed the sender took the recipient to the ordinary send: this returns who to pay; the send itself,
//                        its limits, new-pair hold and Idempotency-Key, is POST /transfers and is unchanged
//   open | claimable -> expired   at 14 days; an expired invite cannot be claimed
//
// An invite to a number that already belongs to a verified member answers exactly as any other (same status, same body
// shape, same text), and the sender is told it became claimable the same way. That adds no new probe: POST
// /p2p/recipients/resolve already tells any member whether a number is a member, 30 times a minute, and this route is
// capped at INVITES_PER_DAY new invites per sender. Phone numbers and the sender's words are untrusted: the phone is stored
// sealed and indexed, cleared when the invite ends, and never logged or returned; the category is a closed set; the
// amount hint never travels in the text.
import { DomainError, fromWire, isUuidShape, money, toWire, uuidv7, type Currency, type Money } from '@kesher/domain';
import { NotifyError, type NotifyPort } from '@kesher/ports';
import { assertNotRestricted } from '../auth/recovery.ts';
import type { IdentityRepository } from '../auth/repository.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { PiiCipher } from '../crypto/pii.ts';
import type { Database, SqlClient } from '../db.ts';
import { created, ok, requirePrincipal, route, type Handler } from '../http.ts';
import type { KycService } from '../kyc/service.ts';
import type { DisplayNameService } from '../me/display-name.ts';
import { normalisePhone } from './recipients.ts';

export const INVITE_FLAG = 'phase1.recipientInvite';
export const INVITE_TTL_MS = 14 * 24 * 60 * 60_000;
/** New invites one sender may start in any 24 hours; repeating an open invite does not count. */
export const INVITES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60_000;
const LIST_LIMIT = 100;
/** Most sealed phones one list or claim opens (and so most directory lookups it makes), and the least time before one invite is looked at again. */
export const RECONCILE_PER_CALL = 25;
export const RECONCILE_EVERY_MS = 60_000;
export const INVITE_TEMPLATE = 'p2p.invite';
export const CLAIMABLE_TEMPLATE = 'p2p.invite_claimable';
/** The column the phone is sealed and indexed under (T-0024): the same phone indexes differently in another table. */
const PHONE_COLUMN = 'ops.recipient_invite.phone';

// TODO(T-1101): the recipient categories are the closed set T-1101 defines for the member profile. T-1101 (PR #428) is
// not merged, so the same list is spelled here; unify with the profile's export once it lands.
export const INVITE_CATEGORIES = ['soldier', 'lone_soldier', 'yeshiva_student', 'seminary_student', 'university_student', 'rabbi', 'volunteer', 'program_participant', 'other'] as const;
export type InviteCategory = (typeof INVITE_CATEGORIES)[number];
export type InviteStatus = 'open' | 'claimable' | 'claimed' | 'expired';

/** The OpenAPI `RecipientInvite`. Never the phone. */
export interface RecipientInviteView {
  id: string;
  status: InviteStatus;
  amountHint?: ReturnType<typeof toWire>;
  category?: InviteCategory;
  createdAt: string;
  expiresAt: string;
}

/** The OpenAPI `RecipientInviteClaim`: who to pay through the ordinary send. */
export interface RecipientInviteClaim {
  invite: RecipientInviteView;
  recipient: { partyId: string; displayName?: string; canReceive: boolean };
}

interface Row {
  id: string;
  sender_party_id: string;
  phone_sealed: Uint8Array | null;
  amount_hint_minor: string | null;
  amount_hint_currency: Currency | null;
  category: InviteCategory | null;
  status: InviteStatus;
  recipient_party_id: string | null;
  created_at: string | Date;
  expires_at: string | Date;
  sender_told_at: string | Date | null;
}

interface Deps {
  db: Database;
  pii: PiiCipher;
  identity: Pick<IdentityRepository, 'findUser' | 'findUserByPhone'>;
  kyc: Pick<KycService, 'isApproved' | 'requireApproved'>;
  names: Pick<DisplayNameService, 'get'>;
  notify: NotifyPort;
}

export class RecipientInviteService {
  private readonly d: Deps;
  constructor(d: Deps) {
    this.d = d;
  }

  /**
   * POST /p2p/recipient-invites. A repeat by the same sender for the same number returns the live invite (created: false)
   * and sends no second text. The daily cap counts invites started, and is judged under the sender's lock so two requests
   * at once cannot both pass it.
   */
  async create(senderPartyId: string, body: unknown, now: Date): Promise<{ invite: RecipientInviteView; created: boolean }> {
    const input = parse(body);
    const sender = await this.d.identity.findUser(senderPartyId);
    if (!sender || sender.status === 'closed') throw new DomainError('UNAUTHENTICATED', 'Account unavailable');
    await this.d.kyc.requireApproved(senderPartyId, 'T1');
    if (sender.phone === input.phone) throw new DomainError('VALIDATION_FAILED', 'You cannot invite yourself');
    const index = this.d.pii.index(input.phone, PHONE_COLUMN);
    const { row, fresh } = await this.d.db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('recipient-invite:' || $1::text, 0))`, [senderPartyId]);
      // A live invite past its 14 days ends here, so the same sender can invite the same number afresh.
      for (const stale of (await tx.query<Row>(`select * from ops.recipient_invite where sender_party_id = $1 and phone_index = $2 and status in ('open','claimable') and expires_at <= $3`, [senderPartyId, index, now])).rows) {
        await transition(tx, stale, 'expired', now);
      }
      const live = (await tx.query<Row>(`select * from ops.recipient_invite where sender_party_id = $1 and phone_index = $2 and status in ('open','claimable')`, [senderPartyId, index])).rows[0];
      if (live) return { row: live, fresh: false };
      const recent = await tx.query<{ n: string }>('select count(*) as n from ops.recipient_invite where sender_party_id = $1 and created_at > $2', [senderPartyId, new Date(now.getTime() - DAY_MS)]);
      if (Number(recent.rows[0]!.n) >= INVITES_PER_DAY) throw new DomainError('RATE_LIMITED', 'Too many invites today; try again tomorrow');
      const id = uuidv7(now);
      await tx.query(
        `insert into ops.recipient_invite (id, sender_party_id, phone_index, phone_sealed, amount_hint_minor, amount_hint_currency, category, status, created_at, expires_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $8)`,
        [id, senderPartyId, index, this.d.pii.seal(input.phone, PHONE_COLUMN), input.amountHint?.minor.toString() ?? null, input.amountHint?.currency ?? null, input.category ?? null, now, new Date(now.getTime() + INVITE_TTL_MS)],
      );
      await tx.query(`insert into ops.recipient_invite_event (invite_id, from_status, to_status, actor_party_id, at) values ($1, null, 'open', $2, $3)`, [id, senderPartyId, now]);
      return { row: (await tx.query<Row>('select * from ops.recipient_invite where id = $1', [id])).rows[0]!, fresh: true };
    });
    // The text is idempotent by invite id: a repeat, or a retry after a lost response, never sends a second one.
    if (row.status === 'open') await this.text(row.id, input.phone);
    return { invite: view(row), created: fresh };
  }

  /** GET /p2p/recipient-invites: the sender's invites, newest first, after ending what is past its 14 days and finding who has joined. */
  async list(senderPartyId: string, now: Date): Promise<{ items: RecipientInviteView[] }> {
    await this.expireDue(now, { senderPartyId });
    await this.reconcile(senderPartyId, now);
    const r = await this.d.db.query<Row>('select * from ops.recipient_invite where sender_party_id = $1 order by created_at desc, id desc limit $2', [senderPartyId, LIST_LIMIT]);
    return { items: r.rows.map(view) };
  }

  /**
   * POST /p2p/recipient-invites/{id}/claim: the sender takes a claimable invite to the ordinary send. Answers who to pay;
   * moves nothing. The same sender claiming again gets the same answer; two claims at once are one transition.
   */
  async claim(senderPartyId: string, id: string, now: Date): Promise<RecipientInviteClaim> {
    let row = await this.byId(id);
    if (!row || row.sender_party_id !== senderPartyId) throw new DomainError('NOT_FOUND', 'Invite not found');
    await this.expireDue(now, { senderPartyId });
    row = (await this.byId(id))!;
    if (row.status === 'open') {
      await this.reconcile(senderPartyId, now, row.id);
      row = (await this.byId(id))!;
    }
    if (row.status === 'expired') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This invite has expired');
    if (row.status === 'open') throw new DomainError('IDEMPOTENCY_CONFLICT', 'They have not joined yet');
    const recipient = await this.recipientOf(row);
    if (row.status === 'claimable') {
      if (!recipient.canReceive) throw new DomainError('NOT_FOUND', 'Recipient is not a member');
      const taken = row;
      await this.d.db.transaction((tx) => transition(tx, taken, 'claimed', now, senderPartyId));
      row = (await this.byId(id))!; // whichever claim won, the invite is claimed now and the answer is the same
      if (row.status !== 'claimed') throw new DomainError('IDEMPOTENCY_CONFLICT', `This invite is ${row.status}`);
    }
    return { invite: view(row), recipient };
  }

  /**
   * A KYC approval landed for `partyId` (the kyc webhook): every live invite for their phone becomes claimable and its
   * sender is told. Idempotent: a replayed decision changes nothing and the sender's text is keyed by the invite, so a
   * retry after a failed text sends it once. Returns how many invites moved.
   */
  async onIdentityApproved(partyId: string, now: Date): Promise<number> {
    const user = await this.d.identity.findUser(partyId);
    if (!user || user.status !== 'active' || !(await this.d.kyc.isApproved(partyId, 'T1'))) return 0;
    const rows = await this.d.db.query<Row>(`select * from ops.recipient_invite where phone_index = $1 and status in ('open','claimable') and expires_at > $2 and sender_party_id <> $3 order by created_at, id`, [this.d.pii.index(user.phone, PHONE_COLUMN), now, partyId]);
    let moved = 0;
    // Best effort per invite: this runs inside the KYC webhook, which must acknowledge the invitee's own decision. A failure
    // is logged by invite id (never the phone) and left for the sender's next list or claim, which finds a claimable invite
    // whose sender has not been told (sender_told_at is null) and tells them then, once.
    for (const row of rows.rows) {
      try {
        if (row.status === 'open' && (await this.promote(row, partyId, now))) moved += 1;
        if (!row.sender_told_at) await this.tellSender(row.id, row.sender_party_id, now);
      } catch {
        warn('recipient_invite.hook_failed', row.id);
      }
    }
    return moved;
  }

  /** Live invites past their 14 days become expired (and lose their sealed phone). Returns how many; safe any time. */
  async expireDue(now: Date, opts: { senderPartyId?: string; limit?: number } = {}): Promise<number> {
    const due = await this.d.db.query<Row>(
      `select * from ops.recipient_invite where status in ('open','claimable') and expires_at <= $1 and ($2::uuid is null or sender_party_id = $2::uuid) order by expires_at limit $3`,
      [now, opts.senderPartyId ?? null, opts.limit ?? 500],
    );
    let n = 0;
    for (const row of due.rows) if (await this.d.db.transaction((tx) => transition(tx, row, 'expired', now))) n += 1;
    return n;
  }

  // ---- internals ----

  private async byId(id: string): Promise<Row | undefined> {
    if (!isUuidShape(id)) return undefined;
    return (await this.d.db.query<Row>('select * from ops.recipient_invite where id = $1', [id])).rows[0];
  }

  /**
   * The sender's open invites whose number now belongs to a verified member: the lazy check for a number that was a
   * member before it was invited (no join event will ever come for it). Opens only this sender's sealed phones.
   */
  private async reconcile(senderPartyId: string, now: Date, onlyId?: string): Promise<void> {
    const open = await this.d.db.query<Row>(
      `select * from ops.recipient_invite where sender_party_id = $1 and status = 'open' and phone_sealed is not null and expires_at > $2
          and ($3::uuid is null or id = $3::uuid) and ($3::uuid is not null or reconciled_at is null or reconciled_at <= $4)
        order by coalesce(reconciled_at, created_at), id limit $5`,
      [senderPartyId, now, onlyId ?? null, new Date(now.getTime() - RECONCILE_EVERY_MS), RECONCILE_PER_CALL],
    );
    for (const row of open.rows) {
      const user = await this.d.identity.findUserByPhone(this.d.pii.open(row.phone_sealed!, PHONE_COLUMN));
      if (!user || user.status !== 'active' || user.partyId === senderPartyId || !(await this.d.kyc.isApproved(user.partyId, 'T1'))) {
        await this.d.db.query(`update ops.recipient_invite set reconciled_at = $2 where id = $1 and status = 'open'`, [row.id, now]);
        continue;
      }
      await this.promote(row, user.partyId, now);
    }
    // A sender not yet told (the join hook's notice failed, or the invite was found just now): told here, once, never failing the call.
    const pending = await this.d.db.query<Row>(
      `select * from ops.recipient_invite where sender_party_id = $1 and status = 'claimable' and sender_told_at is null and expires_at > $2 and ($3::uuid is null or id = $3::uuid) order by created_at, id limit $4`,
      [senderPartyId, now, onlyId ?? null, RECONCILE_PER_CALL],
    );
    for (const row of pending.rows) {
      try {
        await this.tellSender(row.id, senderPartyId, now);
      } catch {
        warn('recipient_invite.notice_failed', row.id);
      }
    }
  }

  private promote(row: Row, recipientPartyId: string, now: Date): Promise<boolean> {
    return this.d.db.transaction((tx) => transition(tx, row, 'claimable', now, undefined, recipientPartyId));
  }

  private async recipientOf(row: Row): Promise<RecipientInviteClaim['recipient']> {
    const partyId = row.recipient_party_id!;
    const [user, name, verified] = await Promise.all([this.d.identity.findUser(partyId), this.d.names.get(partyId), this.d.kyc.isApproved(partyId, 'T1')]);
    return { partyId, ...(name.displayName ? { displayName: name.displayName } : {}), canReceive: !!user && user.status === 'active' && verified };
  }

  /** The one text to the invitee. No sender name, note, category or amount: member text is not for an SMS. */
  private async text(inviteId: string, phone: string): Promise<void> {
    try {
      await this.d.notify.send({ channel: 'sms', to: phone, template: INVITE_TEMPLATE, locale: phone.startsWith('+972') ? 'he' : 'en', data: {}, category: 'service' }, `invite:${inviteId}:sms`);
    } catch (e) {
      // The invite stays; the sender asking again finds it and the text goes out under the same key.
      if (e instanceof NotifyError && e.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('PROVIDER_UNAVAILABLE', 'We could not send the text right now; try again');
      throw e;
    }
  }

  /** Tells the sender their invitee has joined. Keyed by the invite: told once however often this runs. */
  private async tellSender(inviteId: string, senderPartyId: string, now: Date): Promise<void> {
    const sender = await this.d.identity.findUser(senderPartyId);
    if (!sender) return;
    await this.d.notify.send({ channel: 'sms', to: sender.phone, template: CLAIMABLE_TEMPLATE, locale: 'en', data: { inviteId }, category: 'service' }, `invite:${inviteId}:claimable`);
    await this.d.db.query('update ops.recipient_invite set sender_told_at = $2 where id = $1 and sender_told_at is null', [inviteId, now]);
  }
}

/** One structured line naming only the event and the invite id: never the phone, a name or the error text. */
function warn(event: string, inviteId: string): void {
  console.warn(JSON.stringify({ level: 'warn', event, inviteId }));
}

/**
 * Moves an invite to `to` from the status it was read in, once: the update is conditional, so of two callers racing for
 * the same step exactly one wins and writes the history row (the table's unique (invite, state) is the backstop). The
 * sealed phone is cleared when the invite ends.
 */
async function transition(tx: SqlClient, row: Row, to: InviteStatus, now: Date, actor?: string, recipientPartyId?: string): Promise<boolean> {
  const r = await tx.query(
    `update ops.recipient_invite set status = $3::text, updated_at = $4, recipient_party_id = coalesce($5::uuid, recipient_party_id),
            phone_sealed = case when $3::text in ('claimed','expired') then null else phone_sealed end
      where id = $1 and status = $2::text returning id`,
    [row.id, row.status, to, now, recipientPartyId ?? null],
  );
  if (r.rows.length === 0) return false;
  await tx.query('insert into ops.recipient_invite_event (invite_id, from_status, to_status, actor_party_id, at) values ($1, $2, $3, $4, $5)', [row.id, row.status, to, actor ?? null, now]);
  return true;
}

interface Parsed {
  phone: string;
  amountHint?: Money;
  category?: InviteCategory;
}

function parse(body: unknown): Parsed {
  const b = (body ?? {}) as { phone?: unknown; amountHint?: unknown; category?: unknown };
  if (typeof b.phone !== 'string') throw new DomainError('VALIDATION_FAILED', 'phone must be in international form, like +972501234567', { field: 'phone' });
  const phone = normalisePhone(b.phone);
  let amountHint: Money | undefined;
  if (b.amountHint !== undefined && b.amountHint !== null) {
    try {
      amountHint = fromWire(b.amountHint as { minor: string; currency: string });
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'amountHint must be { minor, currency } in USD or ILS', { field: 'amountHint' });
    }
    if (amountHint.minor <= 0n || amountHint.minor.toString().length > 15) throw new DomainError('VALIDATION_FAILED', 'amountHint must be a positive amount', { field: 'amountHint' });
  }
  let category: InviteCategory | undefined;
  if (b.category !== undefined && b.category !== null) {
    if (typeof b.category !== 'string' || !(INVITE_CATEGORIES as readonly string[]).includes(b.category)) throw new DomainError('VALIDATION_FAILED', 'category is not one of the known kinds', { field: 'category' });
    category = b.category as InviteCategory;
  }
  return { phone, ...(amountHint ? { amountHint } : {}), ...(category ? { category } : {}) };
}

function view(r: Row): RecipientInviteView {
  return {
    id: r.id,
    status: r.status,
    ...(r.amount_hint_minor !== null && r.amount_hint_currency ? { amountHint: toWire(money(BigInt(r.amount_hint_minor), r.amount_hint_currency)) } : {}),
    ...(r.category ? { category: r.category } : {}),
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}

/**
 * The three invite routes. Each needs the bearer, a sender not in the 24-hour recovery hold (a text costs money and
 * reaches a stranger; list and claim open sealed phones and look numbers up, so the hold covers them too), and both `p2p.enabled` and `phase1.recipientInvite`; none moves money, so none needs a step-up.
 */
export function recipientInviteHandlers(invites: RecipientInviteService, flags: FeatureFlags): Record<string, Handler> {
  const gate = async () => {
    if (!(await flags.isOn('p2p.enabled')) || !(await flags.isOn(INVITE_FLAG))) throw new DomainError('FEATURE_OFF', 'Invites are not enabled yet');
  };
  return {
    createRecipientInvite: route(async (req) => {
      const p = requirePrincipal(req);
      assertNotRestricted(p, 'p2p_send', req.now);
      await gate();
      const r = await invites.create(p.partyId, req.body, req.now);
      return r.created ? created(r.invite) : ok(r.invite);
    }),
    listRecipientInvites: route(async (req) => {
      const p = requirePrincipal(req);
      assertNotRestricted(p, 'p2p_send', req.now);
      await gate();
      return ok(await invites.list(p.partyId, req.now));
    }),
    claimRecipientInvite: route(async (req) => {
      const p = requirePrincipal(req);
      assertNotRestricted(p, 'p2p_send', req.now);
      await gate();
      return ok(await invites.claim(p.partyId, req.params['id'] ?? '', req.now));
    }),
  };
}
