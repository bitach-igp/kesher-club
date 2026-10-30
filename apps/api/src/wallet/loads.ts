// Loads (T-0501, REQ-WAL-002; T-0502, REQ-WAL-003): a member tops up a purse by card, Apple Pay or
// Google Pay, or by ACH when funding.ach is on, through the FundingPort. Every load is a transfer of
// kind 'load' driven by the LoadWorkflow (SEQ-02), whose id is the member's Idempotency-Key; the vendor
// pull carries that same key, so a rerun after any failure finds the pull it already made. Money lands
// only when the vendor confirms: the workflow posts one journal, partner_settlement → wallet, keyed
// `{workflowId}:settle`, so a webhook arriving after a synchronous success, or twice, changes nothing
// (REQ-LED-003). An ACH load the bank holds posts partner_settlement → pending under `{workflowId}:hold`
// (the member sees it "on hold until" the release date) and the worker's release job moves it to the
// wallet on that date under `{workflowId}:release`; an ACH return before then reverses the hold.
//
// A load credits the purse the member chooses (T-0517, REQ-WAL-006, ADR-007). When the instrument settles in
// the other currency, the load is priced once when it begins, at the club rate less the purse owner's plan
// markup like every conversion (ADR-014 decision 2, T-0519), and the
// price rides on the transfer: settle, hold and release book partner_settlement in the instrument currency,
// fx_position in both, and the purse in its own currency, so no replay or late webhook ever re-prices it.
// With no valid club rate the load is refused before the vendor is asked for anything.
//
// A US institution's ACH pull (T-0617, REQ-INS-009) is the same workflow with the institution as payer and
// payee: a transfer of kind 'deposit', held in the institution's own `pending` account and released into its
// `institution_master`, so the release job, the webhook and a return during the hold all apply unchanged. Its
// settlement and release journals are kind 'deposit' and carry the institution, as the monthly export reads them.
//
// `runLoad` is the deterministic workflow body, pure over `LoadActivities`, so Temporal (ADR-002) can
// host it unchanged; `LoadService` is both the activities and the HTTP-facing entry. The vendor's
// client secret leaves in the response and is never stored or logged.
import { applyBps, DomainError, fromWire, money, sub, toWire, type Currency, type Money, type Posting } from '@kesher/domain';
import { applyRate, FundingError, type FundingMethod, type FundingPort, type Load as VendorLoad } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { MembershipService } from '../billing/memberships.ts';
import type { Database } from '../db.ts';
import type { RateService } from '../fx/rates.ts';
import { rateString } from '../fx/service.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferConversion, TransferService } from '../transfers/service.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import type { WebhookVerifier } from '../webhooks/verify.ts';

export const WALLET_FLAG = 'wallet.enabled';
/** Provider name the funding webhooks arrive under: POST /hooks/funding. */
export const FUNDING_PROVIDER = 'funding';
export const ACH_FLAG = 'funding.ach';
export const LOAD_METHODS: readonly FundingMethod[] = ['card', 'apple_pay', 'google_pay'];
export const PURSE_CURRENCIES: readonly Currency[] = ['USD', 'ILS'];
/** Journal kinds: the settlement (one per load, ever), the ACH hold into pending, and its release into the wallet. */
export const LOAD_JOURNAL_KIND = 'load';
export const HOLD_JOURNAL_KIND = 'load_hold';
export const RELEASE_JOURNAL_KIND = 'load_release';
/** An institution's ACH pull lands as a deposit (T-0617), the journal kind T-0614's recorded deposits post. */
export const INSTITUTION_DEPOSIT_JOURNAL_KIND = 'deposit';

export type LoadState = 'created' | 'requires_action' | 'processing' | 'on_hold' | 'settled' | 'failed';

