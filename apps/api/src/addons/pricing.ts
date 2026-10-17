// Price rules (REQ-MKT-002): prices come from rules, never from code or the catalogue by hand.
//   price = max(floor, cost × (1 + margin)) then rounded UP to the next .99 when the rule says so.
// Pure bigint arithmetic; shared by the catalogue sync (worker) and the API's quote path.
import { applyBps, money, type Money } from '@kesher/domain';

export interface PriceRule {
  id: string;
  kind: 'esim' | 'insurance' | 'concierge';
  provider: string;
  skuPattern: RegExp;
  marginBps: bigint;
  floor: Money;
  roundTo99: boolean;
  priority: number;
}

/** Rounds up to the next amount ending in 99 minor units (…$X.99), leaving an exact .99 unchanged. */
export function roundUpTo99(minor: bigint): bigint {
  if (minor <= 0n) return 99n;
  const r = minor % 100n;
  return r === 99n ? minor : minor - r + 99n + (r > 99n ? 100n : 0n);
}

export function applyRule(cost: Money, rule: PriceRule): Money {
  const withMargin = cost.minor + applyBps(cost, rule.marginBps).minor;
  const floored = withMargin < rule.floor.minor ? rule.floor.minor : withMargin;
  return money(rule.roundTo99 ? roundUpTo99(floored) : floored, cost.currency);
}

/** Lowest priority number wins among rules matching kind, provider and sku. */
export function pickRule(rules: readonly PriceRule[], kind: PriceRule['kind'], provider: string, vendorSku: string): PriceRule | undefined {
  return [...rules].filter((r) => r.kind === kind && r.provider === provider && r.skuPattern.test(vendorSku)).sort((a, b) => a.priority - b.priority)[0];
}

export function priceFor(rules: readonly PriceRule[], kind: PriceRule['kind'], provider: string, vendorSku: string, cost: Money): { price: Money; rule: PriceRule } | undefined {
  const rule = pickRule(rules, kind, provider, vendorSku);
  return rule ? { price: applyRule(cost, rule), rule } : undefined;
}
