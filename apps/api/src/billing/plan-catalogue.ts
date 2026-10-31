// Plan versions from the admin API (T-0932, REQ-ADM-006): a version is what a new member joins on, so it takes two
// Kesher finance members, the way add-on price rules do (T-0928). The proposer is the first approver and the version
// waits `proposed`, offered to no one; a second, different finance member approves it and it is offered from its
// effective date, which is audited; either may reject it with a reason, and then it never is. A version is never
// edited: a newer one supersedes it for new members, and a member keeps the version they joined on (PlanService).
// T-0305 (REQ-BIL-001): members list what is offered in their market, the same pick, with none of the staff fields.
import { DomainError, money, toWire, type Currency } from '@kesher/domain';
import { requireStaff } from '../admin/staff-token.ts';
import type { ApprovalRequest, ApprovalService, Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { Database } from '../db.ts';
import { created, ok, requirePrincipal, route, type Handler } from '../http.ts';
import { DEFAULT_FX_MARKUP_BPS, type EntitlementTemplates, type PlanService } from './plans.ts';

export type VersionState = 'proposed' | 'active' | 'rejected';
type Market = 'IL' | 'US';
/** A plan is priced in its market's own currency. */
const MARKET_CURRENCY: Record<Market, Currency> = { IL: 'ILS', US: 'USD' };
const CODE = /^[a-z][a-z0-9-]{1,39}$/;
const ENTITLEMENT_KEY = /^[a-z][a-zA-Z0-9.]{0,63}$/;
const UNITS = new Set(['gb', 'calls', 'minor', 'count']);
const PERIODS = new Set(['month', 'term', 'none']);
/** A price above 100,000.00 a term is a typo, not a plan. */
const MAX_PRICE_MINOR = 10_000_000n;
const MAX_ENTITLEMENTS = 30;
export const approvalSubject = (planCode: string, version: number): string => `plan_version:${planCode}:${version}`;

export interface PlanVersionView {
  planCode: string;
  name: string;
  version: number;
  market?: Market;
  price: ReturnType<typeof toWire>;
  termMonths: number;
  entitlements: EntitlementTemplates;
  fxMarkupBps: number;
  effectiveFrom: string;
  state: VersionState;
  /** The version a new member joins on now: active, in force, and the latest such. */
  offered: boolean;
  proposedBy?: string;
  reason?: string;
  createdAt: string;
  decidedAt?: string;
}

interface Row {
  plan_code: string;
  name: string;
  version: number;
  market: Market | null;
  price_minor: string;
  currency: Currency;
  term_months: number;
  entitlements: EntitlementTemplates;
  fx_markup_bps: number;
  effective_from: string | Date;
  state: VersionState;
  offered: boolean;
  proposed_by: string | null;
  reason: string | null;
  created_at: string | Date;
  decided_at: string | Date | null;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
const view = (r: Row): PlanVersionView => ({
  planCode: r.plan_code,
  name: r.name,
  version: r.version,
  ...(r.market ? { market: r.market } : {}),
  price: toWire(money(BigInt(r.price_minor), r.currency)),
  termMonths: r.term_months,
  entitlements: r.entitlements,
  fxMarkupBps: r.fx_markup_bps,
  effectiveFrom: iso(r.effective_from),
  state: r.state,
  offered: r.offered,
  ...(r.proposed_by ? { proposedBy: r.proposed_by } : {}),
  ...(r.reason ? { reason: r.reason } : {}),
  createdAt: iso(r.created_at),
  ...(r.decided_at ? { decidedAt: iso(r.decided_at) } : {}),
});

// `offered` is worked out the way PlanService.current() picks: the latest active version in force at $1.
const SELECT = `select v.*, p.name,
    (v.state = 'active' and v.effective_from <= $1 and v.version = (select max(w.version) from billing.plan_version w where w.plan_code = v.plan_code and w.state = 'active' and w.effective_from <= $1)) as offered
  from billing.plan_version v join billing.plan p on p.code = v.plan_code`;

/** What a member sees of an offered version (T-0305, REQ-BIL-001): no staff fields. */
export interface OfferedPlan {
  planCode: string;
  name: string;
  version: number;
  market: Market;
  price: ReturnType<typeof toWire>;
  termMonths: number;
  /** The term's price a month, rounded up to the minor unit. */
  monthlyPrice: ReturnType<typeof toWire>;
  entitlements: EntitlementTemplates;
  fxMarkupBps: number;
}

/** A version made before T-0932 names no market; its currency says which one it was priced for. */
const MARKET_OF = `coalesce(v.market, case v.currency when 'ILS' then 'IL' else 'US' end)`;

export interface VersionInput {
  planCode: string;
  name: string;
  market: Market;
  priceMinor: bigint;
  currency: Currency;
  termMonths: number;
  entitlements: EntitlementTemplates;
  fxMarkupBps: bigint;
  effectiveFrom: Date;
  reason: string;
}

/** The body, checked in full: every problem is a 422 naming the field. Without an effective date it is offered on approval. */
export function parseVersion(body: unknown, now: Date): VersionInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new DomainError('VALIDATION_FAILED', msg);
  };
  const planCode = typeof b['planCode'] === 'string' ? b['planCode'] : '';
  if (!CODE.test(planCode)) fail('planCode must be 2 to 40 lower-case letters, digits and dashes, starting with a letter');
  const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
  if (!name || name.length > 80) fail('name must be 1 to 80 characters');
  const market = b['market'] as Market;
  if (market !== 'IL' && market !== 'US') fail('market must be IL or US');
  const price = (b['price'] ?? {}) as Record<string, unknown>;
  if (price['currency'] !== MARKET_CURRENCY[market]) fail(`A ${market} plan is priced in ${MARKET_CURRENCY[market]}`);
  const priceMinor = typeof price['minor'] === 'string' && /^\d{1,19}$/.test(price['minor']) ? BigInt(price['minor']) : 0n;
  if (priceMinor <= 0n || priceMinor > MAX_PRICE_MINOR) fail('price.minor must be above zero and at most 100,000.00');
  const termMonths = b['termMonths'];
  if (typeof termMonths !== 'number' || !Number.isInteger(termMonths) || termMonths < 1 || termMonths > 12) fail('termMonths must be a whole number from 1 to 12');
  const raw = b['entitlements'] ?? {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('entitlements must be an object');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ENTITLEMENTS) fail(`At most ${MAX_ENTITLEMENTS} entitlements`);
  const entitlements: EntitlementTemplates = {};
  for (const [key, v] of entries) {
    const t = (v ?? {}) as Record<string, unknown>;
    if (!ENTITLEMENT_KEY.test(key) || typeof t['limit'] !== 'string' || !/^\d{1,19}$/.test(t['limit']) || !UNITS.has(t['unit'] as string) || !PERIODS.has(t['period'] as string)) {
      fail(`Entitlement ${key.slice(0, 64)} needs a whole-number limit as a string, a unit (gb, calls, minor, count) and a period (month, term, none)`);
    }
    entitlements[key] = { limit: t['limit'] as string, unit: t['unit'] as EntitlementTemplates[string]['unit'], period: t['period'] as EntitlementTemplates[string]['period'] };
  }
  const fx = b['fxMarkupBps'] === undefined ? Number(DEFAULT_FX_MARKUP_BPS) : b['fxMarkupBps'];
  if (typeof fx !== 'number' || !Number.isInteger(fx) || fx < 0 || fx > 10_000) fail('fxMarkupBps must be a whole number from 0 to 10000');
  const effectiveFrom = b['effectiveFrom'] === undefined ? now : new Date(typeof b['effectiveFrom'] === 'string' ? b['effectiveFrom'] : NaN);
  if (Number.isNaN(effectiveFrom.getTime())) fail('effectiveFrom must be a date-time');
  const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
  if (!reason || reason.length > 500) fail('A reason (up to 500 characters) is required');
  return { planCode, name, market, priceMinor, currency: MARKET_CURRENCY[market], termMonths: termMonths as number, entitlements, fxMarkupBps: BigInt(fx as number), effectiveFrom, reason };
}

