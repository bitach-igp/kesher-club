// The partner statement for the nightly reconciliation, read from the funding vendor (T-0683, REQ-LED-004).
// `FundingStatementSource` pages through the funding port's settled charges and refunds for the Asia/Jerusalem
// business day of `runDate` and hands them to `ReconJob` as `PartnerTransaction`s: a charge is keyed by its loadId and
// a refund by its refundId (the ids `ops.external_ref` records), a charge is positive and a refund negative.
// The list is all-or-nothing: a vendor failure on any page throws and nothing is returned, so a half-read statement
// can never be mistaken for a complete one (it would open a `missing_partner` break per unread row). Payouts are not
// part of the funding vendor's statement (they are PayoutPort's) and card-processor and bank-feed partners have no
// vendor yet, so `fetch` refuses any provider this source was not built for rather than answering an empty list.
import { money, type Money } from '@kesher/domain';
import { FundingError, type FundingStatementPort, type SettledEntry } from '@kesher/ports';
import { ISRAEL_TZ } from '../scheduler.ts';
import type { PartnerTransaction, StatementSource } from './recon.ts';

const PAGE_SIZE = 100;
/** A runaway cursor (a vendor that never stops saying "more") ends as an outage, not an endless loop. */
const MAX_PAGES = 10_000;

const wallClock = new Intl.DateTimeFormat('en-CA', { timeZone: ISRAEL_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Milliseconds Asia/Jerusalem is ahead of UTC at the instant `at` (3 600 000 x 2 in winter, x 3 in summer). */
function offsetMs(at: Date): number {
  const p = Object.fromEntries(wallClock.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Local midnight of `day` (`YYYY-MM-DD`) in Asia/Jerusalem, as an instant. Two passes settle the offset on a DST change day. */
function localMidnight(day: string): Date {
  const wall = Date.parse(`${day}T00:00:00Z`);
  const first = new Date(wall - offsetMs(new Date(wall)));
  return new Date(wall - offsetMs(first));
}

/** `[from, to)` instants of the Asia/Jerusalem calendar day `runDate`. */
export function businessDayWindow(runDate: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || Number.isNaN(Date.parse(`${runDate}T00:00:00Z`)) || new Date(`${runDate}T00:00:00Z`).toISOString().slice(0, 10) !== runDate) {
    throw new FundingError('VALIDATION_FAILED', `Not a calendar date: ${runDate}`);
  }
  const next = new Date(Date.parse(`${runDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { from: localMidnight(runDate), to: localMidnight(next) };
}

export interface FundingStatementSourceOptions {
  /** The provider name `ReconJob` asks for, the key space of `ops.external_ref` (for example `stripe`). */
  provider: string;
  port: FundingStatementPort;
  pageSize?: number;
}

export class FundingStatementSource implements StatementSource {
  private readonly provider: string;
  private readonly port: FundingStatementPort;
  private readonly pageSize: number;

  constructor(opts: FundingStatementSourceOptions) {
    this.provider = opts.provider;
    this.port = opts.port;
    this.pageSize = opts.pageSize ?? PAGE_SIZE;
  }

  async fetch(provider: string, forDate: string): Promise<readonly PartnerTransaction[]> {
    if (provider !== this.provider) throw new FundingError('VALIDATION_FAILED', `No statement source for provider ${provider}`);
    const { from, to } = businessDayWindow(forDate);
    const out: PartnerTransaction[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new FundingError('PROVIDER_UNAVAILABLE', 'Statement listing did not end');
      const res = await this.port.listSettled({ from: from.toISOString(), to: to.toISOString(), limit: this.pageSize, ...(cursor ? { cursor } : {}) });
      for (const e of res.entries) {
        const key = `${e.kind}:${e.id}`;
        // A vendor that repeats a row across pages would double the partner side; the statement is not trustworthy then.
        if (seen.has(key)) throw new FundingError('PROVIDER_UNAVAILABLE', `Statement listing repeated ${key}`);
        seen.add(key);
        out.push(toTransaction(provider, e));
      }
      if (!res.nextCursor) return out;
      cursor = res.nextCursor;
    }
  }
}

function toTransaction(provider: string, e: SettledEntry): PartnerTransaction {
  const amount: Money = e.kind === 'refund' ? money(-e.amount.minor, e.amount.currency) : e.amount;
  return { provider, externalId: e.id, amount, type: e.kind };
}
