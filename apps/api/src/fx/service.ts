// FX (T-0509, REQ-FX-001/002; T-0513, REQ-FX-003/004): a USD/ILS quote locks for 30 seconds with the
// rate, the markup and the total. The rate is the club's published one (ADR-007): the member leg is priced
// from RateService, never from the vendor's live rate, and the quote and the journal carry the rate
// version; without a valid rate the quote is refused with PROVIDER_UNAVAILABLE. The markup comes from the
// member's active plan (the default when they have none) and rides the journal in basis points. The vendor
// (FxPort) is the hedge: convert() executes the vendor leg with the same idempotency key and records the
// vendor fill on the journal, so reconciliation can watch fx_position against it. Quotes are rows in
// ops.fx_quote (T-0522, ADR-014 decision 8): any API instance converts a quote another issued, and a quote
// is spent once, claimed by the conversion's Idempotency-Key, so only a retry under that key may use it
// again. Every conversion is a transfer of kind 'fx' keyed by the Idempotency-Key.
// A failed vendor leg closes the conversion (T-0520, SEQ-08, ADR-014 decision 7): a reject fails it and voids
// the quote with no journal; an outage keeps it submitted for a retry with the same key while the quote lives;
// a retry after the quote is gone fails it; and voidStale (the worker's sweep) fails whatever is still
// submitted once its quote can no longer be alive. Nothing stays submitted for ever.
import { add, applyBps, DomainError, fromWire, money, sub, toWire, uuidv7, type Currency, type Money } from '@kesher/domain';
import { applyRate, FxError, RATE_SCALE, type FxPort, type FxQuote } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { MembershipService } from '../billing/memberships.ts';
import { DEFAULT_FX_MARKUP_BPS, type PlanService } from '../billing/plans.ts';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferService } from '../transfers/service.ts';
import type { RateService } from './rates.ts';

export const FX_FLAG = 'fx.enabled';
export const FX_JOURNAL_KIND = 'fx';
export const QUOTE_TTL_MS = 30_000;
/** A submitted conversion this long after it was submitted has outlived its quote by a wide margin: void it. */
export const STALE_CONVERSION_MS = QUOTE_TTL_MS + 5 * 60_000;

/** The OpenAPI `FxQuote`. */
export interface FxQuoteView {
  quoteId: string;
  from: ReturnType<typeof toWire>;
  total: ReturnType<typeof toWire>;
  markup: ReturnType<typeof toWire>;
  markupBps: number;
  /** Decimal string for display only; money never flows through it. */
  rate: string;
  /** The club rate version the quote was priced from (REQ-FX-003). */
  rateVersion: number;
  /** When the server priced it (T-0533): a client times the lock as expiresAt − quotedAt, never against its own clock. */
  quotedAt: string;
  expiresAt: string;
}

/** The OpenAPI `FxConversion`. */
export interface FxConversionView {
  conversionId: string;
  quoteId: string;
  from: ReturnType<typeof toWire>;
  total: ReturnType<typeof toWire>;
  status: 'settled' | 'failed';
}

interface HeldQuote {
  partyId: string;
  quote: FxQuote;
  rateId: string;
  rateVersion: number;
  quotedAt: string;
  /** The Idempotency-Key of the conversion that claimed it, if one has. */
  spentKey?: string;
}

interface QuoteRow {
  id: string;
  party_id: string;
  from_minor: string;
  from_currency: Currency;
  to_currency: Currency;
  rate_scaled: string;
  markup_bps: string;
  total_minor: string;
  markup_minor: string;
  rate_id: string;
  rate_version: number;
  expires_at: string | Date;
  created_at: string | Date;
  spent_key: string | null;
}

interface Deps {
  db: Database;
  port: FxPort;
  rates: RateService;
  ledger: PostgresLedger;
  accounts: AccountService;
  transfers: TransferService;
  memberships: MembershipService;
  plans: PlanService;
  flags: FeatureFlags;
}

