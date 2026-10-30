// Add-on price rules from the admin API (T-0928, REQ-MKT-002, REQ-ADM-003): prices come only from rules, and a
// rule takes two Kesher finance members. The proposer is the first approver and the row waits inactive; a second,
// different finance member activates it, which is audited, or either rejects it with a reason. The next catalogue
// sync prices with the active rules (T-0702); nothing reprices on approval. Rules are never deleted or edited:
// a new rule with a lower priority number wins over an old one.
import { DomainError, money, toWire, uuidv7, type Currency } from '@kesher/domain';
import { requireStaff } from '../admin/staff-token.ts';
import type { ApprovalRequest, ApprovalService, Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { Database } from '../db.ts';
import { created, ok, route, type Handler } from '../http.ts';

export type RuleKind = 'esim' | 'insurance' | 'concierge';
export type RuleState = 'proposed' | 'active' | 'rejected';
const KINDS: readonly RuleKind[] = ['esim', 'insurance', 'concierge'];
const CURRENCIES: readonly Currency[] = ['USD', 'ILS'];
const MAX_MARGIN_BPS = 20_000;
/** A floor above 10,000.00 is a typo, not a price. */
const MAX_FLOOR_MINOR = 1_000_000n;
const PATTERN_MAX = 120;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const approvalSubject = (ruleId: string): string => `price_rule:${ruleId}`;

export interface PriceRuleView {
  id: string;
  kind: RuleKind;
  provider: string;
  skuPattern: string;
  marginBps: number;
  floor: ReturnType<typeof toWire>;
  roundTo99: boolean;
  priority: number;
  state: RuleState;
  proposedBy?: string;
  reason?: string;
  createdAt: string;
  activatedAt?: string;
}

interface Row {
  id: string;
  kind: RuleKind;
  provider: string;
  sku_pattern: string;
  margin_bps: number;
  floor_minor: string;
  currency: Currency;
  round_to_99: boolean;
  priority: number;
  active: boolean;
  proposed_by: string | null;
  reason: string | null;
  rejected_at: string | Date | null;
  activated_at: string | Date | null;
  created_at: string | Date;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
const view = (r: Row): PriceRuleView => ({
  id: r.id,
  kind: r.kind,
  provider: r.provider,
  skuPattern: r.sku_pattern,
  marginBps: r.margin_bps,
  floor: toWire(money(BigInt(r.floor_minor), r.currency)),
  roundTo99: r.round_to_99,
  priority: r.priority,
  state: r.active ? 'active' : r.rejected_at ? 'rejected' : 'proposed',
  ...(r.proposed_by ? { proposedBy: r.proposed_by } : {}),
  ...(r.reason ? { reason: r.reason } : {}),
  createdAt: iso(r.created_at),
  ...(r.activated_at ? { activatedAt: iso(r.activated_at) } : {}),
});

export interface RuleInput {
  kind: RuleKind;
  provider: string;
  skuPattern: string;
  marginBps: number;
  floorMinor: bigint;
  currency: Currency;
  roundTo99: boolean;
  priority: number;
  reason: string;
}

/** The body, checked in full: every problem is a 422 naming the field. The pattern must compile as written. */
export function parseRule(body: unknown): RuleInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new DomainError('VALIDATION_FAILED', msg);
  };
  const kind = b['kind'] as RuleKind;
  if (!KINDS.includes(kind)) fail(`kind must be one of ${KINDS.join(', ')}`);
  const provider = typeof b['provider'] === 'string' ? b['provider'] : '';
  if (!PROVIDER.test(provider)) fail('provider must be a provider key: lower-case letters, digits and dashes');
  const skuPattern = typeof b['skuPattern'] === 'string' && b['skuPattern'] !== '' ? b['skuPattern'] : '.*';
  if (skuPattern.length > PATTERN_MAX) fail(`skuPattern must be at most ${PATTERN_MAX} characters`);
  try {
    new RegExp(skuPattern);
  } catch {
    fail('skuPattern must be a valid regular expression');
  }
  const marginBps = b['marginBps'];
  if (typeof marginBps !== 'number' || !Number.isInteger(marginBps) || marginBps < 0 || marginBps > MAX_MARGIN_BPS) fail(`marginBps must be a whole number from 0 to ${MAX_MARGIN_BPS}`);
  const floor = (b['floor'] ?? {}) as Record<string, unknown>;
  const currency = floor['currency'] as Currency;
  if (!CURRENCIES.includes(currency)) fail('floor.currency must be USD or ILS');
  const floorMinor = typeof floor['minor'] === 'string' && /^\d{1,19}$/.test(floor['minor']) ? BigInt(floor['minor']) : -1n;
  if (floorMinor < 0n || floorMinor > MAX_FLOOR_MINOR) fail('floor.minor must be from 0 to 10,000.00');
  const roundTo99 = b['roundTo99'] === undefined ? true : b['roundTo99'];
  if (typeof roundTo99 !== 'boolean') fail('roundTo99 must be true or false');
  const priority = b['priority'] === undefined ? 100 : b['priority'];
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 1000) fail('priority must be a whole number from 1 to 1000');
  const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
  if (!reason || reason.length > 500) fail('A reason (up to 500 characters) is required');
  return { kind, provider, skuPattern, marginBps: marginBps as number, floorMinor, currency, roundTo99: roundTo99 as boolean, priority: priority as number, reason };
}