export interface LoadInput {
  /** Who pays (their payment method, the vendor's customer). */
  payerPartyId: string;
  /** Whose purse is loaded: the payer, or a member the payer funds. */
  memberPartyId: string;
  method: FundingMethod;
  amount: Money;
  paymentMethodId?: string;
  /** The purse credited; the amount's currency when absent. */
  purse?: Currency;
  /** An institution's ACH pull (T-0617): payer and payee are the institution, and it lands in its own account. */
  kind?: 'deposit';
}

/** The OpenAPI `Load`. */
export interface LoadView {
  id: string;
  state: LoadState;
  amount: ReturnType<typeof toWire>;
  holdUntil?: string;
  clientSecret?: string;
  /** What the purse is credited, when the load converts. */
  credited?: ReturnType<typeof toWire>;
  /** The club rate version the load converted at. */
  rateVersion?: number;
}

export interface LoadActivities {
  /** The transfer for this workflow id, created on the first run and found on every later one. */
  begin(input: LoadInput, workflowId: string, now: Date): Promise<Transfer>;
  submit(transfer: Transfer, now: Date): Promise<Transfer>;
  /** The vendor pull, keyed by the workflow id: safe to repeat. */
  pull(input: LoadInput, workflowId: string): Promise<VendorLoad>;
  /** Remembers which vendor load belongs to the transfer so its webhooks find it. */
  link(transfer: Transfer, load: VendorLoad): Promise<void>;
  settle(transfer: Transfer, load: VendorLoad, workflowId: string, now: Date): Promise<Transfer>;
  /** The bank's hold: the money shows in the member's pending purse until `holdUntil` (REQ-WAL-003). */
  hold(transfer: Transfer, holdUntil: string, now: Date): Promise<Transfer>;
  /** On the hold date: pending → wallet, and the transfer settles. */
  release(transfer: Transfer, now: Date): Promise<Transfer>;
  /** A held load that fails (an ACH return) reverses its hold journal. */
  fail(transfer: Transfer, code: string, now: Date): Promise<Transfer>;
}

export interface LoadRun {
  workflowId: string;
  transfer: Transfer;
  /** Set while the vendor still needs the member (payment sheet) or time (processing). */
  awaiting?: 'action' | 'vendor';
  /** For the payment sheet; in the response only. */
  clientSecret?: string;
  /** True when the run found a transfer a previous run had already finished. */
  replayed: boolean;
}

/**
 * The workflow body. created → submitted → (vendor) → settled | failed | pending_hold, or left
 * submitted while the vendor is still working; a rerun resumes from wherever the record stands.
 */
export async function runLoad(a: LoadActivities, input: LoadInput, workflowId: string, now: Date): Promise<LoadRun> {
  let t = await a.begin(input, workflowId, now);
  if (t.state === 'settled' || t.state === 'failed' || t.state === 'cancelled' || t.state === 'reversed' || t.state === 'pending_hold') return { workflowId, transfer: t, replayed: true };
  const replayed = t.state !== 'created';
  if (t.state === 'created') t = await a.submit(t, now);
  let load: VendorLoad;
  try {
    load = await a.pull(input, workflowId);
  } catch (e) {
    if (e instanceof FundingError && e.code === 'DECLINED') return { workflowId, transfer: await a.fail(t, e.code, now), replayed };
    // Anything else (outage, bad input) leaves the transfer submitted: the same key reruns the pull.
    throw e;
  }
  await a.link(t, load);
  return { ...(await applyVendorState(a, t, load, workflowId, now)), replayed };
}

