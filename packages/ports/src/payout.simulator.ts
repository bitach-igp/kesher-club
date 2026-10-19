// PayoutPort simulator. Fixtures: payee name "FAIL" -> the payout fails on the next status webhook;
// name "OUTAGE" -> PROVIDER_UNAVAILABLE at create; name "WRONG NAME" -> NAME_MISMATCH on validation.
import { toWire } from '@kesher/domain';
import type { Money } from '@kesher/domain';
import { type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { ibanChecksumOk, isIsraeliIban, PayoutError, type Payee, type PayeeValidation, type Payout, type PayoutPort, type PayoutStatus } from './payout.ts';

export class PayoutSimulator implements PayoutPort {
  private readonly payouts = new Map<string, Payout>();
  private readonly idem = new IdempotencyStore<Payout>();
  private readonly events = new Map<string, { eventId: string; payout: Payout }>();
  private readonly ids = new Sequence('po');
  private readonly evIds = new Sequence('evt');

  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  async validatePayee(payee: Payee): Promise<PayeeValidation> {
    const reasons: PayeeValidation['reasons'][number][] = [];
    if (!ibanChecksumOk(payee.iban)) reasons.push('IBAN_CHECKSUM');
    if (!isIsraeliIban(payee.iban)) reasons.push('NOT_ISRAELI');
    if (payee.name.trim().toUpperCase() === 'WRONG NAME') reasons.push('NAME_MISMATCH');
    const bankCode = isIsraeliIban(payee.iban) ? payee.iban.replace(/\s+/g, '').slice(4, 7) : undefined;
    return { valid: reasons.length === 0, reasons, ...(bankCode ? { bankCode } : {}) };
  }

  async createPayout(input: { payee: Payee; amount: Money; reference: string }, key: string): Promise<Payout> {
    if (input.payee.name === 'OUTAGE') throw new PayoutError('PROVIDER_UNAVAILABLE', 'Simulated payout rail outage');
    if (input.amount.currency !== 'ILS' || input.amount.minor <= 0n) throw new PayoutError('VALIDATION_FAILED', 'Payouts are positive ILS amounts');
    const v = await this.validatePayee(input.payee);
    if (!v.valid) throw new PayoutError('INVALID_PAYEE', v.reasons.join(','));
    return this.idem.run(key, async () => {
      const p: Payout = { payoutId: this.ids.next(), payee: input.payee, amount: input.amount, status: 'submitted' };
      this.payouts.set(p.payoutId, p);
      return { ...p };
    });
  }

  async getPayout(payoutId: string): Promise<Payout> {
    return { ...this.must(payoutId) };
  }

  async parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; payout: Payout }> {
    if (headers['x-sim-signature'] !== 'sim') throw new PayoutError('BAD_SIGNATURE', 'Webhook signature invalid');
    const b = JSON.parse(rawBody) as { eventId: string; payoutId: string; status: PayoutStatus; failureReason?: string };
    const prior = this.events.get(b.eventId);
    if (prior) return prior;
    const p = this.must(b.payoutId);
    const next: Payout = { ...p, status: b.status, ...(b.failureReason ? { failureReason: b.failureReason } : {}) };
    this.payouts.set(p.payoutId, next);
    const out = { eventId: b.eventId, payout: { ...next } };
    this.events.set(b.eventId, out);
    return out;
  }

  /** Control-panel hook: the next status webhook for a payout (FAIL payees fail, others settle). */
  nextWebhook(payoutId: string): { headers: Record<string, string>; rawBody: string } {
    const p = this.must(payoutId);
    const fail = p.payee.name === 'FAIL';
    const body = { eventId: this.evIds.next(), payoutId, status: fail ? 'failed' : 'settled', ...(fail ? { failureReason: 'ACCOUNT_CLOSED' } : {}), amount: toWire(p.amount) };
    return { headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify(body) };
  }

  private must(id: string): Payout {
    const p = this.payouts.get(id);
    if (!p) throw new PayoutError('UNKNOWN_PAYOUT', id);
    return p;
  }
}