/** 3_710_000n → "3.710000". */
export function rateString(rateScaled: bigint): string {
  const whole = rateScaled / RATE_SCALE;
  const frac = (rateScaled % RATE_SCALE).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

export const settleKey = (workflowId: string): string => `${workflowId}:settle`;

export class FxService {
  private readonly d: Deps;
  constructor(d: Deps) {
    this.d = d;
  }

  /** POST /fx/quotes: the member's plan sets the markup; the purse must cover the amount now. Idempotent by key. */
  async quote(partyId: string, body: unknown, key: string, now: Date): Promise<FxQuoteView> {
    if (!(await this.d.flags.isOn(FX_FLAG))) throw new DomainError('FEATURE_OFF', 'Currency conversion is not enabled yet');
    const prior = await this.quoteByKey(partyId, key);
    if (prior) return view(prior);
    const { from, to } = parse(body);
    const purse = (await this.d.accounts.purses(partyId)).find((p) => p.currency === from.currency)!;
    if (purse.available.minor < from.minor) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the purse to convert', { available: purse.available.minor.toString(), currency: from.currency });
    const markupBps = await this.markupFor(partyId);
    // The club rate, or PROVIDER_UNAVAILABLE when none is valid now (REQ-FX-004): nothing is guessed.
    const rate = await this.d.rates.rateFor(from.currency, to, now);
    const gross = money(applyRate(from.minor, rate.rateScaled), to);
    const markup = applyBps(gross, markupBps);
    const quote: FxQuote = { quoteId: `cq_${uuidv7(now)}`, from, to, rateScaled: rate.rateScaled, markupBps, total: sub(gross, markup), markup, expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString() };
    await this.d.db.query(
      `insert into ops.fx_quote (id, party_id, idempotency_key, from_minor, from_currency, to_currency, rate_scaled, markup_bps, total_minor, markup_minor, rate_id, rate_version, market, expires_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) on conflict (party_id, idempotency_key) do nothing`,
      [quote.quoteId, partyId, key, from.minor.toString(), from.currency, to, rate.rateScaled.toString(), markupBps.toString(), quote.total.minor.toString(), markup.minor.toString(), rate.rateId, rate.version, this.d.transfers.market, quote.expiresAt, now],
    );
    // The same key raced on another instance: its quote is the one.
    return view((await this.quoteByKey(partyId, key))!);
  }

  /** POST /fx/conversions: convert at a live quote, once per key; QUOTE_EXPIRED after 30 s. */
  async convert(partyId: string, body: unknown, key: string, now: Date): Promise<FxConversionView> {
    if (!(await this.d.flags.isOn(FX_FLAG))) throw new DomainError('FEATURE_OFF', 'Currency conversion is not enabled yet');
    const b = (body ?? {}) as { quoteId?: unknown };
    if (typeof b.quoteId !== 'string' || !b.quoteId) throw new DomainError('VALIDATION_FAILED', 'quoteId is required');
    const existing = await this.d.transfers.byKey(key);
    if (existing) {
      if (existing.kind !== 'fx' || existing.fromPartyId !== partyId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
      if (existing.state === 'settled') return this.settledView(existing);
      if (existing.state === 'failed') throw failedConversion(existing);
    }
    const held = await this.quoteById(b.quoteId);
    if (!held || held.partyId !== partyId || (held.spentKey !== undefined && held.spentKey !== key)) {
      // Unknown, another member's, or spent by another conversion: no retry can settle on it, so close it.
      if (existing?.state === 'submitted') await this.void(existing, 'QUOTE_EXPIRED', 'quote no longer available', now);
      throw new DomainError('QUOTE_EXPIRED', 'This quote is no longer available; get a fresh one', { quoteId: b.quoteId });
    }
    if (now.getTime() > Date.parse(held.quote.expiresAt)) {
      if (existing?.state === 'submitted') await this.void(existing, 'QUOTE_EXPIRED', 'quote expired before the vendor confirmed', now);
      throw new DomainError('QUOTE_EXPIRED', 'This quote expired after 30 seconds; get a fresh one', { quoteId: b.quoteId, expiredAt: held.quote.expiresAt });
    }
    const q = held.quote;
    const purse = (await this.d.accounts.purses(partyId)).find((p) => p.currency === q.from.currency)!;
    if (purse.available.minor < q.from.minor) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the purse to convert', { available: purse.available.minor.toString(), currency: q.from.currency });
    // Spend the quote under this key before anything moves; a conversion under another key that got there
    // first (on this instance or another) wins it.
    const claimed = await this.d.db.query(`update ops.fx_quote set spent_key = $2, spent_at = coalesce(spent_at, $3) where id = $1 and (spent_key is null or spent_key = $2)`, [q.quoteId, key, now]);
    if (claimed.rowCount === 0) throw new DomainError('QUOTE_EXPIRED', 'This quote is no longer available; get a fresh one', { quoteId: q.quoteId });

    let t: Transfer = existing ?? (await this.d.transfers.create({ idempotencyKey: key, kind: 'fx', fromPartyId: partyId, toPartyId: partyId, amount: q.from }, now));
    if (t.state === 'created') t = await this.d.transfers.apply(t.id, 'submit', now);
    // The vendor leg is the hedge: a fresh vendor quote at its own rate, converted under the same key.
    let conversion;
    try {
      const vendorQuote = await this.d.port.quote({ from: q.from, to: q.total.currency, markupBps: 0n });
      conversion = await this.d.port.convert(vendorQuote.quoteId, key);
    } catch (e) {
      // A reject is final: the quote is void and the conversion fails with no journal (SEQ-08). An outage
      // (or anything we cannot classify) leaves it submitted: the same key retries the vendor call.
      if (e instanceof FxError && e.code !== 'PROVIDER_UNAVAILABLE') {
        await this.void(t, e.code, `vendor rejected: ${e.message}`.slice(0, 200), now);
      }
      throw mapFxError(e);
    }
    const journal = await this.post(partyId, q, held, conversion.conversionId, conversion.rateScaled, conversion.total, t.id, key, now);
    await this.d.transfers.apply(t.id, 'settle', now, { journalId: journal.id });
    return { conversionId: conversion.conversionId, quoteId: q.quoteId, from: toWire(q.from), total: toWire(q.total), status: 'settled' };
  }

  /**
   * The sweep (T-0520): fails every conversion still submitted STALE_CONVERSION_MS after it was submitted,
   * when no quote can still be alive for it. No journal posts; a vendor fill that did happen is a gap on
   * fx_position for reconciliation. Idempotent: a failed conversion is not submitted any more.
   */
  async voidStale(now: Date, olderThanMs = STALE_CONVERSION_MS, limit = 100): Promise<Transfer[]> {
    const r = await this.d.db.query<{ id: string }>(`select id from ops.transfer where kind = 'fx' and state = 'submitted' and updated_at <= $1 order by updated_at limit $2`, [new Date(now.getTime() - olderThanMs), limit]);
    const out: Transfer[] = [];
    for (const row of r.rows) {
      const t = await this.d.transfers.get(row.id);
      if (t?.state === 'submitted') out.push(await this.void(t, 'QUOTE_EXPIRED', 'stale conversion: its quote expired', now));
    }
    return out;
  }

  private async void(t: Transfer, code: string, reason: string, now: Date): Promise<Transfer> {
    return this.d.transfers.apply(t.id, 'fail', now, { failureCode: code, reason });
  }

  /** The member's plan's markup, or the default without an active plan. */
  async markupFor(partyId: string): Promise<bigint> {
    const m = await this.d.memberships.forMember(partyId);
    if (!m || m.status !== 'active') return DEFAULT_FX_MARKUP_BPS;
    const plan = await this.d.plans.get(m.planCode, m.planVersion);
    return plan?.fxMarkupBps ?? DEFAULT_FX_MARKUP_BPS;
  }

  /**
   * One journal, balanced per currency: the member's `from` purse pays into the FX position; the FX position
   * pays out the gross in `to` at the club rate, the member's `to` purse receives the total and fee income
   * the markup. The vendor fill (its rate and amount) rides the metadata: the gap between it and the club
   * gross is fx_position's gain or loss, which reconciliation watches against the vendor's statement.
   */
  private async post(partyId: string, q: FxQuote, held: HeldQuote, conversionId: string, vendorRateScaled: bigint, vendorTotal: Money, transferId: string, key: string, now: Date) {
    const { from, total, markup, markupBps, rateScaled, quoteId } = q;
    const walletFrom = await this.d.accounts.memberAccount(partyId, 'wallet', from.currency);
    const walletTo = await this.d.accounts.memberAccount(partyId, 'wallet', total.currency);
    const positionFrom = await this.d.accounts.systemAccount('fx_position', from.currency);
    const positionTo = await this.d.accounts.systemAccount('fx_position', total.currency);
    const feeIncome = await this.d.accounts.systemAccount('fee_income', total.currency);
    const gross = add(total, markup);
    return this.d.ledger.post({
      idempotencyKey: settleKey(key),
      kind: FX_JOURNAL_KIND,
      transferId,
      effectiveAt: now,
      postings: [
        { accountId: walletFrom, currency: from.currency, amountMinor: from.minor },
        { accountId: positionFrom, currency: from.currency, amountMinor: -from.minor },
        { accountId: positionTo, currency: total.currency, amountMinor: gross.minor },
        { accountId: walletTo, currency: total.currency, amountMinor: -total.minor },
        { accountId: feeIncome, currency: total.currency, amountMinor: -markup.minor },
      ],
      metadata: {
        fx_markup_bps: Number(markupBps),
        fx_rate_version: held.rateVersion,
        fx_rate_id: held.rateId,
        rateScaled: rateScaled.toString(),
        rate: rateString(rateScaled),
        quoteId,
        conversionId,
        from: toWire(from),
        total: toWire(total),
        markup: toWire(markup),
        vendor: { rateScaled: vendorRateScaled.toString(), rate: rateString(vendorRateScaled), total: toWire(vendorTotal) },
      },
    });
  }

  /** A replay of a settled conversion, on any instance, answers from its journal. */
  private async settledView(t: Transfer): Promise<FxConversionView> {
    const r = await this.d.db.query<{ metadata: { conversionId: string; quoteId: string; from: ReturnType<typeof toWire>; total: ReturnType<typeof toWire> } }>('select metadata from ledger.journal where idempotency_key = $1', [settleKey(t.idempotencyKey)]);
    const m = r.rows[0]?.metadata;
    if (!m) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This conversion settled without its journal', { transferId: t.id });
    return { conversionId: m.conversionId, quoteId: m.quoteId, from: m.from, total: m.total, status: 'settled' };
  }

  private async quoteById(quoteId: string): Promise<HeldQuote | undefined> {
    return toHeld((await this.d.db.query<QuoteRow>('select * from ops.fx_quote where id = $1', [quoteId])).rows[0]);
  }

  private async quoteByKey(partyId: string, key: string): Promise<HeldQuote | undefined> {
    return toHeld((await this.d.db.query<QuoteRow>('select * from ops.fx_quote where party_id = $1 and idempotency_key = $2', [partyId, key])).rows[0]);
  }
}

function toHeld(r: QuoteRow | undefined): HeldQuote | undefined {
  if (!r) return undefined;
  const quote: FxQuote = {
    quoteId: r.id,
    from: money(BigInt(r.from_minor), r.from_currency),
    to: r.to_currency,
    rateScaled: BigInt(r.rate_scaled),
    markupBps: BigInt(r.markup_bps),
    total: money(BigInt(r.total_minor), r.to_currency),
    markup: money(BigInt(r.markup_minor), r.to_currency),
    expiresAt: new Date(r.expires_at).toISOString(),
  };
  return { partyId: r.party_id, quote, rateId: r.rate_id, rateVersion: r.rate_version, quotedAt: new Date(r.created_at).toISOString(), ...(r.spent_key ? { spentKey: r.spent_key } : {}) };
}

function parse(body: unknown): { from: Money; to: Currency } {
  const b = (body ?? {}) as { from?: unknown; to?: unknown };
  let from: Money;
  try {
    from = fromWire(b.from as { minor: string; currency: string });
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'from must be { minor, currency } in USD or ILS');
  }
  if (from.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
  if (b.to !== 'USD' && b.to !== 'ILS') throw new DomainError('VALIDATION_FAILED', 'to must be USD or ILS');
  if (b.to === from.currency) throw new DomainError('VALIDATION_FAILED', 'Pick a different currency to convert to');
  return { from, to: b.to };
}

function view(h: HeldQuote): FxQuoteView {
  const q = h.quote;
  return { quoteId: q.quoteId, from: toWire(q.from), total: toWire(q.total), markup: toWire(q.markup), markupBps: Number(q.markupBps), rate: rateString(q.rateScaled), rateVersion: h.rateVersion, quotedAt: h.quotedAt, expiresAt: q.expiresAt };
}

/** A replay of a conversion that already failed answers as the first attempt did. */
function failedConversion(t: Transfer): DomainError {
  if (t.failureCode === 'QUOTE_EXPIRED' || t.failureCode === 'UNKNOWN_QUOTE') return new DomainError('QUOTE_EXPIRED', 'This conversion did not go through; get a fresh quote', { transferId: t.id });
  return new DomainError('VALIDATION_FAILED', 'This conversion did not go through', { transferId: t.id, failureCode: t.failureCode });
}

function mapFxError(e: unknown): Error {
  if (e instanceof FxError) {
    if (e.code === 'PROVIDER_UNAVAILABLE') return new DomainError('PROVIDER_UNAVAILABLE', 'Currency conversion is temporarily unavailable; try again with the same key');
    if (e.code === 'QUOTE_EXPIRED' || e.code === 'UNKNOWN_QUOTE') return new DomainError('QUOTE_EXPIRED', 'This quote is no longer available; get a fresh one');
    if (e.code === 'UNSUPPORTED_PAIR' || e.code === 'VALIDATION_FAILED') return new DomainError('VALIDATION_FAILED', e.message);
  }
  return e as Error;
}