/** Moves the transfer to where the vendor says the load stands. Idempotent: a state already reached is left alone. */
export async function applyVendorState(a: LoadActivities, t: Transfer, load: VendorLoad, workflowId: string, now: Date): Promise<Omit<LoadRun, 'replayed'>> {
  switch (load.status) {
    case 'succeeded':
      // A held load stays held: the bank's hold days govern, and the release job settles it on the date.
      return { workflowId, transfer: t.state === 'settled' || t.state === 'pending_hold' ? t : await a.settle(t, load, workflowId, now) };
    case 'failed':
      return { workflowId, transfer: t.state === 'failed' ? t : await a.fail(t, load.failureCode ?? 'VENDOR_FAILED', now) };
    case 'on_hold':
      return { workflowId, transfer: t.state === 'pending_hold' || !load.holdUntil ? t : await a.hold(t, load.holdUntil, now) };
    case 'requires_action':
      return { workflowId, transfer: t, awaiting: 'action', ...(load.clientSecret ? { clientSecret: load.clientSecret } : {}) };
    case 'processing':
      return { workflowId, transfer: t, awaiting: 'vendor' };
  }
}

export const settleKey = (workflowId: string): string => `${workflowId}:settle`;
export const holdKey = (workflowId: string): string => `${workflowId}:hold`;
export const releaseKey = (workflowId: string): string => `${workflowId}:release`;

interface Deps {
  db: Database;
  port: FundingPort;
  ledger: PostgresLedger;
  accounts: AccountService;
  transfers: TransferService;
  memberships: MembershipService;
  flags: FeatureFlags;
  /** Registry provider name, the key space of ops.external_ref. */
  provider: string;
  /** The club rates a cross-currency load converts at; without them only same-currency loads go. */
  rates?: Pick<RateService, 'rateFor'>;
  /** The purse owner's plan markup in basis points (FxService.markupFor); conversions need it beside the rates. */
  markups?: { markupFor(partyId: string): Promise<bigint> };
}

export class LoadService implements LoadActivities {
  private readonly d: Deps;
  constructor(d: Deps) {
    this.d = d;
  }

