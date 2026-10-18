// Transaction monitoring rules v1 (T-0909, REQ-CMP-001). Pure functions over a window of movements:
// structuring (many sends each kept just under the P2P hold line), velocity (too many or too much
// out of one purse in a day) and fan-in / fan-out (one party facing many counterparties in a day).
// A finding names the party, the rule, the window and the transfer ids and carries a dedupe key
// anchored on the first transfer of the pattern, so the same data always yields the same key and a
// re-run opens nothing twice. Member notes never reach a rule: a movement is ids, kind, amount, time.
import { format, money, type Currency, type Money } from '@kesher/domain';
import { HOLD_THRESHOLD_MINOR } from '@kesher/api/p2p/holds';

export type RuleKind = 'structuring' | 'velocity' | 'fan_in' | 'fan_out';
/** The ops.case kind the console lists a finding under (ALERT_KINDS): fan-in and fan-out are velocity cases with the rule in the payload. */
export type CaseKind = 'structuring' | 'velocity';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type MovementKind = 'p2p' | 'load' | 'payout' | 'fx' | 'allowance' | 'addon' | 'refund';

export interface Movement {
  id: string;
  kind: MovementKind;
  fromPartyId?: string | undefined;
  toPartyId?: string | undefined;
  amount: Money;
  at: Date;
}

export interface Finding {
  rule: RuleKind;
  caseKind: CaseKind;
  severity: Severity;
  partyId: string;
  currency: Currency;
  count: number;
  total: Money;
  /** Distinct counterparties in the window (fan-in: senders, fan-out: recipients). */
  counterparties: number;
  window: { start: Date; end: Date };
  /** In time order; the first is the anchor of the dedupe key. */
  transferIds: string[];
  summary: string;
  dedupeKey: string;
}

