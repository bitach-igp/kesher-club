// Dunning, pause/resume and the 10-month term (T-0303). Consumes BillingPort events from the
// webhook store: a failed invoice moves the membership to past_due and schedules the vendor's
// smart retry (3, 5, 7 days); the third failure pauses collection and the membership; a paid
// invoice resumes it; the tenth paid invoice ends the academic-year term at period end.
import { DomainError, uuidv7 } from '@kesher/domain';
import type { BillingEvent, BillingPort, Market, NotifyPort } from '@kesher/ports';
import type { Database } from '@kesher/api/db';
import type { Membership, MembershipService } from '@kesher/api/billing/memberships';

export const DUNNING_SCHEDULE_DAYS: readonly number[] = [3, 5, 7];
export const MAX_ATTEMPTS = 3;

export interface DunningResult {
  membershipId: string;
  status: Membership['status'];
  attempt: number;
  nextRetryAt?: string;
  paidInvoices: number;
}

export function termEnd(createdAt: string, termMonths: number): string {
  const d = new Date(createdAt);
  d.setUTCMonth(d.getUTCMonth() + termMonths);
  return d.toISOString();
}

export class DunningService {
  private readonly db: Database;
  private readonly memberships: MembershipService;
  private readonly billing: BillingPort;
  private readonly notify: NotifyPort;
  /** The worker's market: its dedupe markers in ops.inbound_event carry it like every other row (T-0027). */
  private readonly market: Market;
  constructor(
    db: Database,
    memberships: MembershipService,
    billing: BillingPort,
    notify: NotifyPort,
    market: Market = 'IL',
  ) {
    this.db = db;
    this.memberships = memberships;
    this.billing = billing;
    this.notify = notify;
    this.market = market;
  }

  async onBillingEvent(event: BillingEvent, now: Date): Promise<DunningResult> {
    const subscriptionId = event.type === 'subscription.updated' ? event.subscription.subscriptionId : event.subscriptionId;
    const m = await this.memberships.bySubscriptionRef(subscriptionId);
    if (!m) throw new DomainError('NOT_FOUND', 'No membership for this subscription');
    if (await this.seen(event.eventId)) return this.result(m, await this.paidCount(m.id));
    await this.db.query(`insert into ops.inbound_event (provider, event_id, signature_ok, payload, market) values ('stripe', $1, true, $2, $3) on conflict do nothing`, [`dunning:${event.eventId}`, JSON.stringify({ type: event.type }), this.market]);

    if (event.type === 'invoice.payment_failed') return this.onFailed(m, now);
    if (event.type === 'invoice.paid') return this.onPaid(m, event.eventId, now);
    const s = event.subscription.status;
    if (s === 'cancelled' && m.status !== 'cancelled') await this.memberships.setStatus(m.id, 'cancelled', now);
    return this.result((await this.memberships.get(m.id))!, await this.paidCount(m.id));
  }

  async pause(membershipId: string, reason: string, now: Date): Promise<Membership> {
    const m = await this.must(membershipId);
    if (m.status !== 'active' && m.status !== 'past_due') throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot pause a ${m.status} membership`);
    await this.billing.pause(await this.subRef(m.id), `pause:${m.id}:${now.getTime()}`);
    await this.memberships.setStatus(m.id, 'paused', now);
    await this.email(m, 'billing.paused', { reason });
    return (await this.memberships.get(m.id))!;
  }

  async resume(membershipId: string, now: Date): Promise<Membership> {
    const m = await this.must(membershipId);
    if (m.status !== 'paused') throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot resume a ${m.status} membership`);
    await this.billing.resume(await this.subRef(m.id), `resume:${m.id}:${now.getTime()}`);
    await this.memberships.setStatus(m.id, 'active', now, { dunningAttempts: 0 });
    await this.email(m, 'billing.resumed', {});
    return (await this.memberships.get(m.id))!;
  }

  private async onFailed(m: Membership, now: Date): Promise<DunningResult> {
    const attempt = m.dunningAttempts + 1;
    if (attempt >= MAX_ATTEMPTS) {
      await this.billing.pause(await this.subRef(m.id), `dunning-pause:${m.id}:${attempt}`);
      await this.memberships.setStatus(m.id, 'paused', now, { dunningAttempts: attempt });
      await this.email(m, 'billing.paused', { reason: 'payment_failed', attempt: String(attempt) });
      return this.result((await this.memberships.get(m.id))!, await this.paidCount(m.id), attempt);
    }
    const retryDays = DUNNING_SCHEDULE_DAYS[attempt - 1]!;
    const nextRetryAt = new Date(now.getTime() + retryDays * 86_400_000).toISOString();
    await this.memberships.setStatus(m.id, 'past_due', now, { dunningAttempts: attempt });
    await this.email(m, 'billing.payment_failed', { attempt: String(attempt), retryDays: String(retryDays) });
    return { ...this.result((await this.memberships.get(m.id))!, await this.paidCount(m.id), attempt), nextRetryAt };
  }

  private async onPaid(m: Membership, eventId: string, now: Date): Promise<DunningResult> {
    await this.db.query(`insert into billing.entitlement_consumption (idempotency_key, membership_id, key, amount, period_start) values ($1, $2, 'invoice.paid', 1, $3) on conflict do nothing`, [`paid:${eventId}`, m.id, now.toISOString().slice(0, 10)]);
    const paid = await this.paidCount(m.id);
    if (m.status === 'paused' || m.status === 'past_due') {
      if (m.status === 'paused') await this.billing.resume(await this.subRef(m.id), `resume:${m.id}:${eventId}`);
      await this.memberships.setStatus(m.id, 'active', now, { dunningAttempts: 0 });
    }
    if (paid >= m.termMonths) {
      await this.billing.cancel(await this.subRef(m.id), 'period_end', `term-end:${m.id}`);
      await this.email(m, 'billing.term_complete', { termEnd: termEnd(m.createdAt, m.termMonths) });
    }
    return this.result((await this.memberships.get(m.id))!, paid);
  }

  private async paidCount(membershipId: string): Promise<number> {
    const r = await this.db.query<{ n: number }>(`select count(*)::int as n from billing.entitlement_consumption where membership_id = $1 and key = 'invoice.paid'`, [membershipId]);
    return r.rows[0]?.n ?? 0;
  }

  private async seen(eventId: string): Promise<boolean> {
    return (await this.db.query(`select 1 from ops.inbound_event where provider = 'stripe' and event_id = $1`, [`dunning:${eventId}`])).rowCount > 0;
  }

  private async subRef(membershipId: string): Promise<string> {
    const r = await this.db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'membership' and entity_id = $1 and provider = 'stripe'`, [membershipId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Membership has no vendor subscription');
    return r.rows[0].external_id;
  }

  private async must(id: string): Promise<Membership> {
    const m = await this.memberships.get(id);
    if (!m) throw new DomainError('NOT_FOUND', 'Membership not found');
    return m;
  }

  private async email(m: Membership, template: string, data: Record<string, string>): Promise<void> {
    // The funder's email is resolved by the notify service from the party id; here we address by party ref.
    await this.notify.send({ channel: 'email', to: `party:${m.funderPartyId}@members.kesher.example`, template, locale: 'en', data: { membershipId: m.id, ...data }, category: 'money' }, `${template}:${m.id}:${uuidv7()}`);
  }

  private result(m: Membership, paidInvoices: number, attempt = m.dunningAttempts): DunningResult {
    return { membershipId: m.id, status: m.status, attempt, paidInvoices };
  }
}
