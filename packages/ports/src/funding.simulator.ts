// FundingPort simulator. Fixtures: paymentMethodId "pm_declined" -> DECLINED; "pm_outage" ->
// PROVIDER_UNAVAILABLE; ACH loads start on_hold for 3 business days; card/wallet loads succeed at once.
// Refunds succeed at once up to the load's remaining amount; a load paid with "pm_norefund" refunds as
// failed (REFUND_REFUSED), and "pm_slowrefund" as pending until `settleRefund(refundId)`.
// `settle(loadId)` (control panel) puts a processing load on hold or clears a hold. A `hosted` load answers
// requires_action with a payment_page action (https://pay.simulator.invalid/{loadId}); `payHosted(loadId, 'card'|'ach')`
// and `failHosted(loadId, code)` play the payer. With `{ credit: true }` it also does the credit step (T-0704):
// `creditWallet` credits a settled load once; accountRef "acct_unknown" is NOT_FOUND; the controls `failNext`, `pendNext`
// and `outageNext` shape the next credit; `creditCount(loadId)` shows how many credits a load got. Without the option
// there is no `creditWallet`, so `isFundingCreditPort` is false.
import { toWire, fromWire } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { assertHttps, FundingError, isPublicIp, type CreditResult, type FundingCreditPort, type FundingMethod, type FundingPort, type HostedLoadInput, type FundingStatementPort, type Load, type Refund, type SettledEntry, type SettledPage } from './funding.ts';

/** Internal signal: a credit answered pending, which the idempotency store must not remember as final. */
class PendingCredit extends Error {}

const ACH_HOLD_BUSINESS_DAYS = 3;
/** How long a simulated payment page stays open. */
const HOSTED_PAGE_MS = 60 * 60 * 1000;

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

export class FundingSimulator implements FundingPort, FundingStatementPort, Partial<FundingCreditPort> {
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
  /** When each load / refund settled, from the simulator clock, for the statement listing. */
  private readonly loadSettledAt = new Map<string, string>();
  private readonly refundSettledAt = new Map<string, string>();
  /** Fixture: the next `listSettled` fails with PROVIDER_UNAVAILABLE after this many pages (0 = at once). */
  outageAfterPages: number | undefined;

  readonly clock: Clock;
  /** Set only with `{ credit: true }`; `creditWallet` is removed from the instance otherwise. */
  declare creditWallet?: (input: { loadId: string; accountRef: string; amount: Money }, idempotencyKey: string) => Promise<CreditResult>;
  private readonly credits = new Map<string, number>();
  private readonly creditIdem = new IdempotencyStore<CreditResult>();
  private readonly pendingKeys = new Set<string>();
  private nextCreditFailure: string | undefined;
  private nextCreditPends = false;
  private nextCreditOutage = false;

  constructor(clock: Clock = fixedClock(), opts: { credit?: boolean } = {}) {
    this.clock = clock;
    if (opts.credit) this.creditWallet = (input, key) => this.credit(input, key);
  }

  /** Control-panel hook: the next credit (a call that would move money) is refused with this code, final for its key. */
  failNext(reasonCode: string): void {
    this.nextCreditFailure = reasonCode;
  }

  /** Control-panel hook: the next credit answers `pending`; the same key later answers `credited`. */
  pendNext(): void {
    this.nextCreditPends = true;
  }

  /** Control-panel hook: the next credit call is PROVIDER_UNAVAILABLE with nothing moved. */
  outageNext(): void {
    this.nextCreditOutage = true;
  }

  /** How many credits the load got (never more than one). */
  creditCount(loadId: string): number {
    return this.credits.get(loadId) ?? 0;
  }