  /** POST /loads: the gate, the eligibility, then the workflow, synchronously, so the payment sheet's secret can go back. */
  async request(payerPartyId: string, body: unknown, key: string, now: Date): Promise<LoadView> {
    if (!(await this.d.flags.isOn(WALLET_FLAG))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
    const input = await this.parse(payerPartyId, body);
    const run = await runLoad(this, input, key, now);
    return this.view(run);
  }

  // ---- activities ----

  /** A replay finds its transfer and keeps its price; a first run prices the conversion before anything exists. */
  async begin(input: LoadInput, workflowId: string, now: Date): Promise<Transfer> {
    const found = await this.d.transfers.byKey(workflowId);
    const conversion = found ? undefined : await this.price(input, now);
    const kind = input.kind ?? 'load';
    const t = found ?? (await this.d.transfers.create({ idempotencyKey: workflowId, kind, fromPartyId: input.payerPartyId, toPartyId: input.memberPartyId, amount: input.amount, ...(conversion ? { conversion } : {}) }, now));
    if (t.kind !== kind) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
    return t;
  }

  submit(transfer: Transfer, now: Date): Promise<Transfer> {
    return this.d.transfers.apply(transfer.id, 'submit', now);
  }

  async pull(input: LoadInput, workflowId: string): Promise<VendorLoad> {
    try {
      return await this.d.port.createLoad({ customerId: input.payerPartyId, method: input.method, amount: input.amount, ...(input.paymentMethodId ? { paymentMethodId: input.paymentMethodId } : {}) }, workflowId);
    } catch (e) {
      if (e instanceof FundingError && e.code === 'DECLINED') throw e;
      throw mapFundingError(e);
    }
  }

  async link(transfer: Transfer, load: VendorLoad): Promise<void> {
    await this.d.db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('transfer', $1, $2, $3) on conflict do nothing`, [transfer.id, this.d.provider, load.loadId]);
  }

  async settle(transfer: Transfer, load: VendorLoad, workflowId: string, now: Date): Promise<Transfer> {
    if (transfer.state === 'pending_hold') return this.release(transfer, now);
    const journal = await this.d.ledger.post({
      idempotencyKey: settleKey(workflowId),
      kind: journalKind(transfer, LOAD_JOURNAL_KIND),
      transferId: transfer.id,
      effectiveAt: now,
      postings: await this.legs(transfer, 'wallet'),
      metadata: { workflowId, method: load.method, provider: this.d.provider, loadId: load.loadId, ...conversionMetadata(transfer), ...institutionMetadata(transfer) },
    });
    return this.d.transfers.apply(transfer.id, 'settle', now, { journalId: journal.id });
  }

  async hold(transfer: Transfer, holdUntil: string, now: Date): Promise<Transfer> {
    const workflowId = transfer.idempotencyKey;
    const journal = await this.d.ledger.post({
      idempotencyKey: holdKey(workflowId),
      kind: HOLD_JOURNAL_KIND,
      transferId: transfer.id,
      effectiveAt: now,
      postings: await this.legs(transfer, 'pending'),
      metadata: { workflowId, provider: this.d.provider, holdUntil, ...conversionMetadata(transfer), ...institutionMetadata(transfer) },
    });
    return this.d.transfers.apply(transfer.id, 'hold', now, { journalId: journal.id, holdReleasesAt: new Date(holdUntil), reason: 'bank hold' });
  }

  async release(transfer: Transfer, now: Date): Promise<Transfer> {
    if (transfer.state !== 'pending_hold') throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot release a load that is ${transfer.state}`);
    const workflowId = transfer.idempotencyKey;
    // The hold already converted: the release moves the credited amount within the purse currency.
    const { minor, currency } = credited(transfer);
    const pending = await this.destination(transfer, 'pending', currency);
    const wallet = await this.destination(transfer, 'wallet', currency);
    const journal = await this.d.ledger.post({
      idempotencyKey: releaseKey(workflowId),
      kind: journalKind(transfer, RELEASE_JOURNAL_KIND),
      transferId: transfer.id,
      effectiveAt: now,
      postings: [
        { accountId: pending, currency, amountMinor: minor },
        { accountId: wallet, currency, amountMinor: -minor },
      ],
      metadata: { workflowId, provider: this.d.provider, heldUntil: transfer.holdReleasesAt, ...institutionMetadata(transfer) },
    });
    const released = await this.d.transfers.apply(transfer.id, 'release_hold', now, { reason: 'hold days passed' });
    return this.d.transfers.apply(released.id, 'settle', now, { journalId: journal.id });
  }

  async fail(transfer: Transfer, code: string, now: Date): Promise<Transfer> {
    if (transfer.state === 'pending_hold' && transfer.journalId) await this.d.ledger.reverse(transfer.journalId, `${holdKey(transfer.idempotencyKey)}:reversal`);
    return this.d.transfers.apply(transfer.id, 'fail', now, { failureCode: code, reason: transfer.state === 'pending_hold' ? 'returned during hold' : 'vendor' });
  }

  // ---- webhooks ----

  /** Verifies through the port. A bad signature is refused; an unknown load is acknowledged and ignored. */
  webhookVerifier(): WebhookVerifier {
    return {
      verify: async (headers, rawBody) => {
        const { eventId, body } = eventIdOf(rawBody);
        try {
          const { eventId: id, load } = await this.d.port.parseWebhook(headers, rawBody);
          const { clientSecret: _secret, ...rest } = load;
          return { ok: true, eventId: id, payload: { eventId: id, load: { ...rest, amount: toWire(load.amount) } } };
        } catch (e) {
          if (e instanceof FundingError && e.code === 'BAD_SIGNATURE') return { ok: false, eventId, payload: body, reason: 'bad signature' };
          if (e instanceof FundingError && e.code === 'UNKNOWN_LOAD') return { ok: true, eventId, payload: { eventId, ignored: 'unknown load' } };
          if (e instanceof FundingError) return { ok: true, eventId, payload: { eventId, error: e.code } };
          throw e;
        }
      },
    };
  }

