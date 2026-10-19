// Transaction monitoring job (T-0909, REQ-CMP-001). Reads the last day of member movements from
// ops.transfer, runs the v1 rules and opens one ops.case per finding for the compliance console
// (/admin/alerts, T-0908). Dedupe is threefold: the finding's key (anchored on the pattern's first
// transfer) stops a re-run from opening the same case twice; a case for the same party and rule that
// already covers any of the finding's transfers, decided or not, means the pattern has been seen (the
// anchor shifts as the lookback window slides past the first transfer, the transfers do not); and an
// undecided case for the same party and rule suppresses a new one until compliance records a
// disposition. The job never moves money and never reads a note: a case payload is ids, counts,
// amounts and times.
import { money, uuidv7, type Currency } from '@kesher/domain';
import type { FeatureFlags } from '@kesher/api/billing/capabilities';
import type { Database } from '@kesher/api/db';
import { evaluate, lookbackMs, THRESHOLDS, type Finding, type Movement, type MovementKind, type Thresholds } from './rules.ts';

export const MONITORING_FLAG = 'monitoring.rules';

export type Outcome = 'opened' | 'duplicate' | 'suppressed';

export interface MonitoringReport {
  ranAt: string;
  /** Movements from here to ranAt were read. */
  windowStart: string;
  movements: number;
  findings: number;
  opened: number;
  duplicate: number;
  suppressed: number;
  /** Set when the flag is off: nothing was read or written. */
  skipped?: 'flag_off';
  durationMs: number;
}

interface Row {
  id: string;
  kind: MovementKind;
  from_party_id: string | null;
  to_party_id: string | null;
  amount_minor: string;
  currency: Currency;
  created_at: string | Date;
}

export class MonitoringJob {
  private readonly db: Database;
  private readonly flags: FeatureFlags;
  private readonly clock: () => Date;
  private readonly thresholds: Thresholds;
  constructor(
    db: Database,
    flags: FeatureFlags,
    clock: () => Date,
    thresholds: Thresholds = THRESHOLDS,
  ) {
    this.db = db;
    this.flags = flags;
    this.clock = clock;
    this.thresholds = thresholds;
  }

  async run(): Promise<MonitoringReport> {
    const now = this.clock();
    const started = Date.now();
    const windowStart = new Date(now.getTime() - lookbackMs(this.thresholds));
    const base = { ranAt: now.toISOString(), windowStart: windowStart.toISOString(), movements: 0, findings: 0, opened: 0, duplicate: 0, suppressed: 0 };
    if (!(await this.flags.isOn(MONITORING_FLAG))) return { ...base, skipped: 'flag_off', durationMs: Date.now() - started };
    const movements = await this.load(windowStart, now);
    const findings = evaluate(movements, this.thresholds);
    const report = { ...base, movements: movements.length, findings: findings.length };
    for (const f of findings) report[await this.open(f, now)]++;
    return { ...report, durationMs: Date.now() - started };
  }

  /** Every p2p and payout attempt in the window, whatever became of it: a declined send is still a pattern. */
  private async load(from: Date, to: Date): Promise<Movement[]> {
    const r = await this.db.query<Row>(
      `select id, kind, from_party_id, to_party_id, amount_minor::text, currency, created_at
         from ops.transfer where kind in ('p2p', 'payout') and created_at >= $1 and created_at <= $2
        order by created_at, id`,
      [from, to],
    );
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, fromPartyId: x.from_party_id ?? undefined, toPartyId: x.to_party_id ?? undefined, amount: money(BigInt(x.amount_minor), x.currency), at: new Date(x.created_at) }));
  }

  private async open(f: Finding, now: Date): Promise<Outcome> {
    const covered = await this.db.query<{ id: string }>(
      `select id from ops.case where kind = $1 and payload->>'rule' = $2 and payload->>'partyId' = $3 and payload->'transferIds' ?| $4::text[] limit 1`,
      [f.caseKind, f.rule, f.partyId, f.transferIds],
    );
    if (covered.rows[0]) return 'duplicate';
    const undecided = await this.db.query<{ id: string }>(
      `select id from ops.case where kind = $1 and payload->>'rule' = $2 and payload->>'partyId' = $3
          and (disposition is null or disposition = 'in_review') and status in ('open', 'investigating') limit 1`,
      [f.caseKind, f.rule, f.partyId],
    );
    if (undecided.rows[0]) return 'suppressed';
    const payload = {
      rule: f.rule,
      partyId: f.partyId,
      currency: f.currency,
      count: f.count,
      counterparties: f.counterparties,
      totalMinor: f.total.minor.toString(),
      windowStart: f.window.start.toISOString(),
      windowEnd: f.window.end.toISOString(),
      transferIds: f.transferIds,
      summary: f.summary,
    };
    const inserted = await this.db.query<{ id: string }>(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, $2, $3, $4, 'open', $5, $6)
       on conflict (dedupe_key) do nothing returning id`,
      [uuidv7(now), f.caseKind, f.dedupeKey, f.severity, JSON.stringify(payload), now],
    );
    return inserted.rows[0] ? 'opened' : 'duplicate';
  }
}