  private async credit(input: { loadId: string; accountRef: string; amount: Money }, key: string): Promise<CreditResult> {
    // The key is bound to its first call: a replay answers that call's result whatever the input (the vendor's rule), so
    // everything, validation included, runs inside the store. Only final answers are remembered; a throw or `pending` is not.
    return this.creditIdem.run(key, async () => {
      if (input.amount.currency !== 'USD') throw new FundingError('VALIDATION_FAILED', 'A credit is in USD');
      if (input.amount.minor <= 0n) throw new FundingError('VALIDATION_FAILED', 'Amount must be positive');
      if (typeof input.accountRef !== 'string' || input.accountRef === '' || input.accountRef.startsWith('c:')) throw new FundingError('VALIDATION_FAILED', 'accountRef is not a member wallet account');
      const load = this.must(input.loadId);
      if (input.amount.minor !== load.amount.minor) throw new FundingError('VALIDATION_FAILED', 'Credit amount differs from the load');
      if (load.status !== 'succeeded') return { status: 'refused', reasonCode: 'NOT_SUCCEEDED' };
      if (input.accountRef === 'acct_unknown') return { status: 'refused', reasonCode: 'NOT_FOUND' };
      if (this.creditCount(load.loadId) > 0) return { status: 'credited' };
      if (this.nextCreditOutage) {
        this.nextCreditOutage = false;
        throw new FundingError('PROVIDER_UNAVAILABLE', 'Simulated funding outage');
      }
      if (this.pendingKeys.has(key)) {
        this.pendingKeys.delete(key);
      } else {
        // Precedence when both are armed: failNext wins and is consumed; pendNext stays armed for the next credit.
        if (this.nextCreditFailure !== undefined) {
          const reasonCode = this.nextCreditFailure;
          this.nextCreditFailure = undefined;
          return { status: 'refused', reasonCode };
        }
        if (this.nextCreditPends) {
          this.nextCreditPends = false;
          this.pendingKeys.add(key);
          throw new PendingCredit();
        }
      }
      this.credits.set(load.loadId, this.creditCount(load.loadId) + 1);
      return { status: 'credited' };
    }).catch((e: unknown) => {
      if (e instanceof PendingCredit) return { status: 'pending' as const };
      throw e;
    });
  }

  async createLoad(input: { customerId: string; method: FundingMethod; amount: Money; paymentMethodId?: string; hosted?: HostedLoadInput; metadata?: Readonly<Record<string, string>> }, idempotencyKey: string): Promise<Load> {
    if (input.paymentMethodId === 'pm_outage') throw new FundingError('PROVIDER_UNAVAILABLE', 'Simulated funding outage');
    if (input.amount.minor <= 0n) throw new FundingError('VALIDATION_FAILED', 'Amount must be positive');
    if (input.method === 'rtp') throw new FundingError('UNSUPPORTED_METHOD', 'RTP not enabled in the simulator');
    if (input.method === 'hosted') {
      const h = input.hosted as { payerIp?: unknown; userConsented?: unknown; successUrl?: unknown; failureUrl?: unknown } | undefined;
      if (typeof h?.payerIp !== 'string' || h.userConsented !== true) throw new FundingError('VALIDATION_FAILED', 'A hosted load needs the payer ip and userConsented true');
      if (!isPublicIp(h.payerIp)) throw new FundingError('VALIDATION_FAILED', 'payerIp must be the payer\'s public IP address');
      for (const [k, v] of [['successUrl', h.successUrl], ['failureUrl', h.failureUrl]] as const) {
        if (v !== undefined) {
          if (typeof v !== 'string') throw new FundingError('VALIDATION_FAILED', `${k} must be a string`);
          assertHttps(v, k);
        }
      }
    }
    return this.idem.run(idempotencyKey, async () => {
      if (input.paymentMethodId === 'pm_declined') throw new FundingError('DECLINED', 'Simulated decline');
      const loadId = this.ids.next();
      const base: Load =
        input.method === 'hosted'
          ? { loadId, method: 'hosted', amount: input.amount, status: 'requires_action', action: { type: 'payment_page', url: `https://pay.simulator.invalid/${loadId}`, expiresAt: new Date(this.clock.now().getTime() + HOSTED_PAGE_MS).toISOString() } }
          : input.method === 'ach'
          ? { loadId, method: 'ach', amount: input.amount, status: 'on_hold', holdUntil: addBusinessDays(this.clock.now(), ACH_HOLD_BUSINESS_DAYS).toISOString() }
          : { loadId, method: input.method, amount: input.amount, status: 'succeeded' };
      const load: Load = input.metadata ? { ...base, metadata: { ...input.metadata } } : base;
      this.loads.set(loadId, load);
      this.sources.set(loadId, input.paymentMethodId ?? '');
      if (load.status === 'succeeded') this.loadSettledAt.set(loadId, this.clock.now().toISOString());
      return { ...load };
    });
  }

  /** Control-panel hook: the payer paid a hosted load on the page, by card (succeeds) or bank (processing until `settle`). */
  payHosted(loadId: string, method: 'card' | 'ach'): Load {
    const l = this.pendingHosted(loadId);
    const { action: _action, ...rest } = l;
    const next: Load = { ...rest, method, status: method === 'card' ? 'succeeded' : 'processing' };
    this.loads.set(loadId, next);
    if (next.status === 'succeeded') this.loadSettledAt.set(loadId, this.clock.now().toISOString());
    return { ...next };
  }

  /** Control-panel hook: the hosted payment failed (declined, abandoned, ...). */
  failHosted(loadId: string, failureCode: string): Load {
    const { action: _action, ...rest } = this.pendingHosted(loadId);
    const next: Load = { ...rest, status: 'failed', failureCode };
    this.loads.set(loadId, next);
    return { ...next };
  }

