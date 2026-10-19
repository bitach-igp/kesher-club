// IlPayInitPort simulator. Fixtures: bankCode "000" -> PROVIDER_UNAVAILABLE; reference starting
// "REJECT" is rejected at the bank callback. Initiations expire after 15 minutes.
import { addMs, type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import type { Money } from '@kesher/domain';
import { IlPayInitError, type IlPayInitPort, type PayInitiation, type PayInitStatus } from './il-payinit.ts';

export class IlPayInitSimulator implements IlPayInitPort {
  private readonly payments = new Map<string, PayInitiation & { reference: string }>();
  private readonly idem = new IdempotencyStore<PayInitiation>();
  private readonly events = new Map<string, { eventId: string; payment: PayInitiation }>();
  private readonly ids = new Sequence('ilp');
  private readonly evIds = new Sequence('evt');

  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  async initiate(input: { amount: Money; payerHint?: { bankCode: string }; reference: string; returnUrl: string }, key: string): Promise<PayInitiation> {
    if (input.payerHint?.bankCode === '000') throw new IlPayInitError('PROVIDER_UNAVAILABLE', 'Simulated PISP outage');
    if (input.amount.currency !== 'ILS' || input.amount.minor <= 0n) throw new IlPayInitError('VALIDATION_FAILED', 'Positive ILS amount required');
    if (!/^https:\/\//.test(input.returnUrl)) throw new IlPayInitError('VALIDATION_FAILED', 'returnUrl must be https');
    return this.idem.run(key, async () => {
      const paymentId = this.ids.next();
      const p = { paymentId, amount: input.amount, status: 'redirect' as const, redirectUrl: `https://bank.sim.kesher.example/authorise/${paymentId}`, expiresAt: addMs(this.clock.now(), 15 * 60_000).toISOString(), reference: input.reference };
      this.payments.set(paymentId, p);
      const { reference: _r, ...out } = p;
      return out;
    });
  }

  async getStatus(paymentId: string): Promise<PayInitiation> {
    const p = this.must(paymentId);
    if (p.status === 'redirect' && this.clock.now().getTime() > Date.parse(p.expiresAt)) p.status = 'expired';
    const { reference: _r, ...out } = p;
    return out;
  }

  async parseCallback(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; payment: PayInitiation }> {
    if (headers['x-sim-signature'] !== 'sim') throw new IlPayInitError('BAD_SIGNATURE', 'Callback signature invalid');
    const b = JSON.parse(rawBody) as { eventId: string; paymentId: string; status: PayInitStatus };
    const prior = this.events.get(b.eventId);
    if (prior) return prior;
    const p = this.must(b.paymentId);
    p.status = b.status;
    if (b.status !== 'redirect') delete p.redirectUrl;
    const { reference: _r, ...payment } = p;
    const out = { eventId: b.eventId, payment: { ...payment } };
    this.events.set(b.eventId, out);
    return out;
  }

  /** Control-panel hook: the bank's callback once the payer acts. */
  bankCallback(paymentId: string): { headers: Record<string, string>; rawBody: string } {
    const p = this.must(paymentId);
    const status: PayInitStatus = p.reference.startsWith('REJECT') ? 'rejected' : 'settled';
    return { headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: this.evIds.next(), paymentId, status }) };
  }

  private must(id: string) {
    const p = this.payments.get(id);
    if (!p) throw new IlPayInitError('UNKNOWN_PAYMENT', id);
    return p;
  }
}
