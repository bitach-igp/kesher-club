// Nightly reconciliation of the linked US accounts (T-0654, REQ-INS-026), behind institutions.usBanking. At 03:00 Israel time, for each
// institution whose own US account the bank approved, yesterday's (Israel day) payments and transactions are read through the port and
// compared with what Kesher recorded:
// - a provider payment with no row: if it is one of our payment pages, the row is created through the same insert as T-0652 and a case notes it;
//   if we made no page for it, a case says so;
// - a row with no provider payment (a payment recorded yesterday that the provider does not list);
// - an amount mismatch between the provider's payment and our row;
// - an outbound debit that no US funding request accounts for.
// Each break is one `recon_break` case keyed by the provider's reference and the reason, so a rerun opens none. An institution the provider
// does not answer for is retried with back-off, then gets ONE case for the day, not one per row; the rest of the institutions still run.
// Breaks are never corrected here. The run is late if it finishes after 06:00 Israel time, and a case says so (RUN-03).
// Pooled platform accounts have no account of their own to read. A debit is matched to a request by our provider reference, the payment's
// own reference or the request's KC- reference appearing in the bank's description (provisional until Crowded answers how a transaction names
// an ACH); everything else the bank reports going out is reported, as the card asks.
import type { UsCollections } from '@kesher/api/institutions/us-collections';
import type { Database } from '@kesher/api/db';
import type { FeatureFlags } from '@kesher/api/billing/capabilities';
import { toWire, uuidv7 } from '@kesher/domain';
import { InstitutionBankingError, type CollectedPayment, type InstitutionBankingPort } from '@kesher/ports';
import { israelClock } from '../scheduler.ts';
import { deadlineFor } from './recon.ts';

const FLAG = 'institutions.usBanking';
const INTENT_REF = 'fee_item_us_intent';
const FUNDING_REF = 'institution_us_funding';
const READ_BACK_MS = 7 * 86_400_000;
/** Tries (with 1s, 2s back-off between them) before an institution's outage becomes its case. */
const ATTEMPTS = 3;

export interface UsBankingReconReport {
  day: string;
  skipped?: 'flag_off';
  institutions: number;
  clean: number;
  breaks: number;
  outages: number;
  withinDeadline: boolean;
}

interface Account {
  institution_id: string;
  entity_ref: string;
  provider: string;
}

/** The instant an Israel calendar day starts (UTC+2 or UTC+3). */
export function israelDayStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  for (const offsetHours of [3, 2]) {
    const start = new Date(Date.UTC(y, m - 1, d) - offsetHours * 3_600_000);
    if (israelClock(start).day === day && israelClock(new Date(start.getTime() - 1)).day !== day) return start;
  }
  throw new Error(`No start for the Israel day ${day}`);
}

