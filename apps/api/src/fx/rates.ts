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
/** A feed mid that moves more than this from the active rate (in basis points; 1,000 = 10%) is refused, not published (T-0546, F44). */
export const MAX_RATE_MOVE_BPS = 1_000n;
/** A manual rate holds for at most this long; past it the feed takes over again (REQ-FX-004). */
export const MANUAL_RATE_MAX_MS = 24 * 60 * 60_000;
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
  activated_at?: string | Date | null;
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
      `select * from ops.fx_rate where pair = $1 and status = 'active' and (valid_from is null or valid_from <= $2)
         and (valid_until > $2 or (valid_until is null and not (source = 'manual' and coalesce(activated_at, valid_from, created_at) + ($3::double precision * interval '1 millisecond') <= $2)))`,
      [pair, now, MANUAL_RATE_MAX_MS],
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
   * the previous rate. An active manual rate wins while it stands (it holds for at most 24 hours; once it
   * has lapsed the feed takes over). A mid that moves more than MAX_RATE_MOVE_BPS from the active rate is
   * REFUSED: the old rate stays (and runs out on its own, which refuses quotes: the safe failure), a case
   * is opened for ops, and the refusal is thrown so the worker reports it.
   */
  async publishFromPort(pair: RatePair, midScaled: bigint, now: Date): Promise<ClubRate | undefined> {
    if (midScaled <= 0n) throw new DomainError('VALIDATION_FAILED', 'rate must be positive');
    const out = await this.db.transaction(async (tx) => {
      const active = await tx.query<Row>(`select * from ops.fx_rate where pair = $1 and status = 'active' for update`, [pair]);
      const cur = active.rows[0];
      // A manual rate stands until it lapses: its valid_until, or (a row active before the cap existed) 24 hours after its activation.
      const manualUntil = cur?.source === 'manual' ? (cur.valid_until ? new Date(cur.valid_until).getTime() : new Date(cur.activated_at ?? cur.valid_from ?? cur.created_at).getTime() + MANUAL_RATE_MAX_MS) : 0;
      if (cur?.source === 'manual' && manualUntil > now.getTime()) return { kind: 'manual' as const };
      if (cur) {
        const old = BigInt(cur.mid_scaled);
        const move = midScaled > old ? midScaled - old : old - midScaled;
        if (move * 10_000n > MAX_RATE_MOVE_BPS * old) return { kind: 'refused' as const, version: cur.version, old };
        // One active row per pair is a partial unique index: the old one steps down before the new one steps up.
        await tx.query(`update ops.fx_rate set status = 'superseded', superseded_at = $2 where id = $1`, [cur.id, now]);
      }
      const row = await this.insert(tx, { pair, midScaled, source: 'port', status: 'active', validFrom: now, validUntil: new Date(now.getTime() + PORT_RATE_TTL_MS), proposedBy: 'worker' }, now);
      await tx.query(`update ops.fx_rate set activated_at = $2 where id = $1`, [row.id, now]);
      return { kind: 'published' as const, row };
    });
    if (out.kind === 'manual') return undefined;
    if (out.kind === 'refused') {
      const movedBps = ((midScaled > out.old ? midScaled - out.old : out.old - midScaled) * 10_000n) / out.old;
      // Outside the transaction (it ended): the case must survive the throw. One case per active rate (a feed that keeps offering wrong values keeps one open case, carrying the latest offer).
      await this.db.query(
        `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'fx_rate_deviation', $2, 'high', 'open', $3, $4) on conflict (dedupe_key) do update set payload = excluded.payload, status = case when ops.case.status in ('resolved', 'dismissed') then 'open' else ops.case.status end`,
        [uuidv7(now), `fx_rate_deviation:${pair}:v${out.version}`, JSON.stringify({ pair, activeVersion: out.version, activeMid: formatRate(out.old), offeredMid: formatRate(midScaled), movedBps: movedBps.toString(), boundBps: MAX_RATE_MOVE_BPS.toString(), summary: `The feed offered ${pair} ${formatRate(midScaled)}, ${movedBps.toString()} bp from the active ${formatRate(out.old)}; refused` }), now],
      );
      throw new DomainError('VALIDATION_FAILED', `The feed rate for ${pair} moved ${movedBps.toString()} bp, more than the ${MAX_RATE_MOVE_BPS.toString()} bp allowed; the active rate is kept`, { pair });
    }
    return out.row;
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
      // A manual rate holds for at most 24 hours; then the feed takes over (REQ-FX-004).
      const until = new Date(now.getTime() + MANUAL_RATE_MAX_MS);
      await tx.query(`update ops.fx_rate set status = 'active', valid_from = $2, valid_until = $3, activated_at = $2 where id = $1 and status = 'proposed'`, [rate.id, now, until]);
      return { ...rate, status: 'active', validFrom: now.toISOString(), validUntil: until.toISOString() };
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
