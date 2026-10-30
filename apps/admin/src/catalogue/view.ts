// A05 Catalogue and pricing (T-0929, REQ-MKT-002, REQ-ADM-003): what the price-rule screen decides, apart from
// rendering. Finance types a margin as a percentage and a floor in major units; they leave as basis points and
// minor units (bigint). The proposer of a rule is never offered Approve or Reject; support reads and changes
// nothing. The worked price is the API's own formula (apps/api/src/addons/pricing.ts), shown so a reviewer sees
// what a rule does to a real cost before approving it; view.test.ts pins it to the API's example.
import { applyBps, money, type Currency, type Money } from '@kesher/domain';
import type { AdminActor, PriceRuleInput, PriceRuleKind, PriceRuleRow } from '../data/types.ts';

export const KINDS: readonly { kind: PriceRuleKind; label: string }[] = [
  { kind: 'esim', label: 'eSIM' },
  { kind: 'insurance', label: 'Insurance' },
  { kind: 'concierge', label: 'Concierge' },
];

export type RuleProblem = 'kind' | 'provider' | 'pattern' | 'margin' | 'floor' | 'priority' | 'reason';

const PROBLEM_WORDS: Record<RuleProblem, string> = {
  kind: 'Choose what the rule prices: eSIM, insurance or concierge.',
  provider: 'Enter the provider key as the catalogue names it, like simulator or airalo.',
  pattern: 'Enter a valid pattern over the vendor SKU, up to 120 characters, or leave it empty for all.',
  margin: 'Enter a margin from 0 to 200 percent, with at most two decimals, like 25 or 12.5.',
  floor: 'Enter a floor of 0 or more, up to 10,000.00, like 4.99.',
  priority: 'Enter a priority from 1 to 1000; the lowest number among matching rules wins.',
  reason: 'Say why, up to 500 characters: the second approver and the audit log read it.',
};
export const problemWords = (p: RuleProblem): string => PROBLEM_WORDS[p];

/** "25" or "12.5" percent → 2500 or 1250 basis points; undefined outside 0–200%. */
export function percentToBps(text: string): number | undefined {
  const t = text.trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole, frac = ''] = t.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return bps <= 20_000 ? bps : undefined;
}

/** "4.99" → 499n; "0" is a floor too. Undefined above 10,000.00 or with more than two decimals. */
function floorMinor(text: string): bigint | undefined {
  const t = text.replace(/[,\s₪$]/g, '') || '0';
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole, frac = ''] = t.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return minor <= 1_000_000n ? minor : undefined;
}

/** The propose form, checked before any call: everything the API would refuse for shape is refused here first. */
export function parseRuleForm(f: Partial<Record<'kind' | 'provider' | 'skuPattern' | 'margin' | 'floor' | 'currency' | 'roundTo99' | 'priority' | 'reason', string | undefined>>): { ok: true; input: PriceRuleInput } | { ok: false; problems: RuleProblem[] } {
  const problems: RuleProblem[] = [];
  const kind = KINDS.find((k) => k.kind === f.kind)?.kind;
  if (!kind) problems.push('kind');
  const provider = (f.provider ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(provider)) problems.push('provider');
  const skuPattern = (f.skuPattern ?? '').trim() || '.*';
  let validPattern = skuPattern.length <= 120;
  try {
    new RegExp(skuPattern);
  } catch {
    validPattern = false;
  }
  if (!validPattern) problems.push('pattern');
  const marginBps = percentToBps(f.margin ?? '');
  if (marginBps === undefined) problems.push('margin');
  const currency: Currency | undefined = f.currency === 'ILS' || f.currency === 'USD' ? f.currency : undefined;
  const floor = floorMinor(f.floor ?? '');
  if (floor === undefined || !currency) problems.push('floor');
  const priority = Number(f.priority ?? '100');
  if (!Number.isInteger(priority) || priority < 1 || priority > 1000) problems.push('priority');
  const reason = (f.reason ?? '').trim();
  if (!reason || reason.length > 500) problems.push('reason');
  if (problems.length || !kind || marginBps === undefined || floor === undefined || !currency) return { ok: false, problems };
  return { ok: true, input: { kind, provider, skuPattern, marginBps, floor: money(floor, currency), roundTo99: f.roundTo99 === 'on' || f.roundTo99 === 'true', priority, reason } };
}

/** Rounds up to the next amount ending in 99 minor units, leaving an exact .99 alone (as the API does). */
function roundUpTo99(minor: bigint): bigint {
  if (minor <= 0n) return 99n;
  const r = minor % 100n;
  return r === 99n ? minor : minor - r + 99n;
}

/** What the rule charges for a vendor cost: max(floor, cost × (1 + margin)), then .99 rounding when asked. */
export function workedPrice(rule: Pick<PriceRuleRow, 'marginBps' | 'floor' | 'roundTo99'>, cost: Money): Money {
  const withMargin = cost.minor + applyBps(cost, BigInt(rule.marginBps)).minor;
  const floored = withMargin < rule.floor.minor ? rule.floor.minor : withMargin;
  return money(rule.roundTo99 ? roundUpTo99(floored) : floored, cost.currency);
}

export const isFinance = (actor: AdminActor): boolean => actor.roles.includes('finance');

/** Approve and Reject are for a different finance member, on a rule still proposed. */
export const canDecide = (r: PriceRuleRow, actor: AdminActor): boolean => r.state === 'proposed' && r.proposedBy !== actor.subject && isFinance(actor);

export const ruleProblem = (v: string | undefined): RuleProblem | undefined => (v && v in PROBLEM_WORDS ? (v as RuleProblem) : undefined);

/** An API refusal, in words; the route puts the code on the redirect. */
export function errorWords(code: string | undefined): string | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case 'SAME_APPROVER':
    case 'CONFLICT':
      return 'You proposed this rule, or it was already decided: a different finance member approves or rejects a proposal, once.';
    case 'FORBIDDEN':
      return 'Only Kesher finance can propose, approve or reject price rules.';
    case 'NOT_FOUND':
      return 'That rule was not found.';
    case 'INVALID':
      return 'The API refused the rule as written, or a rejection had no reason. Check the fields and try again.';
    default:
      return 'The API is unavailable right now. Nothing was changed.';
  }
}