  /** Settles, holds or fails the transfer the vendor load belongs to; a repeat is a no-op. */
  async applyWebhook(event: InboundEvent, now: Date): Promise<Transfer | undefined> {
    const p = event.payload as { load?: Omit<VendorLoad, 'amount'> & { amount: { minor: string; currency: string } }; error?: string } | undefined;
    if (p?.error) throw new DomainError('VALIDATION_FAILED', `Funding webhook rejected by the port: ${p.error}`);
    if (!p?.load) return undefined;
    const load: VendorLoad = { ...p.load, amount: fromWire(p.load.amount) };
    const transfer = await this.byVendorLoad(load.loadId);
    if (!transfer) return undefined;
    if (load.amount.minor !== transfer.amount.minor || load.amount.currency !== transfer.amount.currency) throw new DomainError('VALIDATION_FAILED', 'Webhook amount differs from the transfer');
    if (transfer.state === 'failed' || transfer.state === 'cancelled' || transfer.state === 'reversed') return transfer;
    return (await applyVendorState(this, transfer, load, transfer.idempotencyKey, now)).transfer;
  }

  // ---- lookups ----

  async byVendorLoad(loadId: string): Promise<Transfer | undefined> {
    const r = await this.d.db.query<{ entity_id: string }>(`select entity_id from ops.external_ref where entity_type = 'transfer' and provider = $1 and external_id = $2`, [this.d.provider, loadId]);
    return r.rows[0] ? this.d.transfers.get(r.rows[0].entity_id) : undefined;
  }

