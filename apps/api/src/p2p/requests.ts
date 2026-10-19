// Payment requests and splits (T-0507, REQ-PAY-004): a member asks another for money, or splits a bill
// so every other participant gets a request for their share. A request is payable for 14 days: paying it
// runs the ordinary send (T-0505: limits, hold, journal, notification) under a key derived from the
// request, so paying twice is one transfer; the payer may decline instead. The worker expires what is
// left after 14 days. Request text is member text: stored and returned verbatim, never interpreted.
import { DomainError, fromWire, money, toWire, uuidv7, type Currency, type Money } from '@kesher/domain';
import type { IdentityRepository } from '../auth/repository.ts';
import type { Database } from '../db.ts';
import type { P2pSendService, TransferView } from './send.ts';

export const REQUEST_TTL_MS = 14 * 24 * 60 * 60_000;
export const NOTE_MAX = 140;
export const MAX_PARTICIPANTS = 20;
export type RequestStatus = 'open' | 'paid' | 'declined' | 'expired' | 'cancelled';

export interface PaymentRequest {
  id: string;
  requesterPartyId: string;
  payerPartyId: string;
  amount: Money;
  /** Untrusted member text. */
  note?: string;
  splitId?: string;
  status: RequestStatus;
  transferId?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

/** The OpenAPI `PaymentRequest`. */
export interface PaymentRequestView {
  id: string;
  requesterPartyId: string;
  payerPartyId: string;
  amount: ReturnType<typeof toWire>;
  note?: string;
  splitId?: string;
  status: RequestStatus;
  transferId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface SplitView {
  id: string;
  total: ReturnType<typeof toWire>;
  /** Each other participant's share; the requester absorbs any rounding remainder. */
  share: ReturnType<typeof toWire>;
  requests: PaymentRequestView[];
}

interface Row {
  id: string;
  idempotency_key: string;
  requester_party_id: string;
  payer_party_id: string;
  amount_minor: string;
  currency: Currency;
  note: string | null;
  split_id: string | null;
  status: RequestStatus;
  transfer_id: string | null;
  created_at: string | Date;
  expires_at: string | Date;
  updated_at: string | Date;
}

/** Equal shares for everyone but the requester, who covers the remainder: ₪200 four ways is three requests of ₪50. */
export function splitShares(total: Money, participants: number): Money {
  if (participants < 2) throw new DomainError('VALIDATION_FAILED', 'A split needs at least one other participant');
  return money(total.minor / BigInt(participants), total.currency);
}

export const payKey = (requestId: string): string => `request:${requestId}:pay`;

export class PaymentRequestService {
  private readonly db: Database;
  private readonly send: P2pSendService;
  private readonly identity: IdentityRepository;
  constructor(
    db: Database,
    send: P2pSendService,
    identity: IdentityRepository,
  ) {
    this.db = db;
    this.send = send;
    this.identity = identity;
  }

