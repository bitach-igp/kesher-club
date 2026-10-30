// Billing fees from I08 (T-0629, REQ-INS-006): the institution's finance staff bill a fee to every active member,
// or a listed few, and each gets one fee item, due on the date given, which they pay from their purse (T-0606).
// One call is one batch, written in one transaction: all of its items or none. The batch keeps the call's
// Idempotency-Key and the body's fingerprint, so a retry answers the batch it made and the same key with another
// body is a conflict. The description is staff-entered text the member sees; it is stored and shown as text.
import { createHash } from 'node:crypto';
import { DomainError, money, toWire, uuidv7, type Currency } from '@kesher/domain';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { isPgError, PG, type Database } from '../db.ts';
import { ok, requireIdempotencyKey, requireRole, route, type Handler } from '../http.ts';
import { COLLECTIONS_FLAG } from './collections.ts';

/** 10,000.00 a member in the institution's currency: above it is a typo, not a fee. */
export const MAX_FEE_MINOR = 1_000_000n;
const DESCRIPTION_MAX = 120;
const COHORT_MAX = 1000;
const DUE_WITHIN_DAYS = 366;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MARKET_CURRENCY: Record<string, Currency> = { IL: 'ILS', US: 'USD' };

interface BillRequest {
  description: string;
  amountMinor: bigint;
  currency: Currency;
  dueDate: string;
  /** Roster member ids; empty for every active member. */
  memberIds: string[];
}

export interface FeeBatchView {
  id: string;
  description: string;
  amount: ReturnType<typeof toWire>;
  dueDate: string;
  memberCount: number;
  total: ReturnType<typeof toWire>;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** The body, checked in full before anything is read: every problem is a 422 naming the field. */
export function parseBill(body: unknown, currency: Currency, today: string): BillRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const description = typeof b['description'] === 'string' ? b['description'].trim() : '';
  if (!description || description.length > DESCRIPTION_MAX) throw new DomainError('VALIDATION_FAILED', `description must be 1 to ${DESCRIPTION_MAX} characters`);
  const amount = (b['amount'] ?? {}) as Record<string, unknown>;
  if (amount['currency'] !== currency) throw new DomainError('VALIDATION_FAILED', `amount must be in ${currency}, the institution's currency`);
  const minor = typeof amount['minor'] === 'string' && /^\d{1,19}$/.test(amount['minor']) ? BigInt(amount['minor']) : undefined;
  if (minor === undefined || minor <= 0n || minor > MAX_FEE_MINOR) throw new DomainError('VALIDATION_FAILED', 'amount must be above zero and at most 10,000.00 a member', { maxMinor: MAX_FEE_MINOR.toString() });
  const dueDate = typeof b['dueDate'] === 'string' ? b['dueDate'] : '';
  // A real calendar day: 2026-02-30 parses to March, so round-trip it.
  const last = isoDate(new Date(Date.parse(`${today}T00:00:00Z`) + DUE_WITHIN_DAYS * 86_400_000));
  if (!DATE.test(dueDate) || isoDate(new Date(`${dueDate}T00:00:00Z`)) !== dueDate || dueDate < today || dueDate > last) {
    throw new DomainError('VALIDATION_FAILED', `dueDate must be a calendar date from ${today} to ${last}`);
  }
  const members = (b['members'] ?? {}) as Record<string, unknown>;
  if (members['kind'] === 'all') return { description, amountMinor: minor, currency, dueDate, memberIds: [] };
  const ids = members['memberIds'];
  if (members['kind'] !== 'listed' || !Array.isArray(ids) || ids.length === 0 || ids.length > COHORT_MAX || !ids.every((x) => typeof x === 'string' && UUID.test(x)) || new Set(ids).size !== ids.length) {
    throw new DomainError('VALIDATION_FAILED', `members must be { kind: all } or { kind: listed, memberIds: 1 to ${COHORT_MAX} distinct member ids }`);
  }
  return { description, amountMinor: minor, currency, dueDate, memberIds: (ids as string[]).map((x) => x.toLowerCase()).sort() };
}

const fingerprint = (r: BillRequest): string => createHash('sha256').update(JSON.stringify([r.description, r.amountMinor.toString(), r.currency, r.dueDate, r.memberIds])).digest('base64url');

