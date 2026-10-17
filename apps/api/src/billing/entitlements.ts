// Entitlements (T-0302): can() answers "may this member use N units of key now?" from the plan
// version's template and the usage row for the current period; consume() records usage
// idempotently so a retried checkout never double-spends a credit (REQ-ESIM-002 relies on it).
import { DomainError } from '@kesher/domain';
import type { Database, SqlClient } from '../db.ts';
import type { EntitlementTemplate, PlanService } from './plans.ts';

export interface Decision {
  allowed: boolean;
  remaining: bigint;
  limit: bigint;
  unit: EntitlementTemplate['unit'];
  resetsAt?: string;
}

export interface MembershipRef {
  id: string;
  planCode: string;
  planVersion: number;
  status: 'incomplete' | 'active' | 'past_due' | 'paused' | 'cancelled';
  createdAt: string;
  termMonths: number;
}

/** First day of the period that contains `at`, as an ISO date. */
export function periodStart(period: EntitlementTemplate['period'], at: Date, membershipStart: Date): string {
  if (period === 'month') return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
  if (period === 'term') return membershipStart.toISOString().slice(0, 10);
  return '1970-01-01';
}

export function periodEnd(period: EntitlementTemplate['period'], at: Date, membershipStart: Date, termMonths: number): string | undefined {
  if (period === 'month') return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
  if (period === 'term') {
    const d = new Date(membershipStart);
    d.setUTCMonth(d.getUTCMonth() + termMonths);
    return d.toISOString();
  }
  return undefined;
}

export class EntitlementService {
  constructor(
    private readonly db: Database,
    private readonly plans: PlanService,
  ) {}

  async can(m: MembershipRef, key: string, amount: bigint, at: Date, db: SqlClient = this.db): Promise<Decision> {
    const plan = await this.plans.get(m.planCode, m.planVersion, db);
    const t = plan?.entitlements[key];
    if (!plan || !t) return { allowed: false, remaining: 0n, limit: 0n, unit: 'count' };
    if (m.status !== 'active') return { allowed: false, remaining: 0n, limit: BigInt(t.limit), unit: t.unit, ...(resets(t, at, m)) };
    const start = periodStart(t.period, at, new Date(m.createdAt));
    const used = await db.query<{ used: string }>('select used::text as used from billing.entitlement_usage where membership_id = $1 and key = $2 and period_start = $3', [m.id, key, start]);
    const limit = BigInt(t.limit);
    const remaining = limit - BigInt(used.rows[0]?.used ?? '0');
    return { allowed: amount <= remaining, remaining: remaining < 0n ? 0n : remaining, limit, unit: t.unit, ...resets(t, at, m) };
  }

  /** Records usage; the same idempotency key is a no-op. Throws LIMIT_EXCEEDED when it would overspend. */
  async consume(m: MembershipRef, key: string, amount: bigint, idempotencyKey: string, at: Date): Promise<Decision> {
    if (amount <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
    return this.db.transaction(async (tx) => {
      const prior = await tx.query('select 1 from billing.entitlement_consumption where idempotency_key = $1', [idempotencyKey]);
      if (prior.rowCount > 0) return this.can(m, key, 0n, at, tx);
      const decision = await this.can(m, key, amount, at, tx);
      if (!decision.allowed) throw new DomainError('LIMIT_EXCEEDED', `Only ${decision.remaining} ${decision.unit} of ${key} left this period`, { remaining: decision.remaining.toString(), key });
      const plan = (await this.plans.get(m.planCode, m.planVersion, tx))!;
      const start = periodStart(plan.entitlements[key]!.period, at, new Date(m.createdAt));
      await tx.query(
        `insert into billing.entitlement_usage (membership_id, key, period_start, used, updated_at) values ($1, $2, $3, $4, $5)
         on conflict (membership_id, key, period_start) do update set used = billing.entitlement_usage.used + excluded.used, updated_at = excluded.updated_at`,
        [m.id, key, start, amount.toString(), at],
      );
      await tx.query('insert into billing.entitlement_consumption (idempotency_key, membership_id, key, amount, period_start) values ($1, $2, $3, $4, $5)', [idempotencyKey, m.id, key, amount.toString(), start]);
      return { ...decision, remaining: decision.remaining - amount };
    });
  }

  /** Every entitlement of the plan with what is left, for /me/capabilities. */
  async summary(m: MembershipRef, at: Date): Promise<Record<string, { remaining: string; unit: string; resetsAt?: string }>> {
    const plan = await this.plans.get(m.planCode, m.planVersion);
    const out: Record<string, { remaining: string; unit: string; resetsAt?: string }> = {};
    for (const key of Object.keys(plan?.entitlements ?? {})) {
      const d = await this.can(m, key, 0n, at);
      out[key] = { remaining: d.remaining.toString(), unit: d.unit, ...(d.resetsAt ? { resetsAt: d.resetsAt } : {}) };
    }
    return out;
  }
}

const resets = (t: EntitlementTemplate, at: Date, m: MembershipRef): { resetsAt?: string } => {
  const end = periodEnd(t.period, at, new Date(m.createdAt), m.termMonths);
  return end ? { resetsAt: end } : {};
};
