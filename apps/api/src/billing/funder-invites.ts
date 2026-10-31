// Funder invites (T-0306, REQ-BIL-002): a parent pays for a member's membership by inviting them (P04). The funder
// saves a card through the billing vendor's setup sheet first, so the card stays with the vendor on their customer
// and no vendor id is kept here. Then, with an approved T1, they invite the member by phone or email onto the plan
// version offered now, which the invite pins. The link carries an opaque token stored as its hash only. Nothing is
// charged until the member accepts (T-0307); the invite is open for 7 days, and a funder has one open invite per
// contact. Resend rotates the link, so an earlier one stops working; cancel ends the invite.
import { createHash, randomBytes } from 'node:crypto';
import { DomainError, uuidv7 } from '@kesher/domain';
import type { BillingPort, NotifyPort, PaymentSheet } from '@kesher/ports';
import type { FeatureFlags } from './capabilities.ts';
import { isPgError, PG, type Database } from '../db.ts';
import { created, ok, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';
import type { KycService } from '../kyc/service.ts';
import type { MembershipService } from './memberships.ts';
import type { PlanService } from './plans.ts';

export const INVITE_TTL_MS = 7 * 86_400_000;
/** The member app's M04 reads the token from the query (T-0309); institution invites keep `invite?token=`. */
export const JOIN_BASE_URL = 'https://app.kesher.example/join?token=';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

export type InviteStatus = 'open' | 'accepted' | 'expired' | 'cancelled';

export interface FunderInvite {
  id: string;
  memberName: string;
  contactKind: 'phone' | 'email';
  /** The funder's own entry, masked: "•••• 0101" or "d•••@example.com". */
  contact: string;
  planCode: string;
  planVersion: number;
  status: InviteStatus;
  expiresAt: string;
  sentCount: number;
  createdAt: string;
  membershipId?: string;
}

interface Row {
  id: string;
  idempotency_key: string;
  funder_party_id: string;
  member_name: string;
  contact_kind: 'phone' | 'email';
  contact: string;
  plan_code: string;
  plan_version: number;
  status: InviteStatus;
  expires_at: string | Date;
  sent_count: number;
  membership_id: string | null;
  created_at: string | Date;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
const hash = (s: string): string => createHash('sha256').update(s).digest('base64url');
const mask = (kind: 'phone' | 'email', c: string): string => (kind === 'phone' ? `•••• ${c.slice(-4)}` : `${c[0]}•••${c.slice(c.indexOf('@'))}`);
/** An open invite past its 7 days reads expired, whether or not a write has marked it yet. */
const statusAt = (r: Pick<Row, 'status' | 'expires_at'>, now: Date): InviteStatus => (r.status === 'open' && new Date(r.expires_at) <= now ? 'expired' : r.status);
const view = (r: Row, now: Date): FunderInvite => ({
  id: r.id,
  memberName: r.member_name,
  contactKind: r.contact_kind,
  contact: mask(r.contact_kind, r.contact),
  planCode: r.plan_code,
  planVersion: r.plan_version,
  status: statusAt(r, now),
  expiresAt: iso(r.expires_at),
  sentCount: r.sent_count,
  createdAt: iso(r.created_at),
  ...(r.membership_id ? { membershipId: r.membership_id } : {}),
});

/** The billing customer's address when the funder gave none: the vendor needs one, and it is never mailed. */
export const payerEmail = (partyId: string): string => `party:${partyId}@members.kesher.example`;

export interface FunderInviteDeps {
  db: Database;
  plans: PlanService;
  memberships: MembershipService;
  billing: BillingPort;
  kyc: Pick<KycService, 'isApproved'>;
  notify: NotifyPort;
  flags: FeatureFlags;
}

interface InviteInput {
  memberName: string;
  contactKind: 'phone' | 'email';
  contact: string;
  planCode: string;
}

export class FunderInvites {
  private readonly d: FunderInviteDeps;
  constructor(d: FunderInviteDeps) {
    this.d = d;
  }

  /** The vendor's sheet for saving a card on the funder's customer, made on first use. */
  async setupSheet(partyId: string): Promise<PaymentSheet> {
    await this.requireOn();
    const customerId = await this.d.memberships.ensureCustomer(partyId, payerEmail(partyId));
    return this.d.billing.createSetupSheet(customerId, { applePay: !!(await this.d.flags.isOn('billing.applePay', { partyId })), googlePay: !!(await this.d.flags.isOn('billing.googlePay', { partyId })) });
  }

  async create(funderPartyId: string, body: unknown, key: string, now: Date): Promise<FunderInvite> {
    await this.requireOn();
    const input = parse(body);
    const replay = await this.byKey(key);
    if (replay) {
      if (replay.funder_party_id !== funderPartyId || replay.contact !== input.contact || replay.plan_code !== input.planCode) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key sent a different invite');
      return view(replay, now);
    }
    if (!(await this.d.kyc.isApproved(funderPartyId, 'T1'))) throw new DomainError('FORBIDDEN', 'Paying for a membership needs your identity verified first (T1)');
    if (!(await this.d.memberships.customerOf(funderPartyId))) throw new DomainError('VALIDATION_FAILED', 'Save a payment method before inviting someone');
    let version: number;
    try {
      version = (await this.d.plans.current(input.planCode, now)).version;
    } catch (e) {
      if (e instanceof DomainError && e.code === 'NOT_FOUND') throw new DomainError('VALIDATION_FAILED', `${input.planCode} is not offered`);
      throw e;
    }
    // An open invite past its days no longer holds the contact.
    await this.d.db.query(`update billing.funder_invite set status = 'expired' where funder_party_id = $1 and contact = $2 and status = 'open' and expires_at <= $3`, [funderPartyId, input.contact, now]);
    const id = uuidv7(now);
    const token = randomBytes(24).toString('base64url');
    try {
      await this.d.db.query(
        `insert into billing.funder_invite (id, idempotency_key, funder_party_id, member_name, contact_kind, contact, plan_code, plan_version, token_hash, status, expires_at, last_sent_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $11)`,
        [id, key, funderPartyId, input.memberName, input.contactKind, input.contact, input.planCode, version, hash(token), new Date(now.getTime() + INVITE_TTL_MS), now],
      );
    } catch (e) {
      if (!isPgError(e, PG.UNIQUE_VIOLATION)) throw e;
      const raced = await this.byKey(key);
      if (raced) return view(raced, now);
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'You already have an open invite for this contact: resend or cancel it');
    }
    await this.send(id, input, token, 1);
    return view((await this.row(id))!, now);
  }

  /** The funder's own invites, newest first. */
  async list(funderPartyId: string, now: Date): Promise<FunderInvite[]> {
    const r = await this.d.db.query<Row>('select * from billing.funder_invite where funder_party_id = $1 order by created_at desc, id desc limit 100', [funderPartyId]);
    return r.rows.map((x) => view(x, now));
  }

  /** A fresh link to the same contact; the earlier one stops working. The 7 days still count from the first send. */
  async resend(funderPartyId: string, id: string, now: Date): Promise<FunderInvite> {
    await this.requireOn();
    const r = await this.ownOpen(funderPartyId, id, now);
    const token = randomBytes(24).toString('base64url');
    const sent = r.sent_count + 1;
    await this.d.db.query(`update billing.funder_invite set token_hash = $2, sent_count = $3, last_sent_at = $4 where id = $1 and status = 'open'`, [id, hash(token), sent, now]);
    await this.send(id, { memberName: r.member_name, contactKind: r.contact_kind, contact: r.contact, planCode: r.plan_code }, token, sent);
    return view((await this.row(id))!, now);
  }

  async cancel(funderPartyId: string, id: string, now: Date): Promise<FunderInvite> {
    await this.ownOpen(funderPartyId, id, now);
    await this.d.db.query(`update billing.funder_invite set status = 'cancelled', decided_at = $2 where id = $1 and status = 'open'`, [id, now]);
    return view((await this.row(id))!, now);
  }

  private async send(id: string, input: InviteInput, token: string, attempt: number): Promise<void> {
    await this.d.notify.send(
      { channel: input.contactKind === 'phone' ? 'sms' : 'email', to: input.contact, template: 'funder.invite', locale: 'en', data: { memberName: input.memberName, inviteUrl: `${JOIN_BASE_URL}${token}` }, category: 'service' },
      `funder-invite:${id}:${attempt}`,
    );
  }

  /** Another funder's invite, or one that is not there, answers 404 alike; a decided one 409. */
  private async ownOpen(funderPartyId: string, id: string, now: Date): Promise<Row> {
    const r = UUID.test(id) ? await this.row(id) : undefined;
    if (!r || r.funder_party_id !== funderPartyId) throw new DomainError('NOT_FOUND', 'Invite not found');
    const status = statusAt(r, now);
    if (status !== 'open') throw new DomainError('IDEMPOTENCY_CONFLICT', `This invite is ${status}`);
    return r;
  }

  private async requireOn(): Promise<void> {
    if (!(await this.d.flags.isOn('billing.stripe'))) throw new DomainError('FEATURE_OFF', 'Memberships are not on sale yet');
  }

  private async row(id: string): Promise<Row | undefined> {
    return (await this.d.db.query<Row>('select * from billing.funder_invite where id = $1', [id])).rows[0];
  }

  private async byKey(key: string): Promise<Row | undefined> {
    return (await this.d.db.query<Row>('select * from billing.funder_invite where idempotency_key = $1', [key])).rows[0];
  }
}

/** The body, checked in full: a name, exactly one of a phone (E.164) or an email, and a plan code. */
function parse(body: unknown): InviteInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const memberName = typeof b['memberName'] === 'string' ? b['memberName'].trim() : '';
  if (!memberName || memberName.length > 80) throw new DomainError('VALIDATION_FAILED', 'memberName must be 1 to 80 characters');
  const phone = typeof b['phone'] === 'string' ? b['phone'].replace(/[\s()-]/g, '') : undefined;
  const email = typeof b['email'] === 'string' ? b['email'].trim().toLowerCase() : undefined;
  if ((phone === undefined) === (email === undefined)) throw new DomainError('VALIDATION_FAILED', 'Give a phone or an email, not both');
  if (phone !== undefined && !PHONE.test(phone)) throw new DomainError('VALIDATION_FAILED', 'phone must be in international form, like +972501234567');
  if (email !== undefined && !EMAIL.test(email)) throw new DomainError('VALIDATION_FAILED', 'email is not an address');
  const planCode = typeof b['planCode'] === 'string' ? b['planCode'] : '';
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(planCode)) throw new DomainError('VALIDATION_FAILED', 'planCode is not a plan code');
  return { memberName, contactKind: phone !== undefined ? 'phone' : 'email', contact: phone ?? email!, planCode };
}

/** /funder-invites (P04) and the setup sheet that saves the funder's card. */
export function funderInviteHandlers(invites: FunderInvites): Record<string, Handler> {
  return {
    createBillingSetupSheet: route(async (req) => ok(await invites.setupSheet(requirePrincipal(req).partyId))),
    createFunderInvite: route(async (req) => created(await invites.create(requirePrincipal(req).partyId, req.body, requireIdempotencyKey(req), req.now))),
    listFunderInvites: route(async (req) => ok({ items: await invites.list(requirePrincipal(req).partyId, req.now) })),
    resendFunderInvite: route(async (req) => ok(await invites.resend(requirePrincipal(req).partyId, req.params['id'] ?? '', req.now))),
    cancelFunderInvite: route(async (req) => ok(await invites.cancel(requirePrincipal(req).partyId, req.params['id'] ?? '', req.now))),
  };
}