  /** Control-panel hook: a processing load goes on hold for the ACH hold days; a load on hold is released as succeeded. */
  settle(loadId: string): Load {
    const l = this.must(loadId);
    let next: Load;
    if (l.status === 'processing') next = { ...l, status: 'on_hold', holdUntil: addBusinessDays(this.clock.now(), ACH_HOLD_BUSINESS_DAYS).toISOString() };
    else if (l.status === 'on_hold') {
      const { holdUntil: _hold, ...rest } = l;
      next = { ...rest, status: 'succeeded' };
      this.loadSettledAt.set(loadId, this.clock.now().toISOString());
    } else throw new FundingError('VALIDATION_FAILED', `A ${l.status} load cannot be settled`);
    this.loads.set(loadId, next);
    return { ...next };
  }

  private pendingHosted(loadId: string): Load {
    const l = this.must(loadId);
    if (l.method !== 'hosted' || l.status !== 'requires_action') throw new FundingError('VALIDATION_FAILED', 'Only a pending hosted load can be paid or failed');
    return l;
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
      if (refund.status === 'succeeded') this.refundSettledAt.set(refund.refundId, this.clock.now().toISOString());
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
    if (status === 'succeeded') this.refundSettledAt.set(refundId, this.clock.now().toISOString());
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
    const b = JSON.parse(rawBody) as { eventId: string; loadId: string; status: Load['status']; method?: 'card' | 'ach'; amount: { minor: string; currency: string } };
    const prior = this.events.get(b.eventId);
    if (prior) return prior;
    const load = this.must(b.loadId);
    if (fromWire(b.amount).minor !== load.amount.minor) throw new FundingError('VALIDATION_FAILED', 'Webhook amount differs from the load');
    const { holdUntil: _hold, ...rest } = load;
    let next: Load = b.status === 'succeeded' ? { ...rest, status: b.status } : { ...load, status: b.status };
    if (load.method === 'hosted' && b.status !== 'requires_action') {
      // Once paid the load carries the method the payer used (card unless the hook says ach); a failed one has none to report.
      const { action: _action, ...bare } = next;
      next = b.status === 'failed' ? bare : { ...bare, method: b.method ?? 'card' };
    }
    this.loads.set(load.loadId, next);
    if (next.status === 'succeeded' && !this.loadSettledAt.has(load.loadId)) this.loadSettledAt.set(load.loadId, this.clock.now().toISOString());
    const out = { eventId: b.eventId, load: { ...next } };
    this.events.set(b.eventId, out);
    return out;
  }

  /** Control-panel hook: a signed webhook settling or failing a load. */
  webhookFor(loadId: string, status: 'succeeded' | 'failed', method?: 'card' | 'ach'): { headers: Record<string, string>; rawBody: string } {
    const l = this.must(loadId);
    return { headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: this.evIds.next(), loadId, status, ...(method ? { method } : {}), amount: toWire(l.amount) }) };
  }

  async listSettled(input: { from: string; to: string; cursor?: string; limit?: number }): Promise<SettledPage> {
    if (this.outageAfterPages !== undefined && (input.cursor ? Number(input.cursor) / (input.limit ?? 100) : 0) >= this.outageAfterPages) throw new FundingError('PROVIDER_UNAVAILABLE', 'Simulated funding outage');
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new FundingError('VALIDATION_FAILED', 'from and to must be ISO instants with from before to');
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FundingError('VALIDATION_FAILED', 'limit must be 1 to 100');
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new FundingError('VALIDATION_FAILED', 'Bad cursor');
    const all: SettledEntry[] = [];
    for (const [id, at] of this.loadSettledAt) all.push({ kind: 'charge', id, loadId: id, amount: this.must(id).amount, settledAt: at });
    for (const [id, at] of this.refundSettledAt) {
      const r = this.refunds.get(id)!;
      if (r.status === 'succeeded') all.push({ kind: 'refund', id, loadId: r.loadId, amount: r.amount, settledAt: at });
    }
    const inRange = all.filter((e) => Date.parse(e.settledAt) >= from && Date.parse(e.settledAt) < to).sort((a, b) => a.settledAt.localeCompare(b.settledAt) || a.id.localeCompare(b.id));
    const entries = inRange.slice(offset, offset + limit);
    return { entries, ...(offset + limit < inRange.length ? { nextCursor: String(offset + limit) } : {}) };
  }

  private must(id: string): Load {
    const l = this.loads.get(id);
    if (!l) throw new FundingError('UNKNOWN_LOAD', id);
    return l;
  }
}