export class PlanCatalogue {
  private readonly db: Database;
  private readonly plans: PlanService;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  constructor(db: Database, plans: PlanService, approvals: ApprovalService, audit: AuditService) {
    this.db = db;
    this.plans = plans;
    this.approvals = approvals;
    this.audit = audit;
  }

  /** Every version, newest first, each saying whether a new member joins on it now. */
  async list(now: Date): Promise<PlanVersionView[]> {
    const r = await this.db.query<Row>(`${SELECT} order by v.created_at desc, v.plan_code, v.version desc limit 200`, [now]);
    return r.rows.map(view);
  }

  /** The versions a new member of each plan joins on now, in one market, by plan code. */
  async offered(market: Market, now: Date): Promise<OfferedPlan[]> {
    const r = await this.db.query<Row>(`select * from (${SELECT}) v where v.offered and ${MARKET_OF} = $2 order by v.plan_code`, [now, market]);
    return r.rows.map((row) => {
      const v = view(row);
      const months = BigInt(v.termMonths);
      const minor = BigInt(v.price.minor);
      return { planCode: v.planCode, name: v.name, version: v.version, market, price: v.price, termMonths: v.termMonths, monthlyPrice: { minor: ((minor + months - 1n) / months).toString(), currency: v.price.currency }, entitlements: v.entitlements, fxMarkupBps: v.fxMarkupBps };
    });
  }

