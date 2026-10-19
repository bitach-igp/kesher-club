// JIT authorisation (T-0403, REQ-CRD-003, SEQ-01): the processor asks, we answer inside its budget.
// Order of checks, cheapest refusal first: the card and its status, the controls (channel, MCC,
// country, agent mode), the daily and monthly limits, the purse balance, the plan's card entitlement,
// a velocity rule; then one hold journal wallet → pending keyed by the authorisation id. Anything that
// throws or runs past the budget declines TIMEOUT: a decline is cheap to reverse, an approval is not.
// Signature verification and the wire shapes belong to the port; PAN never appears here.
// Which purse pays (T-0409, ADR-007, ADR-014 decision 10): the shekel purse first for a merchant in Israel,
// the authorisation's own currency elsewhere; when that purse is short, the other one pays, converted at the
// club rate with the plan markup. One purse pays the whole amount. The hold always lands in the pending purse
// of the authorisation's currency, which is what the processor settles; the rate is looked up only when a
// conversion is the way to approve, so the common path costs nothing extra.
import { applyBps, DomainError, money, toWire, type Currency, type Money, type Posting } from '@kesher/domain';
import { applyRate, CardIssuingError, type CardIssuingPort, type JitAuthorizationRequest, type JitDecision } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { EntitlementService } from '../billing/entitlements.ts';
import type { MembershipService } from '../billing/memberships.ts';
import type { PlanService } from '../billing/plans.ts';
import type { Database } from '../db.ts';
import type { AppliedRate, RateService } from '../fx/rates.ts';
import { rateString } from '../fx/service.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { IntentService } from '../intents/service.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import { controlsFromWire, type WireControls } from './service.ts';

/** Entitlement key a plan may carry to cap card spend per month, in minor units. */
export const CARD_SPEND_ENTITLEMENT = 'card.monthlySpendMinor';
/** Risk rule v1: more than this many approvals on one card within a minute is a velocity decline. */
export const VELOCITY_LIMIT_PER_MINUTE = 10;
/** Kill switch for every agentic authorisation, whatever the funder's per-card mode (REQ-CRD-008). */
export const AGENTIC_FLAG = 'card.agentic';
/** Our own budget, under the processor's. Past it we decline rather than let the processor time out on us. */
export const DECISION_BUDGET_MS = 250;
export const holdKey = (authId: string): string => `jit:${authId}`;

export interface JitDeps {
  db: Database;
  port: CardIssuingPort;
  ledger: PostgresLedger;
  accounts: AccountService;
  memberships: MembershipService;
  entitlements: EntitlementService;
  plans: PlanService;
  flags: FeatureFlags;
  intents: IntentService;
  /** Club rates and plan markups for a purchase the other purse pays; without them only the same-currency purse is tried. */
  fx?: { rates: Pick<RateService, 'rateFor'>; markups: { markupFor(partyId: string): Promise<bigint> } };
  budgetMs?: number;
}

/** The purse that pays, and the conversion when it is not the authorisation's currency. */
interface Funding {
  currency: Currency;
  wallet: string;
  conversion?: { rate: AppliedRate; gross: bigint; markup: bigint; markupBps: bigint };
}

export interface JitOutcome {
  decision: JitDecision;
  /** Set when a hold was posted (or found, on a replay). */
  journalId?: string;
  elapsedMs: number;
}

interface CardRow {
  id: string;
  party_id: string;
  status: 'inactive' | 'active' | 'frozen' | 'closed';
  currency: Currency;
  controls: WireControls;
}

const decline = (reason: Extract<JitDecision, { approve: false }>['reason']): JitDecision => ({ approve: false, reason });

export class JitService {
  private readonly budgetMs: number;
  constructor(private readonly d: JitDeps) {
    this.budgetMs = d.budgetMs ?? DECISION_BUDGET_MS;
  }

  /** The HTTP body: verify and parse through the port, decide, encode in the processor's format. */
  async handle(headers: Record<string, string>, rawBody: string, now: Date): Promise<{ status: number; body: unknown; outcome?: JitOutcome }> {
    let req: JitAuthorizationRequest;
    try {
      req = await this.d.port.parseAuthorization(headers, rawBody);
    } catch (e) {
      if (e instanceof CardIssuingError && e.code === 'BAD_SIGNATURE') throw new DomainError('UNAUTHENTICATED', 'Authorisation request signature could not be verified');
      throw new DomainError('VALIDATION_FAILED', 'Authorisation request could not be parsed');
    }
    const outcome = await this.decide(req, now);
    return { ...this.d.port.encodeDecision(outcome.decision), outcome };
  }