interface BatchRow {
  id: string;
  institution_id: string;
  description: string;
  amount_minor: string;
  currency: Currency;
  due_at: string | Date;
  member_count: number;
  request_hash: string;
}

const view = (r: BatchRow): FeeBatchView => {
  const amount = money(BigInt(r.amount_minor), r.currency);
  return { id: r.id, description: r.description, amount: toWire(amount), dueDate: isoDate(new Date(r.due_at)), memberCount: r.member_count, total: toWire(money(amount.minor * BigInt(r.member_count), r.currency)) };
};

export class FeeBilling {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Bills the members of `institutionId` once per key; a retry answers the same batch. */
  async bill(institutionId: string, body: unknown, key: string, by: string, now: Date): Promise<FeeBatchView> {
    const market = (await this.db.query<{ market: string }>('select market from org.institution where id = $1', [institutionId])).rows[0]?.market ?? '';
    const req = parseBill(body, MARKET_CURRENCY[market] ?? 'ILS', isoDate(now));
    const hash = fingerprint(req);
    const earlier = await this.replay(key, institutionId, hash);
    if (earlier) return earlier;
    // Every active member who joined (T-0626), or the listed ones, each of whom must be one.
    const members = await this.db.query<{ id: string; member_party_id: string }>(
      `select id, member_party_id from org.member where institution_id = $1 and status = 'active' and member_party_id is not null and ($2::uuid[] is null or id = any($2::uuid[])) order by row_number nulls last, id`,
      [institutionId, req.memberIds.length ? req.memberIds : null],
    );
    if (req.memberIds.length && members.rows.length !== req.memberIds.length) {
      const found = new Set(members.rows.map((x) => x.id));
      throw new DomainError('VALIDATION_FAILED', 'Every listed member must be an active member of this institution', { notActive: req.memberIds.filter((x) => !found.has(x)) });
    }
    if (members.rows.length === 0) throw new DomainError('VALIDATION_FAILED', 'The institution has no active members to bill');
    const id = uuidv7(now);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `insert into org.fee_batch (id, idempotency_key, institution_id, description, amount_minor, currency, due_at, member_count, request_hash, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [id, key, institutionId, req.description, req.amountMinor.toString(), req.currency, req.dueDate, members.rows.length, hash, by, now],
        );
        for (const m of members.rows) {
          await tx.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at, created_at, batch_id) values ($1, $2, $3, $4, $5, $6, 'due', $7, $8, $9)`, [uuidv7(now), institutionId, m.member_party_id, req.description, req.amountMinor.toString(), req.currency, req.dueDate, now, id]);
        }
      });
    } catch (e) {
      // Two attempts with one key at once: the loser answers what the winner made.
      if (isPgError(e, PG.UNIQUE_VIOLATION)) return (await this.replay(key, institutionId, hash))!;
      throw e;
    }
    return (await this.replay(key, institutionId, hash))!;
  }

  private async replay(key: string, institutionId: string, hash: string): Promise<FeeBatchView | undefined> {
    const r = await this.db.query<BatchRow>('select id, institution_id, description, amount_minor::text, currency, due_at, member_count, request_hash from org.fee_batch where idempotency_key = $1', [key]);
    const prior = r.rows[0];
    if (!prior) return undefined;
    if (prior.request_hash !== hash || prior.institution_id !== institutionId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different bill');
    return view(prior);
  }
}

/** POST /institutions/{id}/fee-items: finance of this institution only; another institution's existence is not confirmed. */
export function feeBillingHandlers(d: { billing: FeeBilling; flags: FeatureFlags; staffInstitution: (partyId: string) => Promise<string | undefined> }): Record<'createFeeItems', Handler> {
  return {
    createFeeItems: route(async (req) => {
      const p = requireRole(req, 'org_finance');
      const key = requireIdempotencyKey(req);
      const institutionId = req.params['id'] ?? '';
      if ((await d.staffInstitution(p.partyId)) !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
      if (!(await d.flags.isOn(COLLECTIONS_FLAG))) throw new DomainError('FEATURE_OFF', 'Institution money is not enabled yet');
      return ok(await d.billing.bill(institutionId, req.body, key, p.partyId, req.now), 201);
    }),
  };
}