  async vendorLoadOf(transferId: string): Promise<string | undefined> {
    const r = await this.d.db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'transfer' and entity_id = $1 and provider = $2`, [transferId, this.d.provider]);
    return r.rows[0]?.external_id;
  }

  /** Loads the vendor has not finished: submitted longer than `olderThanMs` ago. The worker asks the vendor about them. */
  async stale(now: Date, olderThanMs: number, limit = 100): Promise<Transfer[]> {
    // This market's loads only: another market's worker asks its own provider about its own (T-0028). An
    // institution's ACH pull is one too (T-0617); a deposit recorded off a statement (T-0614) never met the vendor.
    const r = await this.d.db.query<{ id: string }>(`select t.id from ops.transfer t
        where (t.kind = 'load' or (t.kind = 'deposit' and exists (select 1 from ops.external_ref r where r.entity_type = 'transfer' and r.entity_id = t.id and r.provider = $4)))
          and t.state = 'submitted' and t.updated_at <= $1 and t.market = $3 order by t.updated_at limit $2`,
      [new Date(now.getTime() - olderThanMs), limit, this.d.transfers.market, this.d.provider]);
    const out: Transfer[] = [];
    for (const row of r.rows) {
      const t = await this.d.transfers.get(row.id);
      if (t) out.push(t);
    }
    return out;
  }

  view(run: Omit<LoadRun, 'replayed'>): LoadView {
    const t = run.transfer;
    return {
      id: t.id,
      state: loadState(t, run.awaiting),
      amount: toWire(t.amount),
      ...(t.state === 'pending_hold' && t.holdReleasesAt ? { holdUntil: t.holdReleasesAt.slice(0, 10) } : {}),
      ...(run.clientSecret ? { clientSecret: run.clientSecret } : {}),
      ...(t.conversion ? { credited: toWire(t.conversion.received), rateVersion: t.conversion.rateVersion } : {}),
    };
  }

  /**
   * The conversion a load into another purse settles at: the club rate, less the purse owner's plan markup,
   * like every conversion (ADR-007, ADR-014 decision 2). At the mid rate a load through the other purse would
   * be a free conversion that undercuts the convert screen.
   */
  private async price(input: LoadInput, now: Date): Promise<TransferConversion | undefined> {
    const purse = input.purse ?? input.amount.currency;
    if (purse === input.amount.currency) return undefined;
    if (!this.d.rates || !this.d.markups) throw new DomainError('PROVIDER_UNAVAILABLE', 'Loads into another currency are not available right now');
    const rate = await this.d.rates.rateFor(input.amount.currency, purse, now);
    const markupBps = await this.d.markups.markupFor(input.memberPartyId);
    const gross = money(applyRate(input.amount.minor, rate.rateScaled), purse);
    const received = sub(gross, applyBps(gross, markupBps));
    if (received.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'The amount is too small to convert');
    return { received, rateId: rate.rateId, rateVersion: rate.version, rateScaled: rate.rateScaled, markupBps };
  }

  /**
   * partner_settlement in the instrument currency to the member's wallet or pending purse. Same currency:
   * two legs. Converting: fx_position takes the instrument amount and pays out the gross in the purse
   * currency; the purse takes the credited amount and fee income the markup, when above zero. Balanced per
   * currency; the gap to the vendor's real rate is fx_position's to carry.
   */
  private async legs(transfer: Transfer, into: 'wallet' | 'pending'): Promise<Posting[]> {
    const { minor, currency } = transfer.amount;
    const partner = await this.d.accounts.systemAccount('partner_settlement', currency);
    const c = transfer.conversion;
    if (!c) {
      const dest = await this.destination(transfer, into, currency);
      return [
        { accountId: partner, currency, amountMinor: minor },
        { accountId: dest, currency, amountMinor: -minor },
      ];
    }
    const to = c.received.currency;
    const dest = await this.destination(transfer, into, to);
    const markup = markupOf(transfer, c);
    return [
      { accountId: partner, currency, amountMinor: minor },
      { accountId: await this.d.accounts.systemAccount('fx_position', currency), currency, amountMinor: -minor },
      { accountId: await this.d.accounts.systemAccount('fx_position', to), currency: to, amountMinor: c.received.minor + markup },
      { accountId: dest, currency: to, amountMinor: -c.received.minor },
      ...(markup > 0n ? [{ accountId: await this.d.accounts.systemAccount('fee_income', to), currency: to, amountMinor: -markup }] : []),
    ];
  }

  /** Where a load lands: the member's wallet or pending purse, or for an institution's pull its own account or its hold. */
  private destination(transfer: Transfer, into: 'wallet' | 'pending', currency: Currency): Promise<string> {
    const owner = transfer.toPartyId!;
    if (transfer.kind !== 'deposit') return this.d.accounts.memberAccount(owner, into, currency);
    return into === 'wallet' ? this.d.accounts.institutionAccount(owner, currency) : this.d.accounts.institutionHoldAccount(owner, currency);
  }

  private async parse(payerPartyId: string, body: unknown): Promise<LoadInput> {
    const b = (body ?? {}) as { memberPartyId?: unknown; amount?: unknown; method?: unknown; paymentMethodId?: unknown; purseCurrency?: unknown };
    if (typeof b.memberPartyId !== 'string' || !b.memberPartyId) throw new DomainError('VALIDATION_FAILED', 'memberPartyId is required');
    if (b.method === 'ach' && !(await this.d.flags.isOn(ACH_FLAG))) throw new DomainError('FEATURE_OFF', 'Bank loads are not enabled yet');
    if (b.method === 'rtp') throw new DomainError('FEATURE_OFF', 'Instant bank loads are not enabled yet');
    if (typeof b.method !== 'string' || (b.method !== 'ach' && !LOAD_METHODS.includes(b.method as FundingMethod))) throw new DomainError('VALIDATION_FAILED', `method must be one of ${[...LOAD_METHODS, 'ach'].join(', ')}`);
    let amount: Money;
    try {
      amount = fromWire(b.amount as { minor: string; currency: string });
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency } in USD or ILS');
    }
    if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
    if (b.paymentMethodId !== undefined && typeof b.paymentMethodId !== 'string') throw new DomainError('VALIDATION_FAILED', 'paymentMethodId must be a string');
    if (b.purseCurrency !== undefined && !PURSE_CURRENCIES.includes(b.purseCurrency as Currency)) throw new DomainError('VALIDATION_FAILED', `purseCurrency must be one of ${PURSE_CURRENCIES.join(', ')}`);
    if (b.memberPartyId !== payerPartyId) {
      const m = await this.d.memberships.forMember(b.memberPartyId);
      if (!m || m.funderPartyId !== payerPartyId || m.status !== 'active') throw new DomainError('FORBIDDEN', 'You can load your own purse or one you fund');
    }
    return {
      payerPartyId,
      memberPartyId: b.memberPartyId,
      method: b.method as FundingMethod,
      amount,
      ...(typeof b.paymentMethodId === 'string' ? { paymentMethodId: b.paymentMethodId } : {}),
      ...(b.purseCurrency !== undefined ? { purse: b.purseCurrency as Currency } : {}),
    };
  }
}

export function loadState(t: Transfer, awaiting?: 'action' | 'vendor'): LoadState {
  switch (t.state) {
    case 'created':
      return 'created';
    case 'submitted':
      return awaiting === 'action' ? 'requires_action' : 'processing';
    case 'pending':
    case 'pending_hold':
      return 'on_hold';
    case 'settled':
    case 'reversed':
      return 'settled';
    case 'failed':
    case 'cancelled':
      return 'failed';
  }
}

/** A member's load books its own journal kinds; an institution's pull lands as a deposit (T-0617). */
const journalKind = (t: Transfer, memberKind: string): string => (t.kind === 'deposit' ? INSTITUTION_DEPOSIT_JOURNAL_KIND : memberKind);

/** The institution and the rail on an institution's pull, as the monthly export reads a deposit. */
const institutionMetadata = (t: Transfer): Record<string, unknown> => (t.kind === 'deposit' ? { institutionId: t.toPartyId, rail: 'ach', description: 'ACH pull from the institution\'s bank' } : {});

/** What the member's purse receives: the conversion's amount, or the load itself. */
function credited(t: Transfer): Money {
  return t.conversion?.received ?? t.amount;
}

function conversionMetadata(t: Transfer): Record<string, unknown> {
  const c = t.conversion;
  if (!c) return {};
  return {
    fx_rate_version: c.rateVersion,
    fx_rate_id: c.rateId,
    fx_markup_bps: Number(c.markupBps),
    rateScaled: c.rateScaled.toString(),
    rate: rateString(c.rateScaled),
    loaded: toWire(t.amount),
    credited: toWire(c.received),
    markup: toWire(money(markupOf(t, c), c.received.currency)),
  };
}

/** The markup kept by fee income: the gross at the rate applied, less what the purse was credited. */
function markupOf(t: Transfer, c: TransferConversion): bigint {
  return applyRate(t.amount.minor, c.rateScaled) - c.received.minor;
}

function mapFundingError(e: unknown): Error {
  if (e instanceof FundingError) {
    if (e.code === 'PROVIDER_UNAVAILABLE') return new DomainError('PROVIDER_UNAVAILABLE', 'Funding is temporarily unavailable; try again with the same key');
    if (e.code === 'UNSUPPORTED_METHOD') return new DomainError('VALIDATION_FAILED', 'This funding method is not supported');
    if (e.code === 'VALIDATION_FAILED') return new DomainError('VALIDATION_FAILED', e.message);
  }
  return e as Error;
}

/** The vendor's event id from the raw body, for the forensic record of a refused webhook. */
function eventIdOf(rawBody: string): { eventId: string; body: unknown } {
  try {
    const b = JSON.parse(rawBody) as { eventId?: unknown; id?: unknown } | null;
    return { eventId: typeof b?.eventId === 'string' ? b.eventId : typeof b?.id === 'string' ? b.id : '', body: b ?? {} };
  } catch {
    return { eventId: '', body: { raw: rawBody.slice(0, 2_000) } };
  }
}
