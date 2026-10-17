// Nightly balance proof (T-0203, ledger invariant 2; THR-03 control). Runs at 02:30 IL before the
// reconciliation job. Compares ops.account_balance with the sum of ledger.posting per account,
// checks system totals per currency and per-journal balance, and opens an ops case per break.
// It never "fixes" anything: corrections are reversing journals with two-person approval.
import { uuidv7, type Currency } from '@kesher/domain';
import type { Database } from '@kesher/api/db';

export interface BalanceBreak {
  accountId: string;
  cachedMinor: bigint;
  postedMinor: bigint;
  deltaMinor: bigint;
}

export interface ProofReport {
  ranAt: string;
  ok: boolean;
  accountsChecked: number;
  breaks: BalanceBreak[];
  systemTotals: Map<Currency, bigint>;
  unbalancedJournals: string[];
}

export class BalanceProof {
  constructor(private readonly db: Database) {}

  async run(now: Date): Promise<ProofReport> {
    const drift = await this.db.query<{ account_id: string; cached: string; posted: string }>(
      `select b.account_id, b.balance_minor::text as cached, coalesce(p.s, 0)::text as posted
         from ops.account_balance b
         left join (select account_id, sum(amount_minor) as s from ledger.posting group by account_id) p using (account_id)
        where b.balance_minor <> coalesce(p.s, 0)
        order by b.account_id`,
    );
    const breaks: BalanceBreak[] = drift.rows.map((r) => ({ accountId: r.account_id, cachedMinor: BigInt(r.cached), postedMinor: BigInt(r.posted), deltaMinor: BigInt(r.cached) - BigInt(r.posted) }));

    const counted = await this.db.query<{ n: number }>('select count(*)::int as n from ops.account_balance');
    const totals = await this.db.query<{ currency: Currency; total: string }>('select currency, coalesce(sum(amount_minor), 0)::text as total from ledger.posting group by currency');
    const systemTotals = new Map<Currency, bigint>(totals.rows.map((t) => [t.currency, BigInt(t.total)]));
    const unbalanced = await this.db.query<{ journal_id: string }>('select journal_id from ledger.posting group by journal_id, currency having sum(amount_minor) <> 0');
    const unbalancedJournals = [...new Set(unbalanced.rows.map((u) => u.journal_id))];

    const night = now.toISOString().slice(0, 10);
    for (const b of breaks) await this.openCase(now, 'balance_break', `balance_break:${b.accountId}:${night}`, { accountId: b.accountId, cachedMinor: b.cachedMinor.toString(), postedMinor: b.postedMinor.toString(), deltaMinor: b.deltaMinor.toString() });
    for (const [currency, total] of systemTotals) if (total !== 0n) await this.openCase(now, 'system_total_break', `system_total:${currency}:${night}`, { currency, totalMinor: total.toString() });
    for (const j of unbalancedJournals) await this.openCase(now, 'unbalanced_journal', `unbalanced:${j}`, { journalId: j });

    const ok = breaks.length === 0 && unbalancedJournals.length === 0 && [...systemTotals.values()].every((t) => t === 0n);
    return { ranAt: now.toISOString(), ok, accountsChecked: counted.rows[0]?.n ?? 0, breaks, systemTotals, unbalancedJournals };
  }

  /** One case per dedupe key; re-runs the same night do not duplicate. */
  private async openCase(now: Date, kind: string, dedupeKey: string, payload: Record<string, string>): Promise<void> {
    await this.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at)
       values ($1, $2, $3, 'high', 'open', $4, $5)
       on conflict (dedupe_key) do nothing`,
      [uuidv7(now), kind, dedupeKey, JSON.stringify(payload), now],
    );
  }
}

/**
 * Rebuilds ops.account_balance from postings. Only the restore runbook (RUN-08) runs this, under
 * club_migrator, with money flags off. Returns the number of rows rewritten.
 */
export async function rebuildBalanceCache(db: Database): Promise<number> {
  const r = await db.query(
    `insert into ops.account_balance (account_id, balance_minor, last_posting_id, version)
     select a.id, coalesce(p.s, 0), coalesce(p.last_id, 0), coalesce(b.version, 0) + 1
       from ledger.account a
       left join (select account_id, sum(amount_minor) as s, max(id) as last_id from ledger.posting group by account_id) p on p.account_id = a.id
       left join ops.account_balance b on b.account_id = a.id
     on conflict (account_id) do update
       set balance_minor = excluded.balance_minor, last_posting_id = excluded.last_posting_id, version = excluded.version`,
  );
  return r.rowCount;
}