  async get(planCode: string, version: number, now: Date): Promise<PlanVersionView | undefined> {
    const r = await this.db.query<Row>(`${SELECT} where v.plan_code = $2 and v.version = $3`, [now, planCode, version]);
    return r.rows[0] ? view(r.rows[0]) : undefined;
  }

  /** Finance proposes; the proposer counts as the first approver, and the version waits, offered to no one. */
  async propose(input: VersionInput, by: Approver & { subject: string }, now: Date): Promise<{ version: PlanVersionView; approval: ApprovalRequest }> {
    await this.plans.ensurePlan(input.planCode, input.name);
    const v = await this.plans.createVersion({ planCode: input.planCode, price: money(input.priceMinor, input.currency), termMonths: input.termMonths, entitlements: input.entitlements, fxMarkupBps: input.fxMarkupBps, effectiveFrom: input.effectiveFrom, proposal: { by: by.subject, reason: input.reason, market: input.market } });
    const req = await this.approvals.request({ kind: 'plan_version', subject: approvalSubject(v.planCode, v.version), scope: 'platform', requestedBy: by, amount: v.price, payload: { planCode: v.planCode, version: v.version, market: input.market, termMonths: v.termMonths, reason: input.reason } }, now);
    await this.db.query('update billing.plan_version set approval_id = $3 where plan_code = $1 and version = $2', [v.planCode, v.version, req.id]);
    const approval = req.approvals === 0 ? await this.approvals.decide(req.id, by, 'approve', now, input.reason) : req;
    return { version: (await this.get(v.planCode, v.version, now))!, approval };
  }

