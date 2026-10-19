// InsurancePort simulator. Products: "gadget" ($4.99/30 d), "travel-il" ($12.00/30 d). Fixture:
// product "outage" -> PROVIDER_UNAVAILABLE. Quotes lock for 15 minutes.
import { applyBps, money } from '@kesher/domain';
import { addMs, type Clock, DAY, fixedClock, IdempotencyStore, Sequence } from './base.ts';
import { InsuranceError, type InsurancePort, type InsuranceQuote, type Policy } from './insurance.ts';

const PRODUCTS: Record<string, { premiumPer30d: bigint; commissionBps: bigint; summary: string[] }> = {
  gadget: { premiumPer30d: 499n, commissionBps: 2000n, summary: ['Phone and laptop: theft, accidental damage', 'Excess $50'] },
  'travel-il': { premiumPer30d: 1200n, commissionBps: 1500n, summary: ['Medical in Israel up to $100,000', 'Trip delay, baggage'] },
};

export const SIM_DISCLOSURES = {
  licensedEntity: 'XCover (Cover Genius Ltd), licensed insurance intermediary',
  policyWordingUrl: 'https://www.xcover.com/en/pds/sim-policy-wording',
  commissionDisclosure: 'Kesher Club receives a commission from the insurer, included in the premium shown.',
};

export class InsuranceSimulator implements InsurancePort {
  private readonly quotes = new Map<string, InsuranceQuote>();
  private readonly policies = new Map<string, Policy>();
  private readonly idem = new IdempotencyStore<Policy>();
  private readonly ids = new Sequence('inq');
  private readonly polIds = new Sequence('pol');

  readonly clock: Clock;
  constructor(clock: Clock = fixedClock()) {
    this.clock = clock;
  }

  async quote(input: { product: string; memberId: string; market: 'US' | 'IL'; startsAt: string; days: number }): Promise<InsuranceQuote> {
    if (input.product === 'outage') throw new InsuranceError('PROVIDER_UNAVAILABLE', 'Simulated insurer outage');
    const p = PRODUCTS[input.product];
    if (!p) throw new InsuranceError('UNKNOWN_PRODUCT', input.product);
    const premium = money((p.premiumPer30d * BigInt(input.days) + 29n) / 30n, 'USD');
    const q: InsuranceQuote = {
      quoteId: this.ids.next(),
      product: input.product,
      premium,
      commission: applyBps(premium, p.commissionBps),
      coverageSummary: p.summary,
      disclosures: { ...SIM_DISCLOSURES },
      expiresAt: addMs(this.clock.now(), 15 * 60_000).toISOString(),
    };
    this.quotes.set(q.quoteId, { ...q, ...({ startsAt: input.startsAt, days: input.days } as object) });
    return q;
  }

  async bind(quoteId: string, key: string): Promise<Policy> {
    return this.idem.run(key, async () => {
      const q = this.quotes.get(quoteId) as (InsuranceQuote & { startsAt: string; days: number }) | undefined;
      if (!q) throw new InsuranceError('UNKNOWN_QUOTE', quoteId);
      if (this.clock.now().getTime() > Date.parse(q.expiresAt)) throw new InsuranceError('QUOTE_EXPIRED', 'Quote expired');
      const policy: Policy = {
        policyId: this.polIds.next(),
        quoteId,
        status: 'active',
        startsAt: q.startsAt,
        endsAt: addMs(new Date(q.startsAt), q.days * DAY).toISOString(),
        certificateUrl: `https://www.xcover.com/sim/certificate/${quoteId}`,
      };
      this.policies.set(policy.policyId, policy);
      return policy;
    });
  }

  async cancel(policyId: string, key: string): Promise<Policy> {
    return this.idem.run(key, async () => {
      const p = this.must(policyId);
      if (p.status === 'cancelled') throw new InsuranceError('INVALID_STATE', 'Already cancelled');
      const next = { ...p, status: 'cancelled' as const };
      this.policies.set(policyId, next);
      return next;
    });
  }

  async getPolicy(policyId: string): Promise<Policy> {
    return { ...this.must(policyId) };
  }

  private must(id: string): Policy {
    const p = this.policies.get(id);
    if (!p) throw new InsuranceError('UNKNOWN_POLICY', id);
    return p;
  }
}
