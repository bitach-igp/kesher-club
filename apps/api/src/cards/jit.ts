// JIT authorisation (T-0403, REQ-CRD-003, SEQ-01): the processor asks, we answer inside its budget.
// Order of checks, cheapest refusal first: the card and its status, the controls (channel, MCC,
// country, agent mode), the daily and monthly limits, the purse balance, the plan's card entitlement,
// a velocity rule; then one hold journal wallet → pending keyed by the authorisation id. Anything that
// throws or runs past the budget declines TIMEOUT: a decline is cheap to reverse, an approval is not.
// Signature verification and the wire shapes belong to the port; PAN never appears here.
import { DomainError, money, type Currency, type Money } from '@kesher/domain';
import { CardIssuingError, type CardIssuingPort, type JitAuthorizationRequest, type JitDecision } from '@kesher/ports';
import type { EntitlementService } from '../billing/entitlements.ts';
import type { MembershipService } from '../billing/memberships.ts';
import type { PlanService } from '../billing/plans.ts';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import { controlsFromWire, type WireControls } from './service.ts';

/** Entitlement key a plan may carry to cap card spend per month, in minor units. */
export const CARD_SPEND_ENTITLEMENT = 'card.monthlySpendMinor';
/** Risk rule v1: more than this many approvals on one card within a minute is a velocity decline. */
export const VELOCITY_LIMIT_PER_MINUTE = 10;
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
  budgetMs?: number;
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
    const lookup = await this.d.db.query<{ prior_journal: string | null; id: string | null; party_id: string | null; status: CardRow['status'] | null; controls: WireControls | null; wallet_id: string | null; wallet_balance: string | null; pending_id: string | null; token_status: 'active' | 'suspended' | 'deleted' | null }>(
      `select (select id from ledger.journal where idempotency_key = $1) as prior_journal,
              c.id, c.party_id, c.status, c.controls,
              w.id as wallet_id, wb.balance_minor::text as wallet_balance, p.id as pending_id, t.status as token_status
         from (select 1) as one
         left join cards.card c on c.processor_card_id = $2
         left join ledger.account w on w.owner_party_id = c.party_id and w.currency = $3 and w.type = 'wallet'
         left join ops.account_balance wb on wb.account_id = w.id
         left join ledger.account p on p.owner_party_id = c.party_id and p.currency = $3 and p.type = 'pending'
         left join cards.card_token t on t.card_id = c.id and t.token_id = $4`,
      [holdKey(req.authId), req.cardId, req.amount.currency, req.tokenId ?? ''],
    );
    const row = lookup.rows[0]!;
    if (row.prior_journal) return done({ approve: true, holdAmount: req.amount }, row.prior_journal);
    if (!row.id || !row.party_id || !row.status || !row.controls || row.status === 'closed') return done(decline('UNKNOWN_CARD'));
    const card: CardRow = { id: row.id, party_id: row.party_id, status: row.status, controls: row.controls };
    if (card.status !== 'active') return done(decline('CARD_FROZEN'));
    // A wallet token we know to be suspended or deleted pays nothing, whatever the card's own status (REQ-CRD-004).
    if (row.token_status && row.token_status !== 'active') return done(decline('CARD_FROZEN'));

    const controls = controlsFromWire(card.controls);
    if ((req.channel === 'atm' && !controls.atm) || (req.channel === 'online' && !controls.online)) return done(decline('CHANNEL_BLOCKED'));
    if (controls.blockedMccs.includes(req.merchant.mcc)) return done(decline('MCC_BLOCKED'));
    if (controls.allowedCountries && !controls.allowedCountries.includes(req.merchant.country)) return done(decline('COUNTRY_BLOCKED'));
    // Agentic purchases: off declines here; with_approval and under_amount are T-0406.
    if (req.agentic && controls.agentPurchases === 'off') return done(decline('AGENT_NOT_ALLOWED'));

    const currency = req.amount.currency;
    if (!row.wallet_id) return done(decline('INSUFFICIENT_FUNDS')); // no purse, nothing to spend
    const wallet = row.wallet_id;
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

    // Credit-normal purse: the ledger balance is negative what the member owns.
    const available = -BigInt(row.wallet_balance ?? '0');
    if (available < req.amount.minor) return done(decline('INSUFFICIENT_FUNDS'));

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
      postings: [
        { accountId: wallet, currency, amountMinor: req.amount.minor },
        { accountId: pending, currency, amountMinor: -req.amount.minor },
      ],
      metadata: { cardId: card.id, authId: req.authId, mcc: req.merchant.mcc, country: req.merchant.country, channel: req.channel, ...(req.tokenId ? { tokenId: req.tokenId } : {}), ...(req.agentic ? { agentic: true } : {}) },
    });
    if (active && capped) await this.d.entitlements.consume(active, CARD_SPEND_ENTITLEMENT, req.amount.minor, holdKey(req.authId), now);
    return done({ approve: true, holdAmount: req.amount }, journal.id);
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

const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfUtcMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export const asMoney = (minor: bigint, currency: Currency): Money => money(minor, currency);
