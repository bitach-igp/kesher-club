// Club FX rates (T-0512, REQ-FX-003, REQ-ADM-003, ADR-007): the one published rate per pair that every
// internal conversion prices against, versioned so a quote and a journal can name the version they
// used. A port-sourced rate is published by the worker with a 15-minute validity window; a manual rate
// is proposed by finance, needs a second, distinct finance approver through the approvals service, and
// is valid until superseded. Activation writes an audit entry. Rates are fixed-point integers scaled
// by 1e6 (RATE_SCALE); the inverse pair is derived from the same row, so USD/ILS and ILS/USD never
// disagree. Money never flows through a float here.
import { DomainError, uuidv7, type Currency } from '@kesher/domain';
import { RATE_SCALE } from '@kesher/ports';
import type { ApprovalRequest, ApprovalService, Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { Database, SqlClient } from '../db.ts';

export type RatePair = 'USD/ILS';
export const PAIRS: readonly RatePair[] = ['USD/ILS'];
export type RateSource = 'port' | 'manual';
export type RateStatus = 'proposed' | 'active' | 'superseded' | 'rejected';
/** A port-sourced rate is good for this long; the worker republishes well inside it (REQ-FX-004). */
export const PORT_RATE_TTL_MS = 15 * 60_000;
export const approvalSubject = (rateId: string): string => `fx_rate:${rateId}`;

export interface ClubRate {
  id: string;
  pair: RatePair;
  version: number;
  /** Quote currency per one unit of the base currency × 1e6. */
  midScaled: bigint;
  source: RateSource;
  status: RateStatus;
  validFrom?: string;
  validUntil?: string;
  proposedBy: string;
  reason?: string;
  approvalId?: string;
  createdAt: string;
}

/** What a conversion needs: the rate for the direction asked, and the version it came from. */
export interface AppliedRate {
  rateId: string;
  pair: RatePair;
  version: number;
  /** `to` per one unit of `from` × 1e6, in the direction asked. */
  rateScaled: bigint;
}

interface Row {
  id: string;
  pair: RatePair;
  version: number;
  mid_scaled: string;
  source: RateSource;
  status: RateStatus;
  valid_from: string | Date | null;
  valid_until: string | Date | null;
  approval_id: string | null;
  proposed_by: string;
  reason: string | null;
  created_at: string | Date;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
const toRate = (r: Row): ClubRate => ({
  id: r.id,
  pair: r.pair,
  version: r.version,
  midScaled: BigInt(r.mid_scaled),
  source: r.source,
  status: r.status,
  ...(r.valid_from ? { validFrom: iso(r.valid_from) } : {}),
  ...(r.valid_until ? { validUntil: iso(r.valid_until) } : {}),
  proposedBy: r.proposed_by,
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.approval_id ? { approvalId: r.approval_id } : {}),
  createdAt: iso(r.created_at),
});

/** "3.7" | "3.7000" | "3.700000" → 3_700_000n. Up to six decimals, positive, no exponent. */
export function parseRate(text: string): bigint {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new DomainError('VALIDATION_FAILED', 'rate must be a decimal with at most six places, e.g. 3.7000');
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(6, '0'));
  const scaled = whole * RATE_SCALE + frac;
  if (scaled <= 0n) throw new DomainError('VALIDATION_FAILED', 'rate must be positive');
  return scaled;
}

/** 3_700_000n → "3.700000". */
export function formatRate(scaled: bigint): string {
  return `${scaled / RATE_SCALE}.${(scaled % RATE_SCALE).toString().padStart(6, '0')}`;
}

/** The pair for a direction, and whether the direction is the pair's own (base → quote) or its inverse. */
export function pairFor(from: Currency, to: Currency): { pair: RatePair; inverse: boolean } {
  if (from === 'USD' && to === 'ILS') return { pair: 'USD/ILS', inverse: false };
  if (from === 'ILS' && to === 'USD') return { pair: 'USD/ILS', inverse: true };
  throw new DomainError('VALIDATION_FAILED', `No rate for ${from} to ${to}`);
}

/** The inverse of a fixed-point rate, half-up: 1e12 / mid. */
export const invert = (midScaled: bigint): bigint => {
  const num = RATE_SCALE * RATE_SCALE;
  const q = num / midScaled;
  return (num % midScaled) * 2n >= midScaled ? q + 1n : q;
};

export class RateService {
  private readonly db: Database;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  constructor(
    db: Database,
    approvals: ApprovalService,
    audit: AuditService,
  ) {
    this.db = db;
    this.approvals = approvals;
    this.audit = audit;
  }

