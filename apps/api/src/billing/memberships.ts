// Memberships (T-0302): createMembership starts a subscription at the BillingPort (vendor ref in
// ops.external_ref) and pins the plan version. Status mirrors the vendor via webhooks (T-0303).
import { DomainError, uuidv7, type Currency, type Money } from '@kesher/domain';
import { BillingError, type BillingPort } from '@kesher/ports';
import { isPgError, PG, type Database } from '../db.ts';
import type { MembershipRef } from './entitlements.ts';
import type { PlanService } from './plans.ts';

export interface Membership extends MembershipRef {
  memberPartyId: string;
  funderPartyId: string;
  price: Money;
  currentPeriodEnd?: string;
  dunningAttempts: number;
}

interface Row {
  id: string;
  member_party_id: string;
  funder_party_id: string;
  plan_code: string;
  plan_version: number;
  status: Membership['status'];
  term_months: number;
  price_minor: string;
  currency: Currency;
  current_period_end: string | Date | null;
  dunning_attempts: number;
  created_at: string | Date;
}

export class MembershipService {
  private readonly db: Database;
  private readonly plans: PlanService;
  private readonly billing: BillingPort;
  constructor(
    db: Database,
    plans: PlanService,
    billing: BillingPort,
  ) {
    this.db = db;
    this.plans = plans;
    this.billing = billing;
  }

  /** `planVersion` pins a version chosen earlier (a funder's invite, T-0307); otherwise the one offered now. */
  async create(input: { idempotencyKey: string; memberPartyId: string; funderPartyId: string; funderEmail: string; planCode: string; planVersion?: number; termMonths?: number }, now: Date): Promise<Membership> {
    const existing = await this.byKey(input.idempotencyKey);
    if (existing) return existing;
    const pinned = input.planVersion === undefined ? undefined : await this.plans.get(input.planCode, input.planVersion);
    if (input.planVersion !== undefined && !pinned) throw new DomainError('NOT_FOUND', `No plan version ${input.planCode} v${input.planVersion}`);
    const plan = pinned ?? (await this.plans.current(input.planCode, now));
    const termMonths = input.termMonths ?? plan.termMonths;
    const id = uuidv7(now);

    // Vendor first (idempotent on our key), then our row; a crash in between replays safely.
    const customerId = await this.ensureCustomer(input.funderPartyId, input.funderEmail);
    let subscriptionId: string;
    try {
      subscriptionId = (await this.billing.createSubscription({ customerId, planCode: plan.planCode, price: plan.price, termMonths }, input.idempotencyKey)).subscriptionId;
    } catch (e) {
      throw mapBillingError(e);
    }

    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `insert into billing.membership (id, idempotency_key, member_party_id, funder_party_id, plan_code, plan_version, status, term_months, price_minor, currency, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $10)`,
          [id, input.idempotencyKey, input.memberPartyId, input.funderPartyId, plan.planCode, plan.version, termMonths, plan.price.minor.toString(), plan.price.currency, now],
        );
        await tx.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('membership', $1, 'stripe', $2)`, [id, subscriptionId]);
      });
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) return (await this.byKey(input.idempotencyKey))!;
      throw e;
    }
    return (await this.byKey(input.idempotencyKey))!;
  }

  async get(id: string): Promise<Membership | undefined> {
    const r = await this.db.query<Row>('select * from billing.membership where id = $1', [id]);
    return r.rows[0] ? toMembership(r.rows[0]) : undefined;
  }

  async byKey(key: string): Promise<Membership | undefined> {
    const r = await this.db.query<Row>('select * from billing.membership where idempotency_key = $1', [key]);
    return r.rows[0] ? toMembership(r.rows[0]) : undefined;
  }

  /** The member's current membership (one active-ish membership per member). */
  async forMember(memberPartyId: string): Promise<Membership | undefined> {
    const r = await this.db.query<Row>(`select * from billing.membership where member_party_id = $1 order by (status = 'active') desc, created_at desc limit 1`, [memberPartyId]);
    return r.rows[0] ? toMembership(r.rows[0]) : undefined;
  }

  async bySubscriptionRef(subscriptionId: string): Promise<Membership | undefined> {
    const r = await this.db.query<Row>(`select m.* from billing.membership m join ops.external_ref x on x.entity_type = 'membership' and x.entity_id = m.id where x.provider = 'stripe' and x.external_id = $1`, [subscriptionId]);
    return r.rows[0] ? toMembership(r.rows[0]) : undefined;
  }

  async setStatus(id: string, status: Membership['status'], now: Date, extra: { dunningAttempts?: number; currentPeriodEnd?: string } = {}): Promise<void> {
    await this.db.query(
      `update billing.membership set status = $2, updated_at = $3, dunning_attempts = coalesce($4, dunning_attempts), current_period_end = coalesce($5, current_period_end),
              paused_at = case when $2 = 'paused' then $3 else paused_at end, cancelled_at = case when $2 = 'cancelled' then $3 else cancelled_at end where id = $1`,
      [id, status, now, extra.dunningAttempts ?? null, extra.currentPeriodEnd ?? null],
    );
  }

  /** The payer's customer at the billing vendor, made once (keyed by the party); the vendor holds their cards. */
  async ensureCustomer(partyId: string, email: string): Promise<string> {
    const known = await this.customerOf(partyId);
    if (known) return known;
    let customerId: string;
    try {
      customerId = (await this.billing.createCustomer({ partyId, email }, `cus:${partyId}`)).customerId;
    } catch (e) {
      throw mapBillingError(e);
    }
    await this.db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('party', $1, 'stripe', $2) on conflict do nothing`, [partyId, customerId]);
    return customerId;
  }

  /** The payer's billing customer, when they have saved a card or paid before. */
  customerOf(partyId: string): Promise<string | undefined> {
    return this.externalRef('party', partyId, 'stripe');
  }

  private async externalRef(entityType: string, entityId: string, provider: string): Promise<string | undefined> {
    const r = await this.db.query<{ external_id: string }>('select external_id from ops.external_ref where entity_type = $1 and entity_id = $2 and provider = $3', [entityType, entityId, provider]);
    return r.rows[0]?.external_id;
  }
}

function mapBillingError(e: unknown): Error {
  if (e instanceof BillingError) {
    if (e.code === 'CARD_DECLINED') return new DomainError('VALIDATION_FAILED', 'The card was declined; try another payment method');
    if (e.code === 'PROVIDER_UNAVAILABLE') return new DomainError('PROVIDER_UNAVAILABLE', 'Billing is temporarily unavailable');
    if (e.code === 'UNKNOWN_PLAN') return new DomainError('NOT_FOUND', 'Plan not found');
  }
  return e as Error;
}

function toMembership(r: Row): Membership {
  return {
    id: r.id,
    memberPartyId: r.member_party_id,
    funderPartyId: r.funder_party_id,
    planCode: r.plan_code,
    planVersion: r.plan_version,
    status: r.status,
    termMonths: r.term_months,
    price: { minor: BigInt(r.price_minor), currency: r.currency },
    ...(r.current_period_end ? { currentPeriodEnd: new Date(r.current_period_end).toISOString() } : {}),
    dunningAttempts: r.dunning_attempts,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