export class PriceRules {
  private readonly db: Database;
  private readonly approvals: ApprovalService;
  private readonly audit: AuditService;
  constructor(db: Database, approvals: ApprovalService, audit: AuditService) {
    this.db = db;
    this.approvals = approvals;
    this.audit = audit;
  }

  async list(): Promise<PriceRuleView[]> {
    const r = await this.db.query<Row>('select * from addons.price_rule order by created_at desc, id desc limit 200');
    return r.rows.map(view);
  }

  async get(id: string): Promise<PriceRuleView | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const r = await this.db.query<Row>('select * from addons.price_rule where id = $1', [id]);
    return r.rows[0] ? view(r.rows[0]) : undefined;
  }

  /** Finance proposes; the proposer counts as the first approver, and the rule waits inactive for a second. */
  async propose(input: RuleInput, by: Approver & { subject: string }, now: Date): Promise<{ rule: PriceRuleView; approval: ApprovalRequest }> {
    const id = uuidv7(now);
    await this.db.query(
      `insert into addons.price_rule (id, kind, provider, sku_pattern, margin_bps, floor_minor, currency, round_to_99, priority, active, proposed_by, reason, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11, $12)`,
      [id, input.kind, input.provider, input.skuPattern, input.marginBps, input.floorMinor.toString(), input.currency, input.roundTo99, input.priority, by.subject, input.reason, now],
    );
    const req = await this.approvals.request({ kind: 'price_rule', subject: approvalSubject(id), scope: 'platform', requestedBy: by, payload: { ruleId: id, kind: input.kind, provider: input.provider, skuPattern: input.skuPattern, marginBps: input.marginBps, reason: input.reason } }, now);
    await this.db.query('update addons.price_rule set approval_id = $2 where id = $1', [id, req.id]);
    const approval = req.approvals === 0 ? await this.approvals.decide(req.id, by, 'approve', now, input.reason) : req;
    return { rule: (await this.get(id))!, approval };
  }

  /** The second finance approver; activation is audited. The proposer approving again is refused by the approvals service. */
  async approve(id: string, by: Approver, now: Date): Promise<{ rule: PriceRuleView; approval: ApprovalRequest }> {
    const { rule, req } = await this.proposal(id);
    const approval = await this.approvals.decide(req.id, by, 'approve', now);
    if (approval.status !== 'approved') return { rule, approval };
    await this.db.transaction(async (tx) => {
      const txDb: Database = { query: tx.query, transaction: async (fn) => fn(tx) };
      await this.audit.record({ actorId: by.partyId, actorRole: by.role, action: 'price_rule.activate', subject: `${rule.kind}:${rule.provider}`, reason: rule.reason ?? 'approved', before: null, after: { skuPattern: rule.skuPattern, marginBps: rule.marginBps, floor: rule.floor, roundTo99: rule.roundTo99, priority: rule.priority }, payload: { approvalId: approval.id, ruleId: rule.id } }, now, txDb);
      await tx.query('update addons.price_rule set active = true, activated_at = $2 where id = $1 and not active and rejected_at is null', [id, now]);
    });
    return { rule: (await this.get(id))!, approval };
  }

  /** Either finance member withdraws or refuses a proposal, with a reason; it never activates. */
  async reject(id: string, by: Approver, reason: string, now: Date): Promise<{ rule: PriceRuleView; approval: ApprovalRequest }> {
    const { req } = await this.proposal(id);
    const approval = await this.approvals.decide(req.id, by, 'reject', now, reason);
    await this.db.query('update addons.price_rule set rejected_at = $2 where id = $1 and not active and rejected_at is null', [id, now]);
    return { rule: (await this.get(id))!, approval };
  }

  private async proposal(id: string): Promise<{ rule: PriceRuleView; req: ApprovalRequest }> {
    const rule = await this.get(id);
    if (!rule) throw new DomainError('NOT_FOUND', 'Price rule not found');
    if (rule.state !== 'proposed') throw new DomainError('IDEMPOTENCY_CONFLICT', `This rule is already ${rule.state}`);
    const req = await this.approvals.find('price_rule', approvalSubject(id));
    if (!req) throw new DomainError('NOT_FOUND', 'Price rule not found');
    return { rule, req };
  }
}

const approvalBody = (a: ApprovalRequest) => ({ id: a.id, status: a.status, approvals: a.approvals, requestedBy: a.requestedBy });
const body = (r: { rule: PriceRuleView; approval: ApprovalRequest }) => ({ ...r.rule, approval: approvalBody(r.approval) });

/** A finance approver: the staff principal's party, with the finance role the approvals service checks. */
const financeActor = (req: Parameters<typeof requireStaff>[0]) => {
  const p = requireStaff(req, 'finance');
  return { partyId: p.partyId, role: 'finance', subject: p.subject ?? p.partyId };
};

export function priceRuleHandlers(rules: PriceRules): Record<string, Handler> {
  return {
    listAdminPriceRules: route(async (req) => {
      requireStaff(req);
      return ok({ items: await rules.list() });
    }),
    proposeAdminPriceRule: route(async (req) => {
      const by = financeActor(req);
      return created(body(await rules.propose(parseRule(req.body), by, req.now)));
    }),
    approveAdminPriceRule: route(async (req) => ok(body(await rules.approve(req.params['id'] ?? '', financeActor(req), req.now)))),
    rejectAdminPriceRule: route(async (req) => {
      const by = financeActor(req);
      const b = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
      if (!reason) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
      return ok(body(await rules.reject(req.params['id'] ?? '', by, reason, req.now)));
    }),
  };
}