  /** The active rate for the pair, if it is valid now; a port rate past its window is not. */
  async current(pair: RatePair, now: Date): Promise<ClubRate | undefined> {
    const r = await this.db.query<Row>(
      `select * from ops.fx_rate where pair = $1 and status = 'active' and (valid_from is null or valid_from <= $2) and (valid_until is null or valid_until > $2)`,
      [pair, now],
    );
    return r.rows[0] ? toRate(r.rows[0]) : undefined;
  }

  /** The rate a conversion from one currency to the other uses now, or PROVIDER_UNAVAILABLE (REQ-FX-004). */
  async rateFor(from: Currency, to: Currency, now: Date): Promise<AppliedRate> {
    const { pair, inverse } = pairFor(from, to);
    const rate = await this.current(pair, now);
    if (!rate) throw new DomainError('PROVIDER_UNAVAILABLE', 'No valid exchange rate is published right now; try again shortly', { pair });
    return { rateId: rate.id, pair, version: rate.version, rateScaled: inverse ? invert(rate.midScaled) : rate.midScaled };
  }

  /** Every version of the pair, newest first. */
  async history(pair: RatePair, limit = 50): Promise<ClubRate[]> {
    const r = await this.db.query<Row>('select * from ops.fx_rate where pair = $1 order by version desc limit $2', [pair, limit]);
    return r.rows.map(toRate);
  }

  async get(id: string): Promise<ClubRate | undefined> {
    const r = await this.db.query<Row>('select * from ops.fx_rate where id = $1', [id]);
    return r.rows[0] ? toRate(r.rows[0]) : undefined;
  }

  /**
   * The worker's path: publish the port's mid as the active rate for the next 15 minutes, superseding
   * the previous port rate. An active manual rate wins: nothing is published while one stands.
   */
  async publishFromPort(pair: RatePair, midScaled: bigint, now: Date): Promise<ClubRate | undefined> {
    if (midScaled <= 0n) throw new DomainError('VALIDATION_FAILED', 'rate must be positive');
    return this.db.transaction(async (tx) => {
      const active = await tx.query<Row>(`select * from ops.fx_rate where pair = $1 and status = 'active' for update`, [pair]);
      if (active.rows[0]?.source === 'manual') return undefined;
      // One active row per pair is a partial unique index: the old one steps down before the new one steps up.
      if (active.rows[0]) await tx.query(`update ops.fx_rate set status = 'superseded', superseded_at = $2 where id = $1`, [active.rows[0].id, now]);
      const row = await this.insert(tx, { pair, midScaled, source: 'port', status: 'active', validFrom: now, validUntil: new Date(now.getTime() + PORT_RATE_TTL_MS), proposedBy: 'worker' }, now);
      await tx.query(`update ops.fx_rate set activated_at = $2 where id = $1`, [row.id, now]);
      return row;
    });
  }

  /**
   * Finance proposes a manual rate. The proposer counts as the first approver; a second, distinct finance
   * approver activates it (REQ-ADM-003). The row sits at `proposed` until then.
   */
  async propose(pair: RatePair, midScaled: bigint, by: Approver & { subject: string }, reason: string, now: Date): Promise<{ rate: ClubRate; approval: ApprovalRequest }> {
    if (!PAIRS.includes(pair)) throw new DomainError('VALIDATION_FAILED', `pair must be one of ${PAIRS.join(', ')}`);
    if (midScaled <= 0n) throw new DomainError('VALIDATION_FAILED', 'rate must be positive');
    if (by.role !== 'finance') throw new DomainError('FORBIDDEN', 'Only finance proposes rates');
    const trimmed = reason.trim();
    if (!trimmed) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
    const rate = await this.db.transaction((tx) => this.insert(tx, { pair, midScaled, source: 'manual', status: 'proposed', proposedBy: by.subject, reason: trimmed }, now));
    const req = await this.approvals.request({ kind: 'fx_rate', subject: approvalSubject(rate.id), scope: 'platform', requestedBy: by, payload: { rateId: rate.id, pair, mid: formatRate(midScaled), reason: trimmed } }, now);
    await this.db.query('update ops.fx_rate set approval_id = $2 where id = $1', [rate.id, req.id]);
    const approval = req.approvals === 0 ? await this.approvals.decide(req.id, by, 'approve', now, trimmed) : req;
    return { rate: { ...rate, approvalId: req.id }, approval };
  }

