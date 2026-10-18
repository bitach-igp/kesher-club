// FundingPort simulator. Fixtures: paymentMethodId "pm_declined" -> DECLINED; "pm_outage" ->
// PROVIDER_UNAVAILABLE; ACH loads start on_hold for 3 business days; card/wallet loads succeed at once.
// Refunds succeed at once up to the load's remaining amount; a load paid with "pm_norefund" refunds as
// failed (REFUND_REFUSED), and "pm_slowrefund" as pending until `settleRefund(refundId)`.
// `settle(loadId)` (control panel) clears a hold or finishes a processing load.
import { toWire, fromWire } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { FundingError, type FundingMethod, type FundingPort, type Load, type Refund } from './funding.ts';

const ACH_HOLD_BUSINESS_DAYS = 3;

/** Adds business days (Mon–Fri) to a date, in UTC. Exported for the wallet's "on hold until" copy. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

export class FundingSimulator implements FundingPort {
  private readonly loads = new Map<string, Load>();
  private readonly idem = new IdempotencyStore<Load>();
  private readonly events = new Map<string, { eventId: string; load: Load }>();
  private readonly ids = new Sequence('load');
  private readonly evIds = new Sequence('evt');
  private readonly refunds = new Map<string, Refund>();
  private readonly refundIdem = new IdempotencyStore<Refund>();
  private readonly refundIds = new Sequence('re');
  /** The payment method behind each load, for the refund fixtures. */
  private readonly sources = new Map<string, string>();

  constructor(readonly clock: Clock = fixedClock()) {}

  async createLoad(input: { customerId: string; method: FundingMethod; amount: Money; paymentMethodId?: string }, idempotencyKey: string): Promise<Load> {
    if (input.paymentMethodId === 'pm_outage') throw new FundingError('PROVIDER_UNAVAILABLE', 'Simulated funding outage');
    if (input.amount.minor <= 0n) throw new FundingError('VALIDATION_FAILED', 'Amount must be positive');
    if (input.method === 'rtp') throw new FundingError('UNSUPPORTED_METHOD', 'RTP not enabled in the simulator');
    return this.idem.run(idempotencyKey, async () => {
      if (input.paymentMethodId === 'pm_declined') throw new FundingError('DECLINED', 'Simulated decline');
      const loadId = this.ids.next();
      const load: Load =
        input.method === 'ach'
          ? { loadId, method: 'ach', amount: input.amount, status: 'on_hold', holdUntil: addBusinessDays(this.clock.now(), ACH_HOLD_BUSINESS_DAYS).toISOString() }
          : { loadId, method: input.method, amount: input.amount, status: 'succeeded' };
      this.loads.set(loadId, load);
      this.sources.set(loadId, input.paymentMethodId ?? '');
      return { ...load };
    });
  }

  async getLoad(loadId: string): Promise<Load> {
    return { ...this.must(loadId) };
  }

  async refund(input: { loadId: string; amount: Money }, idempotencyKey: string): Promise<Refund> {
    const load = this.must(input.loadId);
    if (input.amount.minor <= 0n) throw new FundingError('VALIDATION_FAILED', 'Refund amount must be positive');
    if (input.amount.currency !== load.amount.currency) throw new FundingError('VALIDATION_FAILED', 'Refund currency differs from the load');
    return this.refundIdem.run(idempotencyKey, async () => {
      if (load.status !== 'succeeded') throw new FundingError('VALIDATION_FAILED', 'Only a settled load can be refunded');
      if (input.amount.minor > this.refundable(load.loadId)) throw new FundingError('VALIDATION_FAILED', 'Refund exceeds what remains of the load');
      const source = this.sources.get(load.loadId) ?? '';
      const refund: Refund = {
        refundId: this.refundIds.next(),
        loadId: load.loadId,
        amount: input.amount,
        status: source === 'pm_norefund' ? 'failed' : source === 'pm_slowrefund' ? 'pending' : 'succeeded',
        ...(source === 'pm_norefund' ? { failureCode: 'REFUND_REFUSED' } : {}),
      };
      this.refunds.set(refund.refundId, refund);
      return { ...refund };
    });
  }

  async getRefund(refundId: string): Promise<Refund> {
    const r = this.refunds.get(refundId);
    if (!r) throw new FundingError('UNKNOWN_REFUND', refundId);
    return { ...r };
  }

  /** Control-panel hook: finishes a pending refund. */
  settleRefund(refundId: string, status: 'succeeded' | 'failed' = 'succeeded'): Refund {
    const r = this.refunds.get(refundId);
    if (!r) throw new FundingError('UNKNOWN_REFUND', refundId);
    const next: Refund = { ...r, status, ...(status === 'failed' ? { failureCode: 'REFUND_REFUSED' } : {}) };
    this.refunds.set(refundId, next);
    return { ...next };
  }

  /** Minor units of the load not yet refunded (failed refunds do not count). */
  private refundable(loadId: string): bigint {
    let taken = 0n;
    for (const r of this.refunds.values()) if (r.loadId === loadId && r.status !== 'failed') taken += r.amount.minor;
    return this.must(loadId).amount.minor - taken;
  }

  async parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; load: Load }> {
    if (headers['x-sim-signature'] !== 'sim') throw new FundingError('BAD_SIGNATURE', 'Webhook signature invalid');
    const b = JSON.parse(rawBody) as { eventId: string; loadId: string; status: Load['status']; amount: { minor: string; currency: string } };
    const prior = this.events.get(b.eventId);
    if (prior) return prior;
    const load = this.must(b.loadId);
    if (fromWire(b.amount).minor !== load.amount.minor) throw new FundingError('VALIDATION_FAILED', 'Webhook amount differs from the load');
    const { holdUntil: _hold, ...rest } = load;
    const next: Load = b.status === 'succeeded' ? { ...rest, status: b.status } : { ...load, status: b.status };
    this.loads.set(load.loadId, next);
    const out = { eventId: b.eventId, load: { ...next } };
    this.events.set(b.eventId, out);
    return out;
  }

  /** Control-panel hook: a signed webhook settling or failing a load. */
  webhookFor(loadId: string, status: 'succeeded' | 'failed'): { headers: Record<string, string>; rawBody: string } {
    const l = this.must(loadId);
    return { headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: this.evIds.next(), loadId, status, amount: toWire(l.amount) }) };
  }

  private must(id: string): Load {
    const l = this.loads.get(id);
    if (!l) throw new FundingError('UNKNOWN_LOAD', id);
    return l;
  }
}
