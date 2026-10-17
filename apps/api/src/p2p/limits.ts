// P2P limits (T-0505, REQ-PAY-002): a send is allowed up to the lower of two monthly caps, the plan's
// `p2p.monthlySendMinor` entitlement (when the plan names one, on an active membership) and the member's
// risk tier (ops.risk_tier, 'new' when unset, with limits per tier and currency in ops.risk_limit).
// Risk usage is the sum of this month's P2P sends that did not fail, read from ops.transfer, so nothing
// drifts. LIMIT_EXCEEDED carries the remaining amount and which cap bound it.
import { DomainError, money, type Currency, type Money } from '@kesher/domain';
import type { EntitlementService } from '../billing/entitlements.ts';
import type { MembershipService } from '../billing/memberships.ts';
import type { PlanService } from '../billing/plans.ts';
import type { Database } from '../db.ts';

export const P2P_ENTITLEMENT = 'p2p.monthlySendMinor';
export type RiskTier = 'new' | 'standard' | 'trusted';
export const DEFAULT_TIER: RiskTier = 'new';

export interface LimitDecision {
  allowed: boolean;
  /** The lower of the two caps, less what this month already used. */
  remaining: Money;
  limitedBy: 'entitlement' | 'risk';
  tier: RiskTier;
  risk: { limit: Money; used: Money };
  entitlement?: { limit: Money; remaining: Money };
}

export class P2pLimitService {
  constructor(
    private readonly db: Database,
    private readonly memberships: MembershipService,
    private readonly entitlements: EntitlementService,
    private readonly plans: PlanService,
  ) {}

  async tierOf(partyId: string): Promise<RiskTier> {
    const r = await this.db.query<{ tier: RiskTier }>('select tier from ops.risk_tier where party_id = $1', [partyId]);
    return r.rows[0]?.tier ?? DEFAULT_TIER;
  }

  /** Staff move a member between tiers with a reason; the audit chain is the caller's job. */
  async setTier(partyId: string, tier: RiskTier, setBy: string, reason: string, now: Date): Promise<void> {
    if (!reason.trim()) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
    await this.db.query(
      `insert into ops.risk_tier (party_id, tier, set_by, reason, updated_at) values ($1, $2, $3, $4, $5)
       on conflict (party_id) do update set tier = excluded.tier, set_by = excluded.set_by, reason = excluded.reason, updated_at = excluded.updated_at`,
      [partyId, tier, setBy, reason, now],
    );
  }

  async decide(partyId: string, amount: Money, now: Date): Promise<LimitDecision> {
    const tier = await this.tierOf(partyId);
    const limitRow = await this.db.query<{ p2p_monthly_minor: string }>('select p2p_monthly_minor::text from ops.risk_limit where tier = $1 and currency = $2', [tier, amount.currency]);
    const riskLimit = BigInt(limitRow.rows[0]?.p2p_monthly_minor ?? '0');
    const used = await this.usedThisMonth(partyId, amount.currency, now);
    const riskRemaining = riskLimit - used < 0n ? 0n : riskLimit - used;
    let remaining = riskRemaining;
    let limitedBy: LimitDecision['limitedBy'] = 'risk';
    let entitlement: LimitDecision['entitlement'];
    const m = await this.memberships.forMember(partyId);
    if (m && m.status === 'active') {
      const plan = await this.plans.get(m.planCode, m.planVersion);
      if (plan?.entitlements[P2P_ENTITLEMENT]) {
        const d = await this.entitlements.can(m, P2P_ENTITLEMENT, amount.minor, now);
        entitlement = { limit: money(d.limit, amount.currency), remaining: money(d.remaining, amount.currency) };
        if (d.remaining < remaining) {
          remaining = d.remaining;
          limitedBy = 'entitlement';
        }
      }
    }
    return {
      allowed: amount.minor <= remaining,
      remaining: money(remaining, amount.currency),
      limitedBy,
      tier,
      risk: { limit: money(riskLimit, amount.currency), used: money(used, amount.currency) },
      ...(entitlement ? { entitlement } : {}),
    };
  }

  /** Throws LIMIT_EXCEEDED with the remaining amount (REQ-PAY-002). */
  async check(partyId: string, amount: Money, now: Date): Promise<LimitDecision> {
    const d = await this.decide(partyId, amount, now);
    if (!d.allowed) throw new DomainError('LIMIT_EXCEEDED', `Only ${d.remaining.minor} ${d.remaining.currency} minor units may be sent this month`, { remaining: d.remaining.minor.toString(), currency: d.remaining.currency, limitedBy: d.limitedBy });
    return d;
  }

  /** Records the plan's usage after a send settles; a no-op when the plan has no P2P entitlement. */
  async consume(partyId: string, amount: Money, idempotencyKey: string, now: Date): Promise<void> {
    const m = await this.memberships.forMember(partyId);
    if (!m || m.status !== 'active') return;
    const plan = await this.plans.get(m.planCode, m.planVersion);
    if (!plan?.entitlements[P2P_ENTITLEMENT]) return;
    await this.entitlements.consume(m, P2P_ENTITLEMENT, amount.minor, idempotencyKey, now);
  }

  private async usedThisMonth(partyId: string, currency: Currency, now: Date): Promise<bigint> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const r = await this.db.query<{ used: string }>(
      `select coalesce(sum(amount_minor), 0)::text as used from ops.transfer
        where kind = 'p2p' and from_party_id = $1 and currency = $2 and created_at >= $3 and state not in ('failed','cancelled','reversed')`,
      [partyId, currency, start],
    );
    return BigInt(r.rows[0]?.used ?? '0');
  }
}