export interface Thresholds {
  structuring: {
    windowMs: number;
    minCount: number;
    /** Per currency, the line a structured send stays under: the P2P hold threshold. */
    line: Readonly<Record<Currency, bigint>>;
    /** A send counts as "just under" from this share of the line (basis points) up to, not including, the line. */
    nearBps: bigint;
  };
  velocity: { windowMs: number; maxCount: number; maxTotalMinor: Readonly<Record<Currency, bigint>> };
  fanIn: { windowMs: number; minSenders: number };
  fanOut: { windowMs: number; minRecipients: number };
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** v1 thresholds (apps/worker/README.md); compliance tunes them here, not in the job. */
export const THRESHOLDS: Thresholds = {
  structuring: { windowMs: HOUR, minCount: 10, line: HOLD_THRESHOLD_MINOR, nearBps: 8_000n },
  velocity: { windowMs: DAY, maxCount: 25, maxTotalMinor: { ILS: 2_000_000n, USD: 600_000n } },
  fanIn: { windowMs: DAY, minSenders: 10 },
  fanOut: { windowMs: DAY, minRecipients: 10 },
};

/** The longest window any rule looks back over; the job loads at least this much. */
export const lookbackMs = (t: Thresholds = THRESHOLDS): number => Math.max(t.structuring.windowMs, t.velocity.windowMs, t.fanIn.windowMs, t.fanOut.windowMs);

/** Money leaving a member's purse by their own hand. Loads come in, allowances are the institution's. */
const OUTGOING: ReadonlySet<MovementKind> = new Set(['p2p', 'payout']);

const byTime = (a: Movement, b: Movement): number => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const sum = (ms: readonly Movement[]): bigint => ms.reduce((acc, m) => acc + m.amount.minor, 0n);

const distinct = (ms: readonly Movement[], side: 'fromPartyId' | 'toPartyId'): number => new Set(ms.map((m) => m[side]).filter((x): x is string => typeof x === 'string')).size;

const minutes = (ms: number): string => (ms % HOUR === 0 ? `${ms / HOUR} hour${ms === HOUR ? '' : 's'}` : `${Math.round(ms / 60_000)} minutes`);

/**
 * Slides a window over one party's movements (already sorted) and emits a finding for each
 * non-overlapping window the predicate accepts, anchored on the window's first movement. After a hit
 * the scan resumes past the window, so one burst is one finding however many ways it could be cut.
 */
function slide(sorted: readonly Movement[], windowMs: number, accept: (win: readonly Movement[]) => boolean, emit: (win: readonly Movement[]) => Finding): Finding[] {
  const out: Finding[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!.at.getTime();
    let j = i;
    while (j < sorted.length && sorted[j]!.at.getTime() - start <= windowMs) j++;
    const win = sorted.slice(i, j);
    if (accept(win)) {
      out.push(emit(win));
      i = j;
    } else i++;
  }
  return out;
}

function group(ms: readonly Movement[], side: 'fromPartyId' | 'toPartyId', keep: (m: Movement) => boolean): Map<string, Movement[]> {
  const groups = new Map<string, Movement[]>();
  for (const m of ms) {
    const party = m[side];
    if (!party || !keep(m)) continue;
    const key = `${party}\u0000${m.amount.currency}`;
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  for (const g of groups.values()) g.sort(byTime);
  return groups;
}

const finding = (rule: RuleKind, caseKind: CaseKind, severity: Severity, partyId: string, win: readonly Movement[], windowMs: number, counterparties: number, summary: string): Finding => {
  const first = win[0]!;
  const currency = first.amount.currency;
  return {
    rule,
    caseKind,
    severity,
    partyId,
    currency,
    count: win.length,
    total: money(sum(win), currency),
    counterparties,
    window: { start: first.at, end: new Date(first.at.getTime() + windowMs) },
    transferIds: win.map((m) => m.id),
    summary,
    dedupeKey: `${rule}:${partyId}:${currency}:${first.id}`,
  };
};

/** Ten or more sends in an hour, each between 80 % of the hold line and the line itself (REQ-CMP-001, TST-CMP-001). */
export function structuring(ms: readonly Movement[], t: Thresholds = THRESHOLDS): Finding[] {
  const out: Finding[] = [];
  const near = (m: Movement): boolean => {
    const line = t.structuring.line[m.amount.currency];
    return m.kind === 'p2p' && m.amount.minor < line && m.amount.minor * 10_000n >= line * t.structuring.nearBps;
  };
  for (const [key, sorted] of group(ms, 'fromPartyId', near)) {
    const partyId = key.slice(0, key.indexOf('\u0000'));
    out.push(
      ...slide(
        sorted,
        t.structuring.windowMs,
        (win) => win.length >= t.structuring.minCount,
        (win) => {
          const currency = win[0]!.amount.currency;
          const amounts = new Set(win.map((m) => m.amount.minor));
          const each = amounts.size === 1 ? ` of ${format(money(win[0]!.amount.minor, currency))}` : '';
          const summary = `${win.length} sends${each} (${format(money(sum(win), currency))} in all) within ${minutes(t.structuring.windowMs)}, each just under the ${format(money(t.structuring.line[currency], currency))} hold line`;
          return finding('structuring', 'structuring', 'high', partyId, win, t.structuring.windowMs, distinct(win, 'toPartyId'), summary);
        },
      ),
    );
  }
  return out;
}

/** Too many outgoing movements, or too much money out, from one purse in a day. Both at once is high. */
export function velocity(ms: readonly Movement[], t: Thresholds = THRESHOLDS): Finding[] {
  const out: Finding[] = [];
  for (const [key, sorted] of group(ms, 'fromPartyId', (m) => OUTGOING.has(m.kind))) {
    const partyId = key.slice(0, key.indexOf('\u0000'));
    const over = (win: readonly Movement[]): { count: boolean; total: boolean } => ({ count: win.length >= t.velocity.maxCount, total: sum(win) >= t.velocity.maxTotalMinor[win[0]!.amount.currency] });
    out.push(
      ...slide(
        sorted,
        t.velocity.windowMs,
        (win) => {
          const o = over(win);
          return o.count || o.total;
        },
        (win) => {
          const o = over(win);
          const currency = win[0]!.amount.currency;
          const what = o.count && o.total ? 'movements and amount' : o.count ? 'movements' : 'amount';
          const summary = `${win.length} outgoing movements, ${format(money(sum(win), currency))} in all, within ${minutes(t.velocity.windowMs)}: over the ${what} limit (${t.velocity.maxCount} or ${format(money(t.velocity.maxTotalMinor[currency], currency))})`;
          return finding('velocity', 'velocity', o.count && o.total ? 'high' : 'medium', partyId, win, t.velocity.windowMs, distinct(win, 'toPartyId'), summary);
        },
      ),
    );
  }
  return out;
}

/** One recipient, ten or more distinct senders in a day. */
export function fanIn(ms: readonly Movement[], t: Thresholds = THRESHOLDS): Finding[] {
  const out: Finding[] = [];
  for (const [key, sorted] of group(ms, 'toPartyId', (m) => m.kind === 'p2p' && typeof m.fromPartyId === 'string')) {
    const partyId = key.slice(0, key.indexOf('\u0000'));
    out.push(
      ...slide(
        sorted,
        t.fanIn.windowMs,
        (win) => distinct(win, 'fromPartyId') >= t.fanIn.minSenders,
        (win) => {
          const senders = distinct(win, 'fromPartyId');
          const summary = `received ${win.length} sends from ${senders} different members, ${format(money(sum(win), win[0]!.amount.currency))} in all, within ${minutes(t.fanIn.windowMs)}`;
          return finding('fan_in', 'velocity', 'medium', partyId, win, t.fanIn.windowMs, senders, summary);
        },
      ),
    );
  }
  return out;
}

/** One sender, ten or more distinct recipients in a day. */
export function fanOut(ms: readonly Movement[], t: Thresholds = THRESHOLDS): Finding[] {
  const out: Finding[] = [];
  for (const [key, sorted] of group(ms, 'fromPartyId', (m) => m.kind === 'p2p' && typeof m.toPartyId === 'string')) {
    const partyId = key.slice(0, key.indexOf('\u0000'));
    out.push(
      ...slide(
        sorted,
        t.fanOut.windowMs,
        (win) => distinct(win, 'toPartyId') >= t.fanOut.minRecipients,
        (win) => {
          const recipients = distinct(win, 'toPartyId');
          const summary = `sent ${win.length} times to ${recipients} different members, ${format(money(sum(win), win[0]!.amount.currency))} in all, within ${minutes(t.fanOut.windowMs)}`;
          return finding('fan_out', 'velocity', 'medium', partyId, win, t.fanOut.windowMs, recipients, summary);
        },
      ),
    );
  }
  return out;
}

/** Every rule over the same movements, in a stable order (rule, party, anchor). */
export function evaluate(ms: readonly Movement[], t: Thresholds = THRESHOLDS): Finding[] {
  return [...structuring(ms, t), ...velocity(ms, t), ...fanIn(ms, t), ...fanOut(ms, t)].sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0));
}
