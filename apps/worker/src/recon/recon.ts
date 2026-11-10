// Nightly reconciliation (T-0206, REQ-LED-004): match every partner transaction to a journal by
// external ref and open an ops case for any break before 06:00 Israel time. The partner's record
// is the system of record (constitution art. 2); our ledger is the shadow that must reach zero
// breaks. Breaks are never auto-corrected.
import { uuidv7, type Currency, type Money } from '@kesher/domain';
import type { Database } from '@kesher/api/db';
import { businessDayWindow } from './statement-source.ts';

export interface PartnerTransaction {
  provider: string;
  externalId: string;
  amount: Money;
  /** Partner's own type; informational. */
  type?: string;
}

/** Where partner records come from: a statement file, an API pull, or the simulator. */
export interface StatementSource {
  fetch(provider: string, forDate: string): Promise<readonly PartnerTransaction[]>;
}

export type BreakReason = 'missing_journal' | 'missing_partner' | 'amount_mismatch' | 'currency_mismatch';

export interface ReconBreak {
  provider: string;
  externalId: string;
  journalId?: string;
  partner?: Money;
  ledger?: Money;
  reason: BreakReason;
}

export interface ReconReport {
  runDate: string;
  /** The business day reconciled; `runDate` unless the run reconciles an earlier day. */
  statementDate: string;
  provider: string;
  matched: number;
  breaks: ReconBreak[];
  startedAt: string;
  finishedAt: string;
  /** REQ-LED-004: cases must exist before 06:00 Israel time on the run date. */
  withinDeadline: boolean;
}

export const DEADLINE_IL = '06:00';

