// Entitlement credit at checkout (T-0711, REQ-ESIM-002): the monthly data credit applies
// automatically. Given a 5 GB credit, buying 5 GB costs $0. Partial credits cover the matching
// share; the remainder is charged. Consumption is idempotent on the order id.
import { money, type Money } from '@kesher/domain';
import type { EntitlementService, MembershipRef } from '../billing/entitlements.ts';

export interface CreditQuote {
  listPrice: Money;
  credit: Money;
  price: Money;
  /** Units the credit would consume (e.g. GB). */
  units: bigint;
  entitlementKey?: string;
}

export const ENTITLEMENT_BY_KIND: Readonly<Record<string, { key: string; attribute: string }>> = {
  esim: { key: 'esim.dataGb', attribute: 'dataGb' },
  concierge: { key: 'concierge.calls', attribute: 'calls' },
};

export class CreditService {
  constructor(private readonly entitlements: EntitlementService) {}

  /** What the member would pay now, without consuming anything. */
  async quote(m: MembershipRef | undefined, item: { kind: string; attributes: Record<string, unknown>; price: Money }, quantity: number, at: Date): Promise<CreditQuote> {
    const listPrice = money(item.price.minor * BigInt(quantity), item.price.currency);
    const ent = ENTITLEMENT_BY_KIND[item.kind];
    const unitsPerItem = BigInt(Number(item.attributes[ent?.attribute ?? ''] ?? 0) | 0);
    if (!m || !ent || unitsPerItem <= 0n) return { listPrice, credit: money(0n, listPrice.currency), price: listPrice, units: 0n };
    const decision = await this.entitlements.can(m, ent.key, unitsPerItem * BigInt(quantity), at);
    const units = unitsPerItem * BigInt(quantity);
    const covered = decision.remaining >= units ? units : decision.remaining;
    // Credit covers the same share of the price as of the units.
    const credit = covered <= 0n ? 0n : (listPrice.minor * covered) / units;
    return { listPrice, credit: money(credit, listPrice.currency), price: money(listPrice.minor - credit, listPrice.currency), units: covered, entitlementKey: ent.key };
  }

  /** Locks the credit in for an order (idempotent by order id). Returns the quote actually applied. */
  async apply(m: MembershipRef | undefined, item: { kind: string; attributes: Record<string, unknown>; price: Money }, quantity: number, orderId: string, at: Date): Promise<CreditQuote> {
    const q = await this.quote(m, item, quantity, at);
    if (m && q.entitlementKey && q.units > 0n) await this.entitlements.consume(m, q.entitlementKey, q.units, `addon:${orderId}`, at);
    return q;
  }
}
