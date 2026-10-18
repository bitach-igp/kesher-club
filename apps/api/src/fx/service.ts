// FX (T-0509, REQ-FX-001/002): a USD/ILS quote locks for 30 seconds with the rate, the markup and the
// total; converting at it moves the member's money between purses in one journal that carries the
// markup in basis points, so the plan's pricing is auditable on the ledger. The markup comes from the
// member's active plan (the default when they have none). Quotes are short-lived and process-local:
// after a restart a quote is unknown and the screen asks for a fresh one, which is what it does on
// expiry anyway. Every conversion is a transfer of kind 'fx' keyed by the Idempotency-Key, and the
// vendor call carries the same key, so a retry never converts twice.
import { add, DomainError, fromWire, toWire, type Currency, type Money } from '@kesher/domain';
import { FxError, RATE_SCALE, type FxPort, type FxQuote } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { MembershipService } from '../billing/memberships.ts';
import { DEFAULT_FX_MARKUP_BPS, type PlanService } from '../billing/plans.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferService } from '../transfers/service.ts';

export const FX_FLAG = 'fx.enabled';
export const FX_JOURNAL_KIND = 'fx';
export const QUOTE_TTL_MS = 30_000;

/** The OpenAPI `FxQuote`. */
export interface FxQuoteView {
  quoteId: string;
  from: ReturnType<typeof toWire>;
  total: ReturnType<typeof toWire>;
  markup: ReturnType<typeof toWire>;
  markupBps: number;
  /** Decimal string for display only; money never flows through it. */
  rate: string;
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
}

interface Deps {
  port: FxPort;
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
  private readonly quotes = new Map<string, HeldQuote>();
  private readonly quotesByKey = new Map<string, string>();
  private readonly conversionsByTransfer = new Map<string, FxConversionView>();

  constructor(private readonly d: Deps) {}

  /** POST /fx/quotes: the member's plan sets the markup; the purse must cover the amount now. Idempotent by key. */
  async quote(partyId: string, body: unknown, key: string, now: Date): Promise<FxQuoteView> {
    if (!(await this.d.flags.isOn(FX_FLAG))) throw new DomainError('FEATURE_OFF', 'Currency conversion is not enabled yet');
    const prior = this.quotesByKey.get(`${partyId}:${key}`);
    if (prior) {
      const held = this.quotes.get(prior);
      if (held) return view(held.quote);
    }
    const { from, to } = parse(body);
    const purse = (await this.d.accounts.purses(partyId)).find((p) => p.currency === from.currency)!;
    if (purse.available.minor < from.minor) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the purse to convert', { available: purse.available.minor.toString(), currency: from.currency });
    const markupBps = await this.markupFor(partyId);
    let quote: FxQuote;
    try {
      quote = await this.d.port.quote({ from, to, markupBps });
    } catch (e) {
      throw mapFxError(e);
    }
    // The vendor's clock and ours may differ by a little; the lock is ours to enforce from now.
    quote = { ...quote, expiresAt: new Date(Math.min(Date.parse(quote.expiresAt), now.getTime() + QUOTE_TTL_MS)).toISOString() };
    this.quotes.set(quote.quoteId, { partyId, quote });
    this.quotesByKey.set(`${partyId}:${key}`, quote.quoteId);
    this.sweep(now);
    return view(quote);
  }

