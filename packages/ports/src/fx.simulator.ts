// FxPort simulator with a fixed mid rate (3.71 ILS per USD) and a 30 s quote lock. Fixture: a quote
// whose `from` amount is exactly 999_999 minor units fails at convert with PROVIDER_UNAVAILABLE.
import { applyBps, money, sub } from '@kesher/domain';
import type { Currency, Money } from '@kesher/domain';
import { addMs, type Clock, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { applyRate, FxError, type FxConversion, type FxPort, type FxQuote, RATE_SCALE } from './fx.ts';

const QUOTE_TTL_MS = 30_000;
const MID: Record<string, bigint> = { 'USD>ILS': 3_710_000n, 'ILS>USD': 269_542n }; // 1/3.71 ≈ 0.269542

export class FxSimulator implements FxPort {
  private readonly quotes = new Map<string, FxQuote>();
  private readonly conversions = new IdempotencyStore<FxConversion>();
  private readonly ids = new Sequence('fxq');
  private readonly convIds = new Sequence('fxc');

  constructor(readonly clock: Clock = fixedClock()) {}

  async quote(input: { from: Money; to: Currency; markupBps: bigint }): Promise<FxQuote> {
    if (input.from.currency === input.to) throw new FxError('UNSUPPORTED_PAIR', 'Same currency');
    if (input.from.minor <= 0n) throw new FxError('VALIDATION_FAILED', 'Amount must be positive');
    if (input.markupBps < 0n || input.markupBps > 10_000n) throw new FxError('VALIDATION_FAILED', 'Markup out of range');
    const rateScaled = MID[`${input.from.currency}>${input.to}`];
    if (!rateScaled) throw new FxError('UNSUPPORTED_PAIR', `${input.from.currency}>${input.to}`);
    const gross = money(applyRate(input.from.minor, rateScaled), input.to);
    const markup = applyBps(gross, input.markupBps);
    const q: FxQuote = {
      quoteId: this.ids.next(),
      from: input.from,
      to: input.to,
      rateScaled,
      markupBps: input.markupBps,
      total: sub(gross, markup),
      markup,
      expiresAt: addMs(this.clock.now(), QUOTE_TTL_MS).toISOString(),
    };
    this.quotes.set(q.quoteId, q);
    return q;
  }

  async convert(quoteId: string, idempotencyKey: string): Promise<FxConversion> {
    return this.conversions.run(idempotencyKey, async () => {
      const q = this.quotes.get(quoteId);
      if (!q) throw new FxError('UNKNOWN_QUOTE', quoteId);
      if (this.clock.now().getTime() > Date.parse(q.expiresAt)) throw new FxError('QUOTE_EXPIRED', 'Quote older than 30 s');
      if (q.from.minor === 999_999n) throw new FxError('PROVIDER_UNAVAILABLE', 'Simulated FX outage');
      this.quotes.delete(quoteId);
      return { conversionId: this.convIds.next(), quoteId, from: q.from, total: q.total, markup: q.markup, rateScaled: q.rateScaled, markupBps: q.markupBps, status: 'settled' };
    });
  }
}

export { RATE_SCALE };
