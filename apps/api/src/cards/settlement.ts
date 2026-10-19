// Card settlement (T-0410, REQ-CRD-003, SEQ-01, ADR-014 decision 9): the processor clears an approved
// authorisation for what the merchant finally claimed, and the hold JIT posted (wallet → pending, keyed
// `jit:{authId}`) turns into money owed to the processor. Clearing the hold amount H for C, in the
// authorisation's currency: pending gives back H, partner_settlement takes C, and the difference comes from
// (C above H) or goes back to (C below H) the purse that paid. A hold nobody clears within 7 days is
// released to that purse whole.
//
// The journal that ends a hold, by clearing or by release, is keyed `jit:{authId}:end`, so whichever posts
// first wins and the other finds it: a hold is never released twice. A clearing that arrives after the
// release (late presentment) draws the whole amount from the purse that paid, under `jit:{authId}:late`.
//
// A converted hold (T-0409) clears in the authorisation's currency; the difference moves through
// fx_position at the hold's own club rate. Money drawn converts with the hold's markup, as the hold did.
// Money given back takes its markup with it (ADR-016, T-0411): the member ends up paying exactly what the
// cleared amount costs at the hold's rate and markup, so a hold released unspent costs nothing.
import { applyBps, DomainError, fromWire, money, type Currency, type Money, type Posting } from '@kesher/domain';
import { applyRate } from '@kesher/ports';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import { holdKey } from './jit.ts';

export const CLEARING_EVENT = 'authorization.cleared';
/** An authorisation with no clearing this long after it was held is released (ADR-014 decision 9). */
export const HOLD_RELEASE_MS = 7 * 86_400_000;
export const CLEARING_JOURNAL_KIND = 'card_clearing';
export const RELEASE_JOURNAL_KIND = 'auth_release';
export const endKey = (authId: string): string => `${holdKey(authId)}:end`;
export const lateKey = (authId: string): string => `${holdKey(authId)}:late`;

export interface ClearingEvent {
  eventId: string;
  authId: string;
  amount: Money;
}

export const isClearingPayload = (payload: unknown): boolean => (payload as { type?: unknown } | undefined)?.type === CLEARING_EVENT;

export function parseClearingEvent(payload: unknown): ClearingEvent {
  const p = payload as { eventId?: unknown; type?: unknown; authId?: unknown; amount?: unknown } | undefined;
  if (!p || typeof p.eventId !== 'string' || typeof p.authId !== 'string' || p.type !== CLEARING_EVENT) throw new DomainError('VALIDATION_FAILED', 'Clearing event lacks eventId, authId or its type');
  let amount: Money;
  try {
    amount = fromWire(p.amount as Parameters<typeof fromWire>[0]);
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'Clearing amount is not money');
  }
  if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Clearing amount must be positive');
  return { eventId: p.eventId, authId: p.authId, amount };
}

/** What a hold journal holds: H on the pending purse, the purse that paid, and the conversion, if any. */
interface Hold {
  authId: string;
  held: Money;
  pending: string;
  paidFrom: { account: string; currency: Currency };
  /** What the hold converted: its rate and markup, and what the paying purse gave (gross + markup). */
  conversion?: { rateScaled: bigint; markupBps: bigint; paid: bigint; markup: bigint };
}

export class CardSettlementService {
  private readonly db: Database;
  private readonly ledger: PostgresLedger;
  private readonly accounts: AccountService;
  constructor(
    db: Database,
    ledger: PostgresLedger,
    accounts: AccountService,
  ) {
    this.db = db;
    this.ledger = ledger;
    this.accounts = accounts;
  }