  /** POST /requests. Idempotent by key. */
  async create(requesterPartyId: string, body: unknown, key: string, now: Date): Promise<PaymentRequestView> {
    const b = (body ?? {}) as { payerPartyId?: unknown; amount?: unknown; note?: unknown };
    const payer = await this.member(b.payerPartyId, 'payerPartyId');
    if (payer === requesterPartyId) throw new DomainError('VALIDATION_FAILED', 'You cannot request money from yourself');
    const amount = parseAmount(b.amount);
    const note = parseNote(b.note);
    const existing = await this.byKey(key);
    if (existing) {
      if (existing.requesterPartyId !== requesterPartyId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
      return view(existing);
    }
    return view(await this.insert({ key, requester: requesterPartyId, payer, amount, note, now }));
  }

  /** POST /splits: one request per other participant. Idempotent by key (the split id is derived from it). */
  async split(requesterPartyId: string, body: unknown, key: string, now: Date): Promise<SplitView> {
    const b = (body ?? {}) as { total?: unknown; participants?: unknown; note?: unknown };
    const total = parseAmount(b.total);
    if (!Array.isArray(b.participants) || b.participants.length === 0) throw new DomainError('VALIDATION_FAILED', 'participants must list the other members');
    if (b.participants.length > MAX_PARTICIPANTS) throw new DomainError('VALIDATION_FAILED', `At most ${MAX_PARTICIPANTS} participants`);
    const others: string[] = [];
    for (const p of b.participants) {
      const id = await this.member(p, 'participants');
      if (id === requesterPartyId) continue; // the requester's own share is theirs to keep
      if (!others.includes(id)) others.push(id);
    }
    if (others.length === 0) throw new DomainError('VALIDATION_FAILED', 'A split needs at least one other participant');
    const note = parseNote(b.note);
    const share = splitShares(total, others.length + 1);
    if (share.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'The total is too small to split');
    const existing = await this.bySplitKey(key);
    if (existing.length > 0) {
      if (existing[0]!.requesterPartyId !== requesterPartyId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
      return { id: existing[0]!.splitId!, total: toWire(total), share: toWire(existing[0]!.amount), requests: existing.map(view) };
    }
    const splitId = uuidv7(now);
    const requests: PaymentRequest[] = [];
    for (const [i, payer] of others.entries()) requests.push(await this.insert({ key: `${key}:${i}`, requester: requesterPartyId, payer, amount: share, note, now, splitId }));
    return { id: splitId, total: toWire(total), share: toWire(share), requests: requests.map(view) };
  }

  /** GET /requests: what the member owes and what they asked for, open first, newest first. */
  async inbox(partyId: string, now: Date): Promise<{ items: PaymentRequestView[] }> {
    await this.expireDue(now);
    const r = await this.db.query<Row>(
      `select * from ops.payment_request where payer_party_id = $1 or requester_party_id = $1 order by (status = 'open') desc, created_at desc, id desc limit 200`,
      [partyId],
    );
    return { items: r.rows.map(toRequest).map(view) };
  }

  /** POST /requests/{id}/pay: the payer sends the amount through the ordinary send; paying twice is one transfer. */
  async pay(payerPartyId: string, requestId: string, now: Date): Promise<PaymentRequestView & { transfer: TransferView }> {
    const req = await this.mine(requestId, payerPartyId, 'payer');
    if (req.status === 'paid' && req.transferId) {
      const t = await this.send.send(payerPartyId, { toPartyId: req.requesterPartyId, amount: toWire(req.amount) }, payKey(req.id), now);
      return { ...view(req), transfer: t };
    }
    if (req.status !== 'open') throw new DomainError('IDEMPOTENCY_CONFLICT', `This request is ${req.status}`);
    if (Date.parse(req.expiresAt) <= now.getTime()) {
      await this.setStatus(req.id, 'expired', now);
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'This request has expired');
    }
    const transfer = await this.send.send(payerPartyId, { toPartyId: req.requesterPartyId, amount: toWire(req.amount) }, payKey(req.id), now);
    await this.db.query(`update ops.payment_request set status = 'paid', transfer_id = $2, updated_at = $3 where id = $1 and status = 'open'`, [req.id, transfer.id, now]);
    return { ...view((await this.get(req.id))!), transfer };
  }

  /** POST /requests/{id}/decline: the payer says no; the requester sees declined. Idempotent. */
  async decline(payerPartyId: string, requestId: string, now: Date): Promise<PaymentRequestView> {
    const req = await this.mine(requestId, payerPartyId, 'payer');
    if (req.status === 'declined') return view(req);
    if (req.status !== 'open') throw new DomainError('IDEMPOTENCY_CONFLICT', `This request is ${req.status}`);
    await this.setStatus(req.id, 'declined', now);
    return view((await this.get(req.id))!);
  }

  /** POST /requests/{id}/cancel: the requester withdraws an open request. Idempotent. */
  async cancel(requesterPartyId: string, requestId: string, now: Date): Promise<PaymentRequestView> {
    const req = await this.mine(requestId, requesterPartyId, 'requester');
    if (req.status === 'cancelled') return view(req);
    if (req.status !== 'open') throw new DomainError('IDEMPOTENCY_CONFLICT', `This request is ${req.status}`);
    await this.setStatus(req.id, 'cancelled', now);
    return view((await this.get(req.id))!);
  }

  /** Open requests past their 14 days become expired. Returns how many; safe to run any time (the worker's job). */
  async expireDue(now: Date, limit = 500): Promise<number> {
    const r = await this.db.query<{ id: string }>(
      `update ops.payment_request set status = 'expired', updated_at = $1 where id in (select id from ops.payment_request where status = 'open' and expires_at <= $1 order by expires_at limit $2) returning id`,
      [now, limit],
    );
    return r.rows.length;
  }

  async get(id: string): Promise<PaymentRequest | undefined> {
    const r = await this.db.query<Row>('select * from ops.payment_request where id = $1', [id]);
    return r.rows[0] ? toRequest(r.rows[0]) : undefined;
  }

  // ---- internals ----

  private async mine(requestId: string, partyId: string, role: 'payer' | 'requester'): Promise<PaymentRequest> {
    const req = await this.get(requestId);
    if (!req || (role === 'payer' ? req.payerPartyId : req.requesterPartyId) !== partyId) throw new DomainError('NOT_FOUND', 'Request not found');
    return req;
  }

  private async member(v: unknown, field: string): Promise<string> {
    if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new DomainError('VALIDATION_FAILED', `${field} must be a member id`);
    const u = await this.identity.findUser(v);
    if (!u || u.status === 'closed') throw new DomainError('NOT_FOUND', 'Member not found');
    return v;
  }

  private async insert(i: { key: string; requester: string; payer: string; amount: Money; note?: string | undefined; now: Date; splitId?: string }): Promise<PaymentRequest> {
    const id = uuidv7(i.now);
    await this.db.query(
      `insert into ops.payment_request (id, idempotency_key, requester_party_id, payer_party_id, amount_minor, currency, note, split_id, status, created_at, expires_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $9) on conflict (idempotency_key) do nothing`,
      [id, i.key, i.requester, i.payer, i.amount.minor.toString(), i.amount.currency, i.note ?? null, i.splitId ?? null, i.now, new Date(i.now.getTime() + REQUEST_TTL_MS)],
    );
    return (await this.byKey(i.key))!;
  }

  private async byKey(key: string): Promise<PaymentRequest | undefined> {
    const r = await this.db.query<Row>('select * from ops.payment_request where idempotency_key = $1', [key]);
    return r.rows[0] ? toRequest(r.rows[0]) : undefined;
  }

  private async bySplitKey(key: string): Promise<PaymentRequest[]> {
    const r = await this.db.query<Row>(`select * from ops.payment_request where idempotency_key like $1 and split_id is not null order by idempotency_key`, [`${key.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}:%`]);
    return r.rows.map(toRequest);
  }

  private async setStatus(id: string, status: RequestStatus, now: Date): Promise<void> {
    await this.db.query(`update ops.payment_request set status = $2, updated_at = $3 where id = $1`, [id, status, now]);
  }
}

function parseAmount(v: unknown): Money {
  let amount: Money;
  try {
    amount = fromWire(v as { minor: string; currency: string });
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency } in USD or ILS');
  }
  if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
  return amount;
}

function parseNote(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > NOTE_MAX) throw new DomainError('VALIDATION_FAILED', `note must be text of at most ${NOTE_MAX} characters`);
  return v;
}

export function view(r: PaymentRequest): PaymentRequestView {
  return {
    id: r.id,
    requesterPartyId: r.requesterPartyId,
    payerPartyId: r.payerPartyId,
    amount: toWire(r.amount),
    ...(r.note ? { note: r.note } : {}),
    ...(r.splitId ? { splitId: r.splitId } : {}),
    status: r.status,
    ...(r.transferId ? { transferId: r.transferId } : {}),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

function toRequest(r: Row): PaymentRequest {
  return {
    id: r.id,
    requesterPartyId: r.requester_party_id,
    payerPartyId: r.payer_party_id,
    amount: money(BigInt(r.amount_minor), r.currency),
    ...(r.note ? { note: r.note } : {}),
    ...(r.split_id ? { splitId: r.split_id } : {}),
    status: r.status,
    ...(r.transfer_id ? { transferId: r.transfer_id } : {}),
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