const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class UsBankingRecon {
  private readonly db: Database;
  private readonly flags: FeatureFlags;
  private readonly collections: UsCollections;
  private readonly port: () => InstitutionBankingPort;
  private readonly market: 'IL' | 'US';
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => Date;
  constructor(db: Database, flags: FeatureFlags, collections: UsCollections, port: () => InstitutionBankingPort, market: 'IL' | 'US', clock: () => Date = () => new Date(), sleep: (ms: number) => Promise<void> = sleepMs) {
    this.db = db;
    this.flags = flags;
    this.collections = collections;
    this.port = port;
    this.market = market;
    this.clock = clock;
    this.sleep = sleep;
  }

  async run(now: Date): Promise<UsBankingReconReport> {
    const today = israelClock(now).day;
    const day = israelClock(new Date(now.getTime() - 24 * 3_600_000)).day;
    const report: UsBankingReconReport = { day, institutions: 0, clean: 0, breaks: 0, outages: 0, withinDeadline: true };
    if (!(await this.flags.isOn(FLAG))) return { ...report, skipped: 'flag_off' };
    const from = israelDayStart(day);
    const to = israelDayStart(nextDay(day));
    const accounts = await this.accounts();
    report.institutions = accounts.length;
    let bug: unknown;
    for (const a of accounts) {
      try {
        const found = await this.withBackoff(() => this.reconcile(a, from, to, now));
        report.breaks += found;
        if (found === 0) report.clean += 1;
      } catch (e) {
        if (!(e instanceof InstitutionBankingError)) {
          bug ??= e; // a defect: the other institutions still run, then the run fails and is retried
          continue;
        }
        report.outages += 1;
        await this.openCase(a, a.institution_id, 'provider_outage', { day, code: e.code }, `us-recon:outage:${a.institution_id}:${day}`, now);
      }
    }
    if (bug) throw bug;
    report.withinDeadline = this.clock().getTime() <= deadlineFor(today).getTime();
    if (!report.withinDeadline) await this.openCase(undefined, 'platform', 'deadline_missed', { day }, `us-recon:deadline:${today}`, now);
    return report;
  }

  /** The institutions whose own US account the bank approved in this market. A pooled account has none of its own. */
  private async accounts(): Promise<Account[]> {
    const r = await this.db.query<Account>(
      `select e.institution_id, x.external_id as entity_ref, x.provider
         from (select distinct on (institution_id) institution_id, status, shares_platform_account from org.institution_us_banking_event order by institution_id, seq desc) e
         join org.institution i on i.id = e.institution_id and i.market = $1
         join ops.external_ref x on x.entity_type = 'institution_us_banking' and x.entity_id = e.institution_id
        where e.status = 'approved' and not e.shares_platform_account order by e.institution_id`,
      [this.market],
    );
    return r.rows;
  }

  private async withBackoff<T>(body: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await body();
      } catch (e) {
        if (!(e instanceof InstitutionBankingError) || e.code !== 'PROVIDER_UNAVAILABLE' || attempt >= ATTEMPTS) throw e;
        await this.sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  /** One institution's day. Answers how many breaks it found. Idempotent: a rerun finds the same breaks and their cases already exist. */
  private async reconcile(a: Account, from: Date, to: Date, now: Date): Promise<number> {
    const port = this.port();
    let found = 0;
    const open = async (ref: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
      found += 1;
      await this.openCase(a, ref, reason, extra, `us-recon:${a.provider}:${ref}:${reason}`, now);
    };

    // Payments: what the provider lists since a week back, so a payment recorded yesterday for an earlier day is not called missing.
    const listed = new Map<string, CollectedPayment>();
    for await (const p of port.collectPayments({ entityRef: a.entity_ref, since: new Date(from.getTime() - READ_BACK_MS) })) listed.set(p.paymentRef, p);
    for (const p of listed.values()) {
      if (p.paidAt < from || p.paidAt >= to || p.status === 'declined') continue;
      const page = (await this.db.query(`select 1 from ops.external_ref where entity_type = $1 and provider = $2 and external_id = $3`, [INTENT_REF, a.provider, p.intentRef])).rows.length > 0;
      if (!page) {
        await open(p.paymentRef, 'payment_without_page', { amount: toWire(p.amount) });
        continue;
      }
      const row = (await this.db.query<{ amount_minor: string }>(`select amount_minor::text from org.fee_external_payment where provider_payment_ref = $1 and kind = 'payment'`, [p.paymentRef])).rows[0];
      if (!row) {
        // The hint missed it: record it as the hint would have, and say so.
        const applied = await this.collections.applyPayment(p, a.provider, now);
        if (applied.marked > 0) await open(p.paymentRef, 'payment_row_created', { amount: toWire(p.amount) });
      } else if (BigInt(row.amount_minor) !== p.amount.minor) {
        await open(p.paymentRef, 'amount_mismatch', { provider: toWire(p.amount), recorded: { minor: row.amount_minor, currency: 'USD' } });
      }
    }
    // Rows recorded yesterday for this institution's fees that the provider does not list.
    const rows = await this.db.query<{ provider_payment_ref: string }>(
      `select p.provider_payment_ref from org.fee_external_payment p join org.fee_item f on f.id = p.fee_item_id where f.institution_id = $1 and p.kind = 'payment' and p.at >= $2 and p.at < $3 order by p.seq`,
      [a.institution_id, from, to],
    );
    for (const r of rows.rows) if (!listed.has(r.provider_payment_ref)) await open(r.provider_payment_ref, 'row_without_payment');

    // Outbound: every debit the bank reports must be one of our funding requests.
    const known = await this.knownOutbound(a);
    for await (const t of port.transactions({ entityRef: a.entity_ref, from, to })) {
      if (t.kind !== 'debit') continue;
      if (known.has(t.transactionRef) || [...known].some((k) => k.length >= 6 && t.description.includes(k))) continue;
      await open(t.transactionRef, 'outbound_without_request', { amount: toWire(t.amount) });
    }
    return found;
  }

  /** The references our funding requests for this institution go out under: the provider's payment refs and the KC- references. */
  private async knownOutbound(a: Account): Promise<Set<string>> {
    const refs = await this.db.query<{ ref: string }>(
      `select x.external_id as ref from ops.external_ref x join org.us_funding_request r on r.id = x.entity_id where x.entity_type = $1 and r.institution_id = $2
       union select reference as ref from org.us_funding_request where institution_id = $2`,
      [FUNDING_REF, a.institution_id],
    );
    return new Set(refs.rows.map((r) => r.ref));
  }

  private async openCase(a: Account | undefined, ref: string, reason: string, extra: Record<string, unknown>, dedupeKey: string, now: Date): Promise<void> {
    await this.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'recon_break', $2, 'medium', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
      [uuidv7(now), dedupeKey, { provider: a?.provider ?? 'crowded', externalId: ref, reason, ...(a ? { institutionId: a.institution_id } : {}), ...extra }, now],
    );
  }
}