  /** Applies a verified clearing webhook once, however often it arrives. */
  async applyClearing(event: InboundEvent, now: Date): Promise<{ authId: string; journalId: string; late: boolean }> {
    const c = parseClearingEvent(event.payload);
    const hold = await this.hold(c.authId);
    if (!hold) throw new DomainError('NOT_FOUND', `No hold for authorisation ${c.authId}`);
    if (c.amount.currency !== hold.held.currency) throw new DomainError('VALIDATION_FAILED', 'A clearing settles in the authorisation currency');
    const metadata = { authId: c.authId, eventId: c.eventId, held: hold.held.minor.toString(), cleared: c.amount.minor.toString(), currency: c.amount.currency };
    const ended = await this.ledger.post({ idempotencyKey: endKey(c.authId), kind: CLEARING_JOURNAL_KIND, effectiveAt: now, postings: await this.legs(hold, c.amount.minor, true), metadata });
    if (ended.kind === CLEARING_JOURNAL_KIND) return { authId: c.authId, journalId: ended.id, late: false };
    // Released before the merchant claimed: the whole amount comes from the purse that paid.
    const late = await this.ledger.post({ idempotencyKey: lateKey(c.authId), kind: CLEARING_JOURNAL_KIND, effectiveAt: now, postings: await this.legs(hold, c.amount.minor, false), metadata: { ...metadata, late: true } });
    return { authId: c.authId, journalId: late.id, late: true };
  }

  /** Releases every hold older than 7 days that nothing ended, oldest first; one failure does not stop the rest. */
  async releaseExpired(now: Date, limit = 200): Promise<{ released: number; errors: { authId: string; error: string }[]; oldestOpenMs: number }> {
    const due = await this.db.query<{ auth_id: string }>(
      `select j.metadata->>'authId' as auth_id from ledger.journal j
        where j.kind = 'auth_hold' and j.effective_at <= $1
          and not exists (select 1 from ledger.journal e where e.idempotency_key = j.idempotency_key || ':end')
        order by j.effective_at limit $2`,
      [new Date(now.getTime() - HOLD_RELEASE_MS), limit],
    );
    let released = 0;
    const errors: { authId: string; error: string }[] = [];
    for (const { auth_id } of due.rows) {
      try {
        const hold = await this.hold(auth_id);
        if (!hold) throw new Error('hold journal lacks its wallet or pending leg');
        const metadata = { authId: auth_id, held: hold.held.minor.toString(), currency: hold.held.currency, reason: 'no clearing within 7 days' };
        const j = await this.ledger.post({ idempotencyKey: endKey(auth_id), kind: RELEASE_JOURNAL_KIND, effectiveAt: now, postings: await this.legs(hold, 0n, true), metadata });
        if (j.kind === RELEASE_JOURNAL_KIND) released += 1;
      } catch (e) {
        errors.push({ authId: auth_id, error: (e as Error).message.slice(0, 200) });
      }
    }
    const open = await this.db.query<{ oldest: string | Date | null }>(
      `select min(j.effective_at) as oldest from ledger.journal j where j.kind = 'auth_hold' and not exists (select 1 from ledger.journal e where e.idempotency_key = j.idempotency_key || ':end')`,
    );
    const oldest = open.rows[0]?.oldest;
    return { released, errors, oldestOpenMs: oldest ? now.getTime() - new Date(oldest).getTime() : 0 };
  }