  /** The second finance approver. Activation supersedes the current rate and writes the audit entry. */
  async approve(rateId: string, by: Approver, now: Date): Promise<{ rate: ClubRate; approval: ApprovalRequest }> {
    const rate = await this.get(rateId);
    if (!rate || rate.source !== 'manual') throw new DomainError('NOT_FOUND', 'Rate proposal not found');
    if (rate.status !== 'proposed') throw new DomainError('IDEMPOTENCY_CONFLICT', `This rate is already ${rate.status}`);
    const req = await this.approvals.find('fx_rate', approvalSubject(rateId));
    if (!req) throw new DomainError('NOT_FOUND', 'Rate proposal not found');
    const approval = await this.approvals.decide(req.id, by, 'approve', now);
    if (approval.status !== 'approved') return { rate, approval };
    const p = approval.payload as { reason?: string };
    return { rate: await this.activate(rate, approval.id, by, p.reason ?? 'approved', now), approval };
  }

  /** Finance withdraws a proposal, or the second approver refuses it. */
  async reject(rateId: string, by: Approver, reason: string, now: Date): Promise<{ rate: ClubRate; approval: ApprovalRequest }> {
    const rate = await this.get(rateId);
    if (!rate || rate.source !== 'manual') throw new DomainError('NOT_FOUND', 'Rate proposal not found');
    if (rate.status !== 'proposed') throw new DomainError('IDEMPOTENCY_CONFLICT', `This rate is already ${rate.status}`);
    const req = await this.approvals.find('fx_rate', approvalSubject(rateId));
    if (!req) throw new DomainError('NOT_FOUND', 'Rate proposal not found');
    const approval = await this.approvals.decide(req.id, by, 'reject', now, reason);
    await this.db.query(`update ops.fx_rate set status = 'rejected' where id = $1 and status = 'proposed'`, [rateId]);
    return { rate: { ...rate, status: 'rejected' }, approval };
  }

  private async activate(rate: ClubRate, approvalId: string, by: Approver, reason: string, now: Date): Promise<ClubRate> {
    if (!(await this.approvals.isApproved('fx_rate', approvalSubject(rate.id)))) throw new DomainError('FORBIDDEN', 'Activation needs an approved request');
    return this.db.transaction(async (tx) => {
      const txDb: Database = { query: tx.query, transaction: async (fn) => fn(tx) };
      const previous = await tx.query<Row>(`select * from ops.fx_rate where pair = $1 and status = 'active' for update`, [rate.pair]);
      const before = previous.rows[0] ? { version: previous.rows[0].version, mid: formatRate(BigInt(previous.rows[0].mid_scaled)), source: previous.rows[0].source } : null;
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'fx_rate.activate', subject: rate.pair, reason, before, after: { version: rate.version, mid: formatRate(rate.midScaled), source: 'manual' }, payload: { approvalId, rateId: rate.id } }, now, txDb);
      if (previous.rows[0]) await tx.query(`update ops.fx_rate set status = 'superseded', superseded_at = $2 where id = $1`, [previous.rows[0].id, now]);
      await tx.query(`update ops.fx_rate set status = 'active', valid_from = $2, activated_at = $2 where id = $1 and status = 'proposed'`, [rate.id, now]);
      return { ...rate, status: 'active', validFrom: now.toISOString() };
    });
  }

  private async insert(tx: SqlClient, input: { pair: RatePair; midScaled: bigint; source: RateSource; status: RateStatus; validFrom?: Date; validUntil?: Date; proposedBy: string; reason?: string }, now: Date): Promise<ClubRate> {
    const next = await tx.query<{ v: number }>('select coalesce(max(version), 0) + 1 as v from ops.fx_rate where pair = $1', [input.pair]);
    const id = uuidv7(now);
    await tx.query(
      `insert into ops.fx_rate (id, pair, version, mid_scaled, source, status, valid_from, valid_until, proposed_by, reason, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, input.pair, next.rows[0]!.v, input.midScaled.toString(), input.source, input.status, input.validFrom ?? null, input.validUntil ?? null, input.proposedBy, input.reason ?? null, now],
    );
    return {
      id,
      pair: input.pair,
      version: next.rows[0]!.v,
      midScaled: input.midScaled,
      source: input.source,
      status: input.status,
      ...(input.validFrom ? { validFrom: input.validFrom.toISOString() } : {}),
      ...(input.validUntil ? { validUntil: input.validUntil.toISOString() } : {}),
      proposedBy: input.proposedBy,
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: now.toISOString(),
    };
  }
}
