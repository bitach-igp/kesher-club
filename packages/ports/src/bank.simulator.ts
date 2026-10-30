// BankPort simulator (T-0618). Kesher's collection account in memory: the panel's `credit` hook lands a credit
// (with the remitter text it is given) and answers the bank's signed notification for it; `statement` lists the
// credits of a value date. Fixtures: a statement for value date 2000-01-01 → PROVIDER_UNAVAILABLE; the
// signature header `x-sim-signature: sim` is the only valid one. `withhold` lands a credit without its
// notification, the lost webhook the daily reconciliation is there to catch.
import { fromWire, toWire, type Money } from '@kesher/domain';
import { type Clock, fixedClock, Sequence } from './base.ts';
import { BankError, REMITTER_MAX, type BankPort, type BankRail, type IncomingCredit } from './bank.ts';

export const BANK_OUTAGE_DATE = '2000-01-01';
const RAILS: readonly BankRail[] = ['masav', 'wire', 'ach'];

export class BankSimulator implements BankPort {
  private readonly credits = new Map<string, IncomingCredit>();
  private readonly events = new Map<string, { eventId: string; credit: IncomingCredit }>();
  private readonly ids = new Sequence('bcr');
  private readonly refs = new Sequence('FT');
  private readonly evIds = new Sequence('bev');
  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  /** Control hook: a credit arrives today, quoting `remitterReference`. Answers the signed notification the bank sends. */
  credit(input: { rail: BankRail; amount: Money; remitterReference: string; bankReference?: string; valueDate?: string }): { credit: IncomingCredit; headers: Record<string, string>; rawBody: string } {
    const credit = this.land(input);
    return { credit, ...this.notificationFor(credit.creditId) };
  }

  /** Control hook: a credit lands but its notification never comes. */
  withhold(input: { rail: BankRail; amount: Money; remitterReference: string; bankReference?: string; valueDate?: string }): IncomingCredit {
    return this.land(input);
  }

  /** The signed notification for a credit already on the account (a bank's retry sends the same event id). */
  notificationFor(creditId: string, eventId = this.evIds.next()): { headers: Record<string, string>; rawBody: string } {
    const c = this.credits.get(creditId);
    if (!c) throw new BankError('VALIDATION_FAILED', `Unknown credit ${creditId}`);
    return { headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId, credit: { ...c, amount: toWire(c.amount) } }) };
  }

  async parseWebhook(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; credit: IncomingCredit }> {
    if (headers['x-sim-signature'] !== 'sim') throw new BankError('BAD_SIGNATURE', 'Bank notification signature invalid');
    let b: { eventId?: unknown; credit?: { creditId?: unknown; amount?: { minor: string; currency: string } } };
    try {
      b = JSON.parse(rawBody) as typeof b;
    } catch {
      throw new BankError('VALIDATION_FAILED', 'Bank notification is not JSON');
    }
    if (typeof b.eventId !== 'string' || typeof b.credit?.creditId !== 'string') throw new BankError('VALIDATION_FAILED', 'Bank notification names no event or credit');
    const prior = this.events.get(b.eventId);
    if (prior) return { eventId: prior.eventId, credit: { ...prior.credit } };
    const credit = this.credits.get(b.credit.creditId);
    if (!credit) throw new BankError('VALIDATION_FAILED', 'Bank notification for a credit the account does not hold');
    if (!b.credit.amount || fromWire(b.credit.amount).minor !== credit.amount.minor) throw new BankError('VALIDATION_FAILED', 'Notification amount differs from the credit');
    const out = { eventId: b.eventId, credit: { ...credit } };
    this.events.set(b.eventId, out);
    return out;
  }

  async statement(input: { valueDate: string }): Promise<IncomingCredit[]> {
    if (input.valueDate === BANK_OUTAGE_DATE) throw new BankError('PROVIDER_UNAVAILABLE', 'Simulated bank outage');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate)) throw new BankError('VALIDATION_FAILED', 'valueDate must be YYYY-MM-DD');
    return [...this.credits.values()].filter((c) => c.valueDate === input.valueDate).map((c) => ({ ...c }));
  }

  private land(input: { rail: BankRail; amount: Money; remitterReference: string; bankReference?: string; valueDate?: string }): IncomingCredit {
    if (!RAILS.includes(input.rail)) throw new BankError('VALIDATION_FAILED', `Unknown rail ${String(input.rail)}`);
    if (input.amount.minor <= 0n) throw new BankError('VALIDATION_FAILED', 'A credit is a positive amount');
    const credit: IncomingCredit = {
      creditId: this.ids.next(),
      rail: input.rail,
      amount: input.amount,
      bankReference: input.bankReference ?? this.refs.next().replace('_', '-'),
      remitterReference: input.remitterReference.slice(0, REMITTER_MAX),
      valueDate: input.valueDate ?? this.clock.now().toISOString().slice(0, 10),
    };
    this.credits.set(credit.creditId, credit);
    return credit;
  }
}