  /**
   * The journal that settles `cleared` (0 for a release) against the hold. With the hold still in pending,
   * pending gives back H; the difference D = C − H, or the whole C on a late clearing, comes from (D > 0) or
   * goes back to (D < 0) the purse that paid. Balanced per currency.
   */
  private async legs(h: Hold, cleared: bigint, pendingHeld: boolean): Promise<Posting[]> {
    const ccy = h.held.currency;
    const legs: Posting[] = [];
    if (pendingHeld) legs.push({ accountId: h.pending, currency: ccy, amountMinor: h.held.minor });
    if (cleared > 0n) legs.push({ accountId: await this.accounts.systemAccount('partner_settlement', ccy), currency: ccy, amountMinor: -cleared });
    const draw = cleared - (pendingHeld ? h.held.minor : 0n);
    if (draw === 0n) return legs;
    if (!h.conversion) return [...legs, { accountId: h.paidFrom.account, currency: ccy, amountMinor: draw }];

    const pay = h.paidFrom.currency;
    const fxAuth = await this.accounts.systemAccount('fx_position', ccy);
    const fxPay = await this.accounts.systemAccount('fx_position', pay);
    if (draw > 0n) {
      // More was claimed than held: convert the extra as the hold did, markup included.
      const gross = applyRate(draw, h.conversion.rateScaled);
      const markup = applyBps(money(gross, pay), h.conversion.markupBps).minor;
      return [
        ...legs,
        { accountId: fxAuth, currency: ccy, amountMinor: draw },
        { accountId: h.paidFrom.account, currency: pay, amountMinor: gross + markup },
        { accountId: fxPay, currency: pay, amountMinor: -gross },
        ...(markup > 0n ? [{ accountId: await this.accounts.systemAccount('fee_income', pay), currency: pay, amountMinor: -markup }] : []),
      ];
    }
    // Less was claimed, or nothing (ADR-016): the purse that paid ends up charged what the cleared amount
    // costs at the hold's rate and markup, so the rest of the gross and of the markup go back to it.
    const costGross = applyRate(cleared, h.conversion.rateScaled);
    const costMarkup = applyBps(money(costGross, pay), h.conversion.markupBps).minor;
    const markupBack = h.conversion.markup - costMarkup;
    const grossBack = h.conversion.paid - h.conversion.markup - costGross;
    return [
      ...legs,
      { accountId: fxAuth, currency: ccy, amountMinor: draw },
      { accountId: fxPay, currency: pay, amountMinor: grossBack },
      ...(markupBack > 0n ? [{ accountId: await this.accounts.systemAccount('fee_income', pay), currency: pay, amountMinor: markupBack }] : []),
      { accountId: h.paidFrom.account, currency: pay, amountMinor: -(grossBack + markupBack) },
    ];
  }

  private async hold(authId: string): Promise<Hold | undefined> {
    const r = await this.db.query<{ metadata: Record<string, unknown>; account_id: string; type: string; currency: Currency; amount_minor: string }>(
      `select j.metadata, p.account_id, a.type::text as type, p.currency::text as currency, p.amount_minor::text as amount_minor
         from ledger.journal j join ledger.posting p on p.journal_id = j.id join ledger.account a on a.id = p.account_id
        where j.idempotency_key = $1 and j.kind = 'auth_hold'`,
      [holdKey(authId)],
    );
    const pending = r.rows.find((x) => x.type === 'pending');
    const wallet = r.rows.find((x) => x.type === 'wallet');
    const fee = r.rows.find((x) => x.type === 'fee_income');
    if (!pending || !wallet) return undefined;
    const m = r.rows[0]!.metadata;
    const rate = typeof m['rate'] === 'string' ? m['rate'] : undefined;
    return {
      authId,
      held: money(-BigInt(pending.amount_minor), pending.currency),
      pending: pending.account_id,
      paidFrom: { account: wallet.account_id, currency: wallet.currency },
      ...(rate && wallet.currency !== pending.currency ? { conversion: { rateScaled: scaled(rate), markupBps: BigInt(Number(m['fx_markup_bps'] ?? 0)), paid: BigInt(wallet.amount_minor), markup: fee ? -BigInt(fee.amount_minor) : 0n } } : {}),
    };
  }
}

/** `rateString` back to a scaled rate: "3.700000" → 3_700_000n (six decimals, as written). */
function scaled(rate: string): bigint {
  const [whole, frac = ''] = rate.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
}

/** One processor for the card issuer's webhook: clearings settle, everything else is a token event. */
export function cardIssuingProcessor(d: { provisioning: { applyTokenEvent(e: InboundEvent, now: Date): Promise<unknown> }; settlement: Pick<CardSettlementService, 'applyClearing'> }): (e: InboundEvent, now: Date) => Promise<unknown> {
  return (e, now) => (isClearingPayload(e.payload) ? d.settlement.applyClearing(e, now) : d.provisioning.applyTokenEvent(e, now));
}
