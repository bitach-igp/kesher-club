// Nightly reconciliation (T-0206, REQ-LED-004): match every partner transaction to a journal by
// external ref and open an ops case for any break before 06:00 Israel time. The partner's record
// is the system of record (constitution art. 2); our ledger is the shadow that must reach zero
// breaks. Breaks are never auto-corrected.
import { uuidv7, type Currency, type Money } from '@kesher/domain';
import type { Database } from '@kesher/api/db';

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
  constructor(
    private readonly db: Database,
    private readonly source: StatementSource,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(provider: string, runDate: string): Promise<ReconReport> {
    const startedAt = this.clock();
    const partnerTxns = await this.source.fetch(provider, runDate);

    // Our side: journals the partner should know about, via external refs recorded when the
    // webhook/workflow posted them (ops.external_ref entity_type = 'journal').
    const ours = await this.db.query<{ external_id: string; journal_id: string; currency: Currency; amount_minor: string }>(
      `select r.external_id, j.id as journal_id, p.currency, sum(case when p.amount_minor > 0 then p.amount_minor else 0 end)::text as amount_minor
         from ops.external_ref r
         join ledger.journal j on j.id = r.entity_id
         join ledger.posting p on p.journal_id = j.id
        where r.entity_type = 'journal' and r.provider = $1
        group by r.external_id, j.id, p.currency`,
      [provider],
    );
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
      if (!seen.has(externalId)) breaks.push({ provider, externalId, journalId: o.journal_id, ledger: { minor: BigInt(o.amount_minor), currency: o.currency }, reason: 'missing_partner' });
    }

    for (const b of breaks) await this.openCase(b, runDate, this.clock());
    const finishedAt = this.clock();
    return { runDate, provider, matched, breaks, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), withinDeadline: finishedAt.getTime() <= deadlineFor(runDate).getTime() };
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
