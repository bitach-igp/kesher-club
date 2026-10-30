// A13 Plans (T-0933, REQ-ADM-006): what the plan screen decides, apart from rendering. Finance types a price in major
// units of the market's own currency (IL in shekels, US in dollars) and it leaves as minor units (bigint); the
// worked monthly price is shown in both the English and the Hebrew format, the way members will read it. The proposer
// of a version is never offered Approve or Reject; support reads and changes nothing. Versions are never edited: a
// newer one supersedes the older for new members, so the screen groups them by plan, newest first.
import { format, money, type Currency, type Money } from '@kesher/domain';
import type { Market } from '@kesher/ports';
import type { AdminActor, PlanEntitlement, PlanVersionInput, PlanVersionRow } from '../data/types.ts';

export const MARKETS: readonly { market: Market; currency: Currency; label: string }[] = [
  { market: 'IL', currency: 'ILS', label: 'Israel, in shekels' },
  { market: 'US', currency: 'USD', label: 'United States, in dollars' },
];

export type PlanProblem = 'code' | 'name' | 'market' | 'price' | 'term' | 'data' | 'calls' | 'fx' | 'date' | 'reason';

const PROBLEM_WORDS: Record<PlanProblem, string> = {
  code: 'Enter a plan code of 2 to 40 lower-case letters, digits and dashes, starting with a letter, like club-il.',
  name: 'Enter the plan name members see, up to 80 characters.',
  market: 'Choose the market: Israel prices in shekels, the United States in dollars.',
  price: 'Enter the price for the whole term, above zero and at most 100,000.00, like 180.00.',
  term: 'Enter a term of 1 to 12 months.',
  data: 'Enter the eSIM data a month as a whole number of GB, or leave it empty.',
  calls: 'Enter the concierge calls a term as a whole number, or leave it empty.',
  fx: 'Enter the FX markup as a percentage from 0 to 100, with at most two decimals, like 0.75.',
  date: 'Enter the date it is offered from, or leave it empty to offer it once approved.',
  reason: 'Say why, up to 500 characters: the second approver and the audit log read it.',
};
export const problemWords = (p: PlanProblem): string => PROBLEM_WORDS[p];
export const planProblem = (v: string | undefined): PlanProblem | undefined => (v && v in PROBLEM_WORDS ? (v as PlanProblem) : undefined);

/** "180" or "1,800.50" → 18000n or 180050n; undefined unless above zero and at most 100,000.00 with two decimals. */
export function priceMinor(text: string): bigint | undefined {
  const t = text.replace(/[,\s₪$]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole, frac = ''] = t.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return minor > 0n && minor <= 10_000_000n ? minor : undefined;
}

/** "0.75" percent → 75 basis points; undefined outside 0–100%. */
function percentToBps(text: string): number | undefined {
  const t = text.trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole, frac = ''] = t.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return bps <= 10_000 ? bps : undefined;
}

/** An optional whole number of at most 9 digits: undefined when empty, null when not a whole number. */
const wholeOrEmpty = (text: string | undefined): string | undefined | null => {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  return /^\d{1,9}$/.test(t) ? String(Number(t)) : null;
};

type FormField = 'planCode' | 'name' | 'market' | 'price' | 'termMonths' | 'dataGb' | 'conciergeCalls' | 'fxMarkup' | 'effectiveFrom' | 'reason';

