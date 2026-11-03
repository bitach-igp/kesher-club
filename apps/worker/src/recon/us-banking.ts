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
// Pooled platform accounts have no account of their own to read. A debit is known when it carries one of our provider payment references. The
// institution's KC- reference is public, so on its own it proves nothing: it explains a debit only for a request that went out, of exactly
// that amount, and each request explains one debit (provisional until Crowded answers how a transaction names an ACH). Everything else the
// bank reports going out is reported, as the card asks. A day lost to an outage is reconciled on the next run that can read the account.
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
const READ_BACK_MS = 30 * 86_400_000;
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

const shiftDay = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const nextDay = (day: string): string => shiftDay(day, 1);
/** The Israel day before the one `now` is in: by the calendar, since a day is 23 or 25 hours long twice a year. */
export const previousIsraelDay = (now: Date): string => shiftDay(israelClock(now).day, -1);
const CATCH_UP_DAYS = 7;
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
    const day = previousIsraelDay(now);
    const report: UsBankingReconReport = { day, institutions: 0, clean: 0, breaks: 0, outages: 0, withinDeadline: true };
    if (!(await this.flags.isOn(FLAG))) return { ...report, skipped: 'flag_off' };
    const accounts = await this.accounts();
    report.institutions = accounts.length;
    let bug: unknown;
    for (const a of accounts) {
      try {
        // Days an earlier outage left unread come first, so a payment the hint missed on one of them is still recorded.
        const missed = (await this.db.query<{ day: string }>(
          `select distinct payload->>'day' as day from ops.case where kind = 'recon_break' and payload->>'reason' in ('provider_outage', 'account_unreadable') and payload->>'institutionId' = $1 and payload->>'recoveredAt' is null and payload->>'day' >= $2 and payload->>'day' < $3 order by 1`,
          [a.institution_id, shiftDay(day, -CATCH_UP_DAYS), day],
        )).rows.map((r) => r.day);
        for (const d of missed) {
          await this.withBackoff(() => this.reconcileDay(a, d, now));
          await this.db.query(`update ops.case set payload = payload || jsonb_build_object('recoveredAt', $3::text) where kind = 'recon_break' and payload->>'institutionId' = $1 and payload->>'day' = $2 and payload->>'reason' in ('provider_outage', 'account_unreadable')`, [a.institution_id, d, now.toISOString()]);
        }
        const found = await this.withBackoff(() => this.reconcileDay(a, day, now));
        report.breaks += found;
        if (found === 0) report.clean += 1;
      } catch (e) {
        if (!(e instanceof InstitutionBankingError)) {
          bug ??= e; // a defect: the other institutions still run, then the run fails and is retried
          continue;
        }
        report.outages += 1;
        // Only an unavailable provider is an outage; an account the bank will not answer for (closed, suspended) is its own reason.
        const reason = e.code === 'PROVIDER_UNAVAILABLE' ? 'provider_outage' : 'account_unreadable';
        await this.openCase(a, a.institution_id, reason, { day, code: e.code }, `us-recon:${reason}:${a.institution_id}:${day}`, now);
      }
    }
    if (bug) throw bug;
    report.withinDeadline = this.clock().getTime() <= deadlineFor(today).getTime();
    if (!report.withinDeadline) await this.openCase(undefined, 'platform', 'deadline_missed', { day }, `us-recon:deadline:${this.market}:${today}`, now);
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
  private async reconcileDay(a: Account, day: string, now: Date): Promise<number> {
    const from = israelDayStart(day);
    const to = israelDayStart(nextDay(day));
    const port = this.port();
    let found = 0;
    const open = async (ref: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
      if (await this.openCase(a, ref, reason, { day, ...extra }, `us-recon:${a.provider}:${a.institution_id}:${ref}:${reason}`, now)) found += 1;
    };

    // Payments: what the provider lists since a month back, so a row recorded yesterday for an older payment is still found.
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
      }
    }
    // Rows recorded this day for this institution's fees, whatever day they were paid: the provider must list each, not decline it, at the amount we hold.
    const rows = await this.db.query<{ provider_payment_ref: string; amount_minor: string }>(
      `select p.provider_payment_ref, p.amount_minor::text from org.fee_external_payment p join org.fee_item f on f.id = p.fee_item_id where f.institution_id = $1 and p.kind = 'payment' and p.at >= $2 and p.at < $3 order by p.seq`,
      [a.institution_id, from, to],
    );
    for (const r of rows.rows) {
      const p = listed.get(r.provider_payment_ref);
      if (!p) await open(r.provider_payment_ref, 'row_without_payment');
      else if (p.status === 'declined') await open(r.provider_payment_ref, 'row_for_declined_payment');
      else if (p.amount.minor !== BigInt(r.amount_minor)) await open(r.provider_payment_ref, 'amount_mismatch', { provider: toWire(p.amount), recorded: { minor: r.amount_minor, currency: 'USD' } });
    }
    // Payments of the day whose row differs in amount are caught above only if the row was recorded today; compare the others too.
    for (const p of listed.values()) {
      if (p.paidAt < from || p.paidAt >= to || p.status === 'declined') continue;
      const row = (await this.db.query<{ amount_minor: string }>(`select amount_minor::text from org.fee_external_payment where provider_payment_ref = $1 and kind = 'payment'`, [p.paymentRef])).rows[0];
      if (row && BigInt(row.amount_minor) !== p.amount.minor) await open(p.paymentRef, 'amount_mismatch', { provider: toWire(p.amount), recorded: { minor: row.amount_minor, currency: 'USD' } });
    }

    // Outbound: every debit the bank reports must be one of our funding requests.
    const known = await this.knownOutbound(a);
    for await (const t of port.transactions({ entityRef: a.entity_ref, from, to })) {
      if (t.kind !== 'debit' || t.postedAt < from || t.postedAt >= to) continue;
      if (known.paymentRefs.has(t.transactionRef) || [...known.paymentRefs].some((k) => k.length >= 6 && t.description.includes(k))) continue;
      // The KC- reference is public: it explains a debit only for a request that went out, of exactly this amount, and one request explains one debit.
      const req = known.requests.find((r) => !r.used && r.amount === t.amount.minor && t.description.includes(r.reference));
      if (req) {
        req.used = true;
        continue;
      }
      await open(t.transactionRef, 'outbound_without_request', { amount: toWire(t.amount) });
    }
    return found;
  }

  /** What our funding requests for this institution go out as: the provider's payment refs, and the requests that were sent with their KC- reference and amount. */
  private async knownOutbound(a: Account): Promise<{ paymentRefs: Set<string>; requests: { reference: string; amount: bigint; used: boolean }[] }> {
    const refs = await this.db.query<{ ref: string }>(
      `select x.external_id as ref from ops.external_ref x join org.us_funding_request r on r.id = x.entity_id where x.entity_type = $1 and r.institution_id = $2`,
      [FUNDING_REF, a.institution_id],
    );
    const sent = await this.db.query<{ reference: string; amount_minor: string }>(
      `select r.reference, r.amount_minor::text from org.us_funding_request r where r.institution_id = $1 and exists (select 1 from org.us_funding_event e where e.request_id = r.id and e.kind in ('sending', 'sent', 'book_transferred')) order by r.created_at`,
      [a.institution_id],
    );
    return { paymentRefs: new Set(refs.rows.map((r) => r.ref)), requests: sent.rows.map((r) => ({ reference: r.reference, amount: BigInt(r.amount_minor), used: false })) };
  }

  private async openCase(a: Account | undefined, ref: string, reason: string, extra: Record<string, unknown>, dedupeKey: string, now: Date): Promise<boolean> {
    const r = await this.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'recon_break', $2, 'medium', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
      [uuidv7(now), dedupeKey, { provider: a?.provider ?? 'crowded', externalId: ref, reason, ...(a ? { institutionId: a.institution_id } : {}), ...extra }, now],
    );
    return r.rowCount > 0;
  }
}