/** 06:00 Asia/Jerusalem on `runDate`, as an instant. */
export function deadlineFor(runDate: string): Date {
  // Israel is UTC+2 (IST) or UTC+3 (IDT); derive the offset from Intl so DST is right.
  const probe = new Date(`${runDate}T06:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(probe);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const offsetHours = hour - 6; // local hour when UTC is 06:00
  return new Date(probe.getTime() - offsetHours * 3_600_000);
}

export class ReconJob {
  private readonly db: Database;
  private readonly source: StatementSource;
  private readonly clock: () => Date;
  constructor(
    db: Database,
    source: StatementSource,
    clock: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.source = source;
    this.clock = clock;
  }

  /**
   * `runDate` is the Israel day the run happens on (the 06:00 deadline, the case keys); `statementDate` is the business day it
   * reconciles, `runDate` itself unless given. The nightly job runs at 05:30 and reconciles yesterday, so the two differ.
   */
  async run(provider: string, runDate: string, statementDate: string = runDate): Promise<ReconReport> {
    const startedAt = this.clock();
    const partnerTxns = await this.source.fetch(provider, statementDate);

    // Our side, from two writers of `ops.external_ref`:
    // - the funding flow (T-0684): a load is a `transfer` ref (the vendor's loadId) and a refund a `refund` ref (the vendor's refundId),
    //   each pointing at an `ops.transfer`; what we booked against the partner is the net of the transfer's postings on partner_settlement
    //   (+ for a charge, - for a refund; a held load whose hold was reversed nets to zero and is not ours). Only transfers with a journal
    //   on the Israel business day are expected on that day's statement, but a statement row we know from another day is still compared
    //   (a charge settling a minute either side of midnight is a match, not a pair of breaks);
    // - a `journal` ref pointing straight at a journal, whose positive postings are the amount (the original shape, kept for callers that write it).
    const { from, to } = businessDayWindow(statementDate);
    const ids = partnerTxns.map((t) => t.externalId);
    type Ours = { external_id: string; journal_id: string; currency: Currency; amount_minor: string; in_window: boolean };
    // Candidates first, so only the statement day's transfers (and the ones the statement names) are aggregated, never all history:
    // funding transfers only (a payout is also a `transfer` ref, under a provider name that may coincide), with a journal in the
    // window (found through ledger.journal_transfer_id_idx) or named by the statement.
    const funding = await this.db.query<Ours>(
      `with cand as (
         select r.external_id, r.entity_id,
                exists (select 1 from ledger.journal w where w.transfer_id = r.entity_id and w.effective_at >= $2 and w.effective_at < $3) as in_window
           from ops.external_ref r
           join ops.transfer t on t.id = r.entity_id and t.kind in ('load', 'refund')
          where r.entity_type in ('transfer', 'refund') and r.provider = $1
        )
       select c.external_id, (array_agg(j.id order by j.effective_at, j.id))[1] as journal_id, p.currency, sum(p.amount_minor)::text as amount_minor, bool_or(c.in_window) as in_window
         from cand c
         join ledger.journal j on j.transfer_id = c.entity_id
         join ledger.posting p on p.journal_id = j.id
         join ledger.account a on a.id = p.account_id and a.type::text = 'partner_settlement'
        where c.in_window or c.external_id = any($4::text[])
        group by c.external_id, p.currency
       having sum(p.amount_minor) <> 0`,
      [provider, from, to, ids],
    );
    const legacy = await this.db.query<Ours>(
      `select r.external_id, j.id as journal_id, p.currency, sum(case when p.amount_minor > 0 then p.amount_minor else 0 end)::text as amount_minor, true as in_window
         from ops.external_ref r
         join ledger.journal j on j.id = r.entity_id
         join ledger.posting p on p.journal_id = j.id
        where r.entity_type = 'journal' and r.provider = $1
        group by r.external_id, j.id, p.currency`,
      [provider],
    );
    const ours = { rows: [...legacy.rows, ...funding.rows] };
    const byExternal = new Map(ours.rows.map((o) => [o.external_id, o]));
    const breaks: ReconBreak[] = [];
    let matched = 0;
    const seen = new Set<string>();
    for (const t of partnerTxns) {
      seen.add(t.externalId);
      const o = byExternal.get(t.externalId);
      if (!o) {
        breaks.push({ provider, externalId: t.externalId, partner: t.amount, reason: 'missing_journal' });
        continue;
      }
      const ledgerAmount: Money = { minor: BigInt(o.amount_minor), currency: o.currency };
      if (o.currency !== t.amount.currency) breaks.push({ provider, externalId: t.externalId, journalId: o.journal_id, partner: t.amount, ledger: ledgerAmount, reason: 'currency_mismatch' });
      else if (ledgerAmount.minor !== t.amount.minor) breaks.push({ provider, externalId: t.externalId, journalId: o.journal_id, partner: t.amount, ledger: ledgerAmount, reason: 'amount_mismatch' });
      else matched += 1;
    }
    for (const [externalId, o] of byExternal) {
      if (!seen.has(externalId) && o.in_window) breaks.push({ provider, externalId, journalId: o.journal_id, ledger: { minor: BigInt(o.amount_minor), currency: o.currency }, reason: 'missing_partner' });
    }

    for (const b of breaks) await this.openCase(b, runDate, this.clock());
    const finishedAt = this.clock();
    const withinDeadline = finishedAt.getTime() <= deadlineFor(runDate).getTime();
    // RUN-03: a run that ends after 06:00 Israel time is itself a `recon_break` alert, once per provider and day.
    if (!withinDeadline) await this.openDeadlineCase(provider, runDate, finishedAt);
    return { runDate, statementDate, provider, matched, breaks, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), withinDeadline };
  }

  private async openDeadlineCase(provider: string, runDate: string, at: Date): Promise<void> {
    await this.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'recon_break', $2, 'medium', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
      [uuidv7(at), `recon:deadline:${provider}:${runDate}`, JSON.stringify({ provider, externalId: 'platform', reason: 'deadline_missed', runDate }), at],
    );
  }

  private async openCase(b: ReconBreak, runDate: string, at: Date): Promise<void> {
    const dedupeKey = `recon:${b.provider}:${b.externalId}:${runDate}`;
    const caseId = uuidv7(at);
    const severity = b.reason === 'amount_mismatch' || b.reason === 'currency_mismatch' ? 'high' : 'medium';
    const payload = { provider: b.provider, externalId: b.externalId, reason: b.reason, partnerMinor: b.partner?.minor.toString(), partnerCurrency: b.partner?.currency, ledgerMinor: b.ledger?.minor.toString(), ledgerCurrency: b.ledger?.currency, journalId: b.journalId };
    const inserted = await this.db.query<{ id: string }>(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'recon_break', $2, $3, 'open', $4, $5)
       on conflict (dedupe_key) do nothing returning id`,
      [caseId, dedupeKey, severity, JSON.stringify(payload), at],
    );
    if (inserted.rows.length === 0) return;
    await this.db.query(
      `insert into ops.recon_break (id, case_id, provider, external_id, journal_id, partner_minor, partner_currency, ledger_minor, ledger_currency, reason, run_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing`,
      [uuidv7(at), caseId, b.provider, b.externalId, b.journalId ?? null, b.partner?.minor.toString() ?? null, b.partner?.currency ?? null, b.ledger?.minor.toString() ?? null, b.ledger?.currency ?? null, b.reason, runDate],
    );
  }
}