/** The propose form, checked before any call: everything the API would refuse for shape is refused here first. */
export function parsePlanForm(f: Partial<Record<FormField, string | undefined>>): { ok: true; input: PlanVersionInput } | { ok: false; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const planCode = (f.planCode ?? '').trim();
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(planCode)) problems.push('code');
  const name = (f.name ?? '').trim();
  if (!name || name.length > 80) problems.push('name');
  const market = MARKETS.find((m) => m.market === f.market);
  if (!market) problems.push('market');
  const minor = priceMinor(f.price ?? '');
  if (minor === undefined) problems.push('price');
  const termMonths = Number(f.termMonths ?? '');
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 12) problems.push('term');
  const dataGb = wholeOrEmpty(f.dataGb);
  if (dataGb === null) problems.push('data');
  const calls = wholeOrEmpty(f.conciergeCalls);
  if (calls === null) problems.push('calls');
  const fxMarkupBps = percentToBps(f.fxMarkup?.trim() || '0.75');
  if (fxMarkupBps === undefined) problems.push('fx');
  const date = (f.effectiveFrom ?? '').trim();
  const validDate = !date || (/^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date);
  if (!validDate) problems.push('date');
  const reason = (f.reason ?? '').trim();
  if (!reason || reason.length > 500) problems.push('reason');
  if (problems.length || !market || minor === undefined || fxMarkupBps === undefined) return { ok: false, problems };
  const entitlements: Record<string, PlanEntitlement> = {
    ...(dataGb ? { 'esim.dataGb': { limit: dataGb, unit: 'gb', period: 'month' } } : {}),
    ...(calls ? { 'concierge.calls': { limit: calls, unit: 'calls', period: 'term' } } : {}),
  };
  return { ok: true, input: { planCode, name, market: market.market, price: money(minor, market.currency), termMonths, entitlements, fxMarkupBps, ...(date ? { effectiveFrom: `${date}T00:00:00Z` } : {}), reason } };
}

/** The term's price a month, rounded up to the minor unit so twelve payments never fall short of the price. */
export function monthlyPrice(price: Money, termMonths: number): Money {
  const months = BigInt(termMonths);
  return money((price.minor + months - 1n) / months, price.currency);
}

/** "₪18.00 a month · 18.00 ₪ לחודש": the worked monthly price in the English and the Hebrew format. */
export const workedMonthly = (price: Money, termMonths: number): { en: string; he: string } => {
  const m = monthlyPrice(price, termMonths);
  return { en: `${format(m, 'en-US')} a month`, he: `${format(m, 'he-IL')} לחודש` };
};

export const isFinance = (actor: AdminActor): boolean => actor.roles.includes('finance');

/** Approve and Reject are for a different finance member, on a version still proposed. */
export const canDecide = (v: PlanVersionRow, actor: AdminActor): boolean => v.state === 'proposed' && v.proposedBy !== actor.subject && isFinance(actor);

/** The versions by plan, plans in code order, each plan's versions newest first. */
export function byPlan(versions: readonly PlanVersionRow[]): { planCode: string; name: string; market?: Market | undefined; versions: PlanVersionRow[] }[] {
  const codes = [...new Set(versions.map((v) => v.planCode))].sort();
  return codes.map((planCode) => {
    const mine = versions.filter((v) => v.planCode === planCode).sort((a, b) => b.version - a.version);
    return { planCode, name: mine[0]!.name, market: mine.find((v) => v.market)?.market, versions: mine };
  });
}

/** One version in a URL segment, "club-il:2", and back; a code never holds a colon. */
export const versionKey = (v: Pick<PlanVersionRow, 'planCode' | 'version'>): string => `${v.planCode}:${v.version}`;
export function parseVersionKey(key: string): { planCode: string; version: number } | undefined {
  const m = /^([a-z][a-z0-9-]{1,39}):(\d{1,6})$/.exec(key);
  return m && Number(m[2]) >= 1 ? { planCode: m[1]!, version: Number(m[2]) } : undefined;
}

/** What a version's state means for members, in words. */
export function stateWords(v: PlanVersionRow): string {
  if (v.state === 'proposed') return 'Waiting for a second finance approver; no one joins on it yet.';
  if (v.state === 'rejected') return 'Rejected: never offered.';
  return v.offered ? 'Offered: new members join on this version.' : 'Approved; members who joined on it keep it. New members join on a later one, or join on this one from its date.';
}

/** An API refusal, in words; the route puts the code on the redirect. */
export function errorWords(code: string | undefined): string | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case 'SAME_APPROVER':
    case 'CONFLICT':
      return 'You proposed this version, or it was already decided: a different finance member approves or rejects a proposal, once.';
    case 'FORBIDDEN':
      return 'Only Kesher finance can propose, approve or reject plan versions.';
    case 'NOT_FOUND':
      return 'That plan version was not found.';
    case 'INVALID':
      return 'The API refused the version as written, or a rejection had no reason. Check the fields and try again.';
    default:
      return 'The API is unavailable right now. Nothing was changed.';
  }
}