  /** Fail closed: a throw or a budget overrun is a TIMEOUT decline, never an approval and never a 500. */
  async decide(req: JitAuthorizationRequest, now: Date): Promise<JitOutcome> {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<JitOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ decision: decline('TIMEOUT'), elapsedMs: performance.now() - started }), this.budgetMs);
    });
    try {
      return await Promise.race([this.evaluate(req, now, started), budget]);
    } catch {
      return { decision: decline('TIMEOUT'), elapsedMs: performance.now() - started };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async evaluate(req: JitAuthorizationRequest, now: Date, started: number): Promise<JitOutcome> {
    const done = (decision: JitDecision, journalId?: string): JitOutcome => ({ decision, ...(journalId ? { journalId } : {}), elapsedMs: performance.now() - started });
    if (req.amount.minor <= 0n) return done(decline('LIMIT_EXCEEDED'));

    // One round trip: the prior answer for a replayed authorisation id, the card, and both purses with
    // the wallet balance. A replay answers what the first one did, without a second hold.
    const lookup = await this.d.db.query<LookupRow>(
      `select (select id from ledger.journal where idempotency_key = $1) as prior_journal,
              c.id, c.party_id, c.status, c.currency, c.controls,
              w.id as wallet_id, wb.balance_minor::text as wallet_balance, p.id as pending_id, t.status as token_status,
              o.id as other_wallet_id, ob.balance_minor::text as other_balance
         from (select 1) as one
         left join cards.card c on c.processor_card_id = $2
         left join ledger.account w on w.owner_party_id = c.party_id and w.currency = $3 and w.type = 'wallet'
         left join ops.account_balance wb on wb.account_id = w.id
         left join ledger.account p on p.owner_party_id = c.party_id and p.currency = $3 and p.type = 'pending'
         left join cards.card_token t on t.card_id = c.id and t.token_id = $4
         left join ledger.account o on o.owner_party_id = c.party_id and o.currency = $5 and o.type = 'wallet'
         left join ops.account_balance ob on ob.account_id = o.id`,
      [holdKey(req.authId), req.cardId, req.amount.currency, req.tokenId ?? '', otherCurrency(req.amount.currency)],
    );
    const row = lookup.rows[0]!;
    if (row.prior_journal) return done({ approve: true, holdAmount: req.amount }, row.prior_journal);
    if (!row.id || !row.party_id || !row.status || !row.controls || !row.currency || row.status === 'closed') return done(decline('UNKNOWN_CARD'));
    const card: CardRow = { id: row.id, party_id: row.party_id, status: row.status, currency: row.currency, controls: row.controls };
    if (card.status !== 'active') return done(decline('CARD_FROZEN'));
    // A wallet token we know to be suspended or deleted pays nothing, whatever the card's own status (REQ-CRD-004).
    if (row.token_status && row.token_status !== 'active') return done(decline('CARD_FROZEN'));

    const controls = controlsFromWire(card.controls);
    if ((req.channel === 'atm' && !controls.atm) || (req.channel === 'online' && !controls.online)) return done(decline('CHANNEL_BLOCKED'));
    if (controls.blockedMccs.includes(req.merchant.mcc)) return done(decline('MCC_BLOCKED'));
    if (controls.allowedCountries && !controls.allowedCountries.includes(req.merchant.country)) return done(decline('COUNTRY_BLOCKED'));
    // Agentic purchases (REQ-CRD-008): the flag is the kill switch; then the funder's per-card mode.
    // off declines; under_amount approves below the threshold in the card's currency; anything else
    // needs an approval the member gave in-app, which one authorisation then spends.
    let approvalToSpend: string | undefined;
    if (req.agentic) {
      if (!(await this.d.flags.isOn(AGENTIC_FLAG, { partyId: card.party_id }))) return done(decline('AGENT_NOT_ALLOWED'));
      const mode = controls.agentPurchases;
      if (mode === 'off') return done(decline('AGENT_NOT_ALLOWED'));
      const underThreshold = typeof mode === 'object' && req.amount.currency === card.currency && req.amount.minor <= mode.underMinor;
      if (!underThreshold) {
        const tokenId = req.tokenId ?? 'agentic';
        const approved = await this.d.intents.approvedAgentPurchase(card.party_id, tokenId, req.merchant.mcc, req.amount, now);
        if (!approved) {
          await this.d.intents.openAgentPurchase({ partyId: card.party_id, cardId: card.id, tokenId, authId: req.authId, amount: req.amount, mcc: req.merchant.mcc, country: req.merchant.country, merchantName: req.merchant.name }, now);
          return done(decline('AGENT_NOT_ALLOWED'));
        }
        approvalToSpend = approved.id;
      }
    }

    const currency = req.amount.currency;
    if (!row.wallet_id && !row.other_wallet_id) return done(decline('INSUFFICIENT_FUNDS')); // no purse, nothing to spend
    // The pending purse is provisioned with the wallet; a member funded before provisioning gets it here.
    const pending = row.pending_id ?? (await this.d.accounts.memberAccount(card.party_id, 'pending', currency));

    if (controls.dailyLimit && controls.dailyLimit.currency === currency) {
      const spent = await this.heldSince(card.id, pending, startOfUtcDay(now));
      if (spent + req.amount.minor > controls.dailyLimit.minor) return done(decline('LIMIT_EXCEEDED'));
    }
    if (controls.monthlyLimit && controls.monthlyLimit.currency === currency) {
      const spent = await this.heldSince(card.id, pending, startOfUtcMonth(now));
      if (spent + req.amount.minor > controls.monthlyLimit.minor) return done(decline('LIMIT_EXCEEDED'));
    }

    const funding = await this.funding(card.party_id, req, row, now);
    if (!funding) return done(decline('INSUFFICIENT_FUNDS'));

    // Velocity and the plan's card cap in parallel: independent reads, one wait.
    const [recent, membership] = await Promise.all([
      this.d.db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where kind = 'auth_hold' and metadata->>'cardId' = $1 and effective_at > $2`, [card.id, new Date(now.getTime() - 60_000)]),
      this.d.memberships.forMember(card.party_id),
    ]);
    if ((recent.rows[0]?.n ?? 0) >= VELOCITY_LIMIT_PER_MINUTE) return done(decline('LIMIT_EXCEEDED'));
    // The plan's card cap governs an active membership; a paused, past-due or cancelled one leaves the
    // member's own money to the balance check alone.
    const active = membership?.status === 'active' ? membership : undefined;
    const plan = active ? await this.d.plans.get(active.planCode, active.planVersion) : undefined;
    const capped = Boolean(plan?.entitlements[CARD_SPEND_ENTITLEMENT]);
    if (active && capped) {
      const e = await this.d.entitlements.can(active, CARD_SPEND_ENTITLEMENT, req.amount.minor, now);
      if (!e.allowed) return done(decline('LIMIT_EXCEEDED'));
    }

    const journal = await this.d.ledger.post({
      idempotencyKey: holdKey(req.authId),
      kind: 'auth_hold',
      effectiveAt: now,
      postings: await this.holdLegs(funding, req.amount, pending),
      metadata: {
        cardId: card.id,
        authId: req.authId,
        mcc: req.merchant.mcc,
        country: req.merchant.country,
        channel: req.channel,
        ...(req.tokenId ? { tokenId: req.tokenId } : {}),
        ...(req.agentic ? { agentic: true } : {}),
        ...(funding.conversion
          ? {
              fx_rate_version: funding.conversion.rate.version,
              fx_rate_id: funding.conversion.rate.rateId,
              fx_markup_bps: Number(funding.conversion.markupBps),
              rate: rateString(funding.conversion.rate.rateScaled),
              paidFrom: toWire(money(funding.conversion.gross + funding.conversion.markup, funding.currency)),
              markup: toWire(money(funding.conversion.markup, funding.currency)),
            }
          : {}),
      },
    });
    if (active && capped) await this.d.entitlements.consume(active, CARD_SPEND_ENTITLEMENT, req.amount.minor, holdKey(req.authId), now);
    if (approvalToSpend) await this.d.intents.consumeAgentPurchase(approvalToSpend, req.authId);
    return done({ approve: true, holdAmount: req.amount }, journal.id);
  }

  /**
   * The purse that pays the whole amount: the shekel purse first for a merchant in Israel, the authorisation's
   * currency elsewhere, then the other. A purse in another currency pays the amount converted at the club rate
   * plus the plan markup; without a valid rate (or without the FX deps) that purse is skipped, never guessed.
   */
  private async funding(partyId: string, req: JitAuthorizationRequest, row: LookupRow, now: Date): Promise<Funding | undefined> {
    const auth = req.amount.currency;
    const other = otherCurrency(auth);
    // Credit-normal purses: the ledger balance is negative what the member owns.
    const purses: Record<Currency, { id: string | null; available: bigint }> = {
      [auth]: { id: row.wallet_id, available: -BigInt(row.wallet_balance ?? '0') },
      [other]: { id: row.other_wallet_id, available: -BigInt(row.other_balance ?? '0') },
    } as Record<Currency, { id: string | null; available: bigint }>;
    const order: Currency[] = req.merchant.country === 'IL' && auth !== 'ILS' ? ['ILS', auth] : [auth, other];
    for (const c of order) {
      const p = purses[c];
      if (!p.id) continue;
      if (c === auth) {
        if (p.available >= req.amount.minor) return { currency: c, wallet: p.id };
        continue;
      }
      if (!this.d.fx) continue;
      let rate: AppliedRate;
      try {
        rate = await this.d.fx.rates.rateFor(auth, c, now);
      } catch {
        continue; // no valid club rate: this purse cannot pay
      }
      const markupBps = await this.d.fx.markups.markupFor(partyId);
      const gross = applyRate(req.amount.minor, rate.rateScaled);
      const markup = applyBps(money(gross, c), markupBps).minor;
      if (gross > 0n && p.available >= gross + markup) return { currency: c, wallet: p.id, conversion: { rate, gross, markup, markupBps } };
    }
    return undefined;
  }

  /**
   * Wallet → pending in the authorisation's currency. Converted: the paying purse gives the gross plus the
   * markup; fx_position takes the gross and fee income the markup in that currency, and fx_position pays the
   * authorisation amount into pending in the authorisation's currency. Balanced per currency.
   */
  private async holdLegs(f: Funding, amount: Money, pending: string): Promise<Posting[]> {
    const { minor, currency } = amount;
    if (!f.conversion) {
      return [
        { accountId: f.wallet, currency, amountMinor: minor },
        { accountId: pending, currency, amountMinor: -minor },
      ];
    }
    const { gross, markup } = f.conversion;
    return [
      { accountId: f.wallet, currency: f.currency, amountMinor: gross + markup },
      { accountId: await this.d.accounts.systemAccount('fx_position', f.currency), currency: f.currency, amountMinor: -gross },
      ...(markup > 0n ? [{ accountId: await this.d.accounts.systemAccount('fee_income', f.currency), currency: f.currency, amountMinor: -markup }] : []),
      { accountId: await this.d.accounts.systemAccount('fx_position', currency), currency, amountMinor: minor },
      { accountId: pending, currency, amountMinor: -minor },
    ];
  }

  /** Minor units held on this card's pending purse since `from` (the credit side of each hold). */
  private async heldSince(cardId: string, pendingAccount: string, from: Date): Promise<bigint> {
    const r = await this.d.db.query<{ held: string }>(
      `select coalesce(sum(-p.amount_minor), 0)::text as held from ledger.journal j join ledger.posting p on p.journal_id = j.id
        where j.kind = 'auth_hold' and j.metadata->>'cardId' = $1 and p.account_id = $2 and j.effective_at >= $3`,
      [cardId, pendingAccount, from],
    );
    return BigInt(r.rows[0]?.held ?? '0');
  }
}

interface LookupRow {
  prior_journal: string | null;
  id: string | null;
  party_id: string | null;
  status: CardRow['status'] | null;
  currency: Currency | null;
  controls: WireControls | null;
  wallet_id: string | null;
  wallet_balance: string | null;
  pending_id: string | null;
  token_status: 'active' | 'suspended' | 'deleted' | null;
  other_wallet_id: string | null;
  other_balance: string | null;
}

const otherCurrency = (c: Currency): Currency => (c === 'USD' ? 'ILS' : 'USD');

const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfUtcMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export const asMoney = (minor: bigint, currency: Currency): Money => money(minor, currency);
