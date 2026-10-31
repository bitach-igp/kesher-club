// Memberships (T-0302): createMembership starts a subscription at the BillingPort (vendor ref in
// ops.external_ref) and pins the plan version. Status mirrors the vendor via webhooks (T-0303).
// T-0310 (REQ-BIL-004): the funder lists the memberships they pay for and cancels one at the end of the paid period;
// until then it stays active and reads as ending on `cancelAt`, and the member keeps every unit of money loaded.
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
  /** Set once the funder cancelled: the membership ends on this date, the end of the paid period. */
  cancelAt?: string;
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
  cancel_at: string | Date | null;
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

  /** The memberships the party pays for and the one they hold, newest first; none still being set up. */
  async forParty(partyId: string): Promise<(Membership & { role: 'funder' | 'member' })[]> {
    const r = await this.db.query<Row>(`select * from billing.membership where (funder_party_id = $1 or member_party_id = $1) and status <> 'incomplete' order by created_at desc, id desc limit 50`, [partyId]);
    return r.rows.map((x) => ({ ...toMembership(x), role: x.funder_party_id === partyId ? ('funder' as const) : ('member' as const) }));
  }

  /**
   * The funder cancels at the end of the paid period, once: the vendor is told with the caller's key, so a retry is the
   * same cancel. The member cannot cancel what someone else pays for (403); anyone else's membership answers 404.
   */
  async cancel(id: string, callerPartyId: string, idempotencyKey: string): Promise<Membership> {
    const m = /^[0-9a-f-]{36}$/i.test(id) ? await this.get(id) : undefined;
    if (!m || (m.funderPartyId !== callerPartyId && m.memberPartyId !== callerPartyId)) throw new DomainError('NOT_FOUND', 'Membership not found');
    if (m.funderPartyId !== callerPartyId) throw new DomainError('FORBIDDEN', 'Only the person who pays for a membership can cancel it');
    if (m.status === 'cancelled') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This membership is already cancelled');
    if (m.cancelAt) return m;
    const subscriptionId = await this.externalRef('membership', id, 'stripe');
    if (!subscriptionId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This membership has no subscription to cancel');
    let cancelAt: string | undefined;
    try {
      cancelAt = (await this.billing.cancel(subscriptionId, 'period_end', idempotencyKey)).cancelAt;
    } catch (e) {
      throw mapBillingError(e);
    }
    await this.db.query('update billing.membership set cancel_at = $2, updated_at = now() where id = $1 and cancel_at is null', [id, cancelAt ?? null]);
    return (await this.get(id))!;
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
    if (e.code === 'INVALID_STATE') return new DomainError('IDEMPOTENCY_CONFLICT', 'The billing provider already ended this subscription');
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
    ...(r.cancel_at ? { cancelAt: new Date(r.cancel_at).toISOString() } : {}),
    dunningAttempts: r.dunning_attempts,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