  /** The second finance approver; the version is then offered from its effective date, audited. The proposer is refused by the approvals service. */
  async approve(planCode: string, version: number, by: Approver, now: Date): Promise<{ version: PlanVersionView; approval: ApprovalRequest }> {
    const { current, req } = await this.proposal(planCode, version, now);
    const approval = await this.approvals.decide(req.id, by, 'approve', now);
    if (approval.status !== 'approved') return { version: current, approval };
    await this.db.transaction(async (tx) => {
      const txDb: Database = { query: tx.query, transaction: async (fn) => fn(tx) };
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'plan_version.activate', subject: `${planCode}:${version}`, reason: current.reason ?? 'approved', before: null, after: { price: current.price, termMonths: current.termMonths, entitlements: current.entitlements, fxMarkupBps: current.fxMarkupBps, effectiveFrom: current.effectiveFrom }, payload: { approvalId: approval.id } }, now, txDb);
      await tx.query(`update billing.plan_version set state = 'active', decided_at = $3 where plan_code = $1 and version = $2 and state = 'proposed'`, [planCode, version, now]);
    });
    return { version: (await this.get(planCode, version, now))!, approval };
  }

  /** Either finance member withdraws or refuses a proposal, with a reason; it is never offered. */
  async reject(planCode: string, version: number, by: Approver, reason: string, now: Date): Promise<{ version: PlanVersionView; approval: ApprovalRequest }> {
    const { req } = await this.proposal(planCode, version, now);
    const approval = await this.approvals.decide(req.id, by, 'reject', now, reason);
    await this.db.query(`update billing.plan_version set state = 'rejected', decided_at = $3 where plan_code = $1 and version = $2 and state = 'proposed'`, [planCode, version, now]);
    return { version: (await this.get(planCode, version, now))!, approval };
  }

  private async proposal(planCode: string, version: number, now: Date): Promise<{ current: PlanVersionView; req: ApprovalRequest }> {
    const current = await this.get(planCode, version, now);
    if (!current) throw new DomainError('NOT_FOUND', 'Plan version not found');
    if (current.state !== 'proposed') throw new DomainError('IDEMPOTENCY_CONFLICT', `This version is already ${current.state}`);
    const req = await this.approvals.find('plan_version', approvalSubject(planCode, version));
    if (!req) throw new DomainError('NOT_FOUND', 'Plan version not found');
    return { current, req };
  }
}

const approvalBody = (a: ApprovalRequest) => ({ id: a.id, status: a.status, approvals: a.approvals, requestedBy: a.requestedBy });
const body = (r: { version: PlanVersionView; approval: ApprovalRequest }) => ({ ...r.version, approval: approvalBody(r.approval) });

/** A finance approver: the staff principal's party, with the finance role the approvals service checks. */
const financeActor = (req: Parameters<typeof requireStaff>[0]) => {
  const p = requireStaff(req, 'finance');
  return { partyId: p.partyId, role: 'finance', subject: p.subject ?? p.partyId };
};

/** The path's plan code and version, checked before any query. */
function target(params: Record<string, string>): { planCode: string; version: number } {
  const planCode = params['code'] ?? '';
  const version = /^\d{1,6}$/.test(params['version'] ?? '') ? Number(params['version']) : 0;
  if (!CODE.test(planCode) || version < 1) throw new DomainError('NOT_FOUND', 'Plan version not found');
  return { planCode, version };
}

export function planCatalogueHandlers(catalogue: PlanCatalogue): Record<string, Handler> {
  return {
    listPlans: route(async (req) => {
      requirePrincipal(req);
      const market = req.query['market'];
      if (market !== 'IL' && market !== 'US') throw new DomainError('VALIDATION_FAILED', 'market must be IL or US');
      return ok({ items: await catalogue.offered(market, req.now) });
    }),
    listAdminPlans: route(async (req) => {
      requireStaff(req);
      return ok({ items: await catalogue.list(req.now) });
    }),
    proposeAdminPlanVersion: route(async (req) => {
      const by = financeActor(req);
      return created(body(await catalogue.propose(parseVersion(req.body, req.now), by, req.now)));
    }),
    approveAdminPlanVersion: route(async (req) => {
      const by = financeActor(req);
      const t = target(req.params);
      return ok(body(await catalogue.approve(t.planCode, t.version, by, req.now)));
    }),
    rejectAdminPlanVersion: route(async (req) => {
      const by = financeActor(req);
      const t = target(req.params);
      const b = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
      if (!reason) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
      return ok(body(await catalogue.reject(t.planCode, t.version, by, reason, req.now)));
    }),
  };
}