  /** POST /fx/conversions: convert at a live quote, once per key; QUOTE_EXPIRED after 30 s. */
  async convert(partyId: string, body: unknown, key: string, now: Date): Promise<FxConversionView> {
    if (!(await this.d.flags.isOn(FX_FLAG))) throw new DomainError('FEATURE_OFF', 'Currency conversion is not enabled yet');
    const b = (body ?? {}) as { quoteId?: unknown };
    if (typeof b.quoteId !== 'string' || !b.quoteId) throw new DomainError('VALIDATION_FAILED', 'quoteId is required');
    const existing = await this.d.transfers.byKey(key);
    if (existing) {
      if (existing.kind !== 'fx' || existing.fromPartyId !== partyId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
      const done = this.conversionsByTransfer.get(existing.id);
      if (done) return done;
      if (existing.state === 'settled') return this.viewFromTransfer(existing, b.quoteId);
    }
    const held = this.quotes.get(b.quoteId);
    if (!held || held.partyId !== partyId) throw new DomainError('QUOTE_EXPIRED', 'This quote is no longer available; get a fresh one', { quoteId: b.quoteId });
    if (now.getTime() > Date.parse(held.quote.expiresAt)) {
      this.quotes.delete(b.quoteId);
      throw new DomainError('QUOTE_EXPIRED', 'This quote expired after 30 seconds; get a fresh one', { quoteId: b.quoteId, expiredAt: held.quote.expiresAt });
    }
    const q = held.quote;
    const purse = (await this.d.accounts.purses(partyId)).find((p) => p.currency === q.from.currency)!;
    if (purse.available.minor < q.from.minor) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the purse to convert', { available: purse.available.minor.toString(), currency: q.from.currency });

    let t: Transfer = existing ?? (await this.d.transfers.create({ idempotencyKey: key, kind: 'fx', fromPartyId: partyId, toPartyId: partyId, amount: q.from }, now));
    if (t.state === 'created') t = await this.d.transfers.apply(t.id, 'submit', now);
    let conversion;
    try {
      conversion = await this.d.port.convert(q.quoteId, key);
    } catch (e) {
      if (e instanceof FxError && e.code === 'QUOTE_EXPIRED') {
        this.quotes.delete(q.quoteId);
        await this.d.transfers.apply(t.id, 'fail', now, { failureCode: 'QUOTE_EXPIRED', reason: 'vendor' });
        throw new DomainError('QUOTE_EXPIRED', 'This quote expired after 30 seconds; get a fresh one', { quoteId: q.quoteId });
      }
      throw mapFxError(e); // an outage leaves the transfer submitted: the same key retries the vendor call
    }
    const journal = await this.post(partyId, conversion.from, conversion.total, conversion.markup, conversion.markupBps, conversion.rateScaled, q.quoteId, conversion.conversionId, t.id, key, now);
    t = await this.d.transfers.apply(t.id, 'settle', now, { journalId: journal.id });
    this.quotes.delete(q.quoteId);
    const out: FxConversionView = { conversionId: conversion.conversionId, quoteId: q.quoteId, from: toWire(conversion.from), total: toWire(conversion.total), status: 'settled' };
    this.conversionsByTransfer.set(t.id, out);
    return out;
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
   * pays out the gross in `to`, the member's `to` purse receives the total and fee income the markup.
   */
  private async post(partyId: string, from: Money, total: Money, markup: Money, markupBps: bigint, rateScaled: bigint, quoteId: string, conversionId: string, transferId: string, key: string, now: Date) {
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
      metadata: { fx_markup_bps: Number(markupBps), rateScaled: rateScaled.toString(), rate: rateString(rateScaled), quoteId, conversionId, from: toWire(from), total: toWire(total), markup: toWire(markup) },
    });
  }

  private viewFromTransfer(t: Transfer, quoteId: string): FxConversionView {
    return { conversionId: t.id, quoteId, from: toWire(t.amount), total: toWire(t.amount), status: 'settled' };
  }

  /** Forgets quotes well past their lock, so the map never grows unbounded. */
  private sweep(now: Date): void {
    for (const [id, h] of this.quotes) if (Date.parse(h.quote.expiresAt) + 10 * QUOTE_TTL_MS < now.getTime()) this.quotes.delete(id);
  }
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

function view(q: FxQuote): FxQuoteView {
  return { quoteId: q.quoteId, from: toWire(q.from), total: toWire(q.total), markup: toWire(q.markup), markupBps: Number(q.markupBps), rate: rateString(q.rateScaled), expiresAt: q.expiresAt };
}

function mapFxError(e: unknown): Error {
  if (e instanceof FxError) {
    if (e.code === 'PROVIDER_UNAVAILABLE') return new DomainError('PROVIDER_UNAVAILABLE', 'Currency conversion is temporarily unavailable; try again with the same key');
    if (e.code === 'QUOTE_EXPIRED' || e.code === 'UNKNOWN_QUOTE') return new DomainError('QUOTE_EXPIRED', 'This quote is no longer available; get a fresh one');
    if (e.code === 'UNSUPPORTED_PAIR' || e.code === 'VALIDATION_FAILED') return new DomainError('VALIDATION_FAILED', e.message);
  }
  return e as Error;
}
