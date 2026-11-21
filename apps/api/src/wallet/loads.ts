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
import { DomainError, fromWire, toWire, type Currency, type Posting } from '@kesher/domain';
import { FundingError, type FundingAccountPort, type FundingCreditPort, type FundingPort, type Load as VendorLoad } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { MembershipService } from '../billing/memberships.ts';
import type { Database } from '../db.ts';
import type { RateService } from '../fx/rates.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostedJournal, PostgresLedger } from '../ledger/post.ts';
import { entityOf, linkRef, refOf } from '../ops/external-ref.ts';
import type { Transfer, TransferConversion, TransferService } from '../transfers/service.ts';
import { holdKey, releaseKey, settleKey } from '../transfers/journal-keys.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import type { WebhookVerifier } from '../webhooks/verify.ts';
import { contactRef, ensureFundingAccount, fundingAccountKey, type FundingDetails } from './load-accounts.ts';
import { openReturnedCase, openUnknownLoadCase, unknownLoadOpen } from './load-cases.ts';
import { creditAttemptState, creditKey, creditMayHaveMoved, creditStep, recordCreditBegan, recordCreditOutcome, type CreditOutcome } from './load-credit.ts';
import { credited, conversionMetadata, eventIdOf, institutionMetadata, journalKind, loadState, mapFundingError } from './load-model.ts';
import { destination, legs, parse, price } from './load-pricing.ts';
import {
  ACH_FLAG, applyVendorState, FUNDING_PROVIDER, HELD_RECHECK_MS, HOLD_JOURNAL_KIND, INSTITUTION_DEPOSIT_JOURNAL_KIND, LOAD_JOURNAL_KIND, LOAD_METHODS, PURSE_CURRENCIES, RELEASE_JOURNAL_KIND, runLoad, WALLET_FLAG,
  type LoadActivities, type LoadInput, type LoadRun, type LoadState, type LoadView,
} from './load-workflow.ts';

// The public surface of this file is unchanged (T-0764): what moved to load-workflow.ts and load-model.ts is re-exported by name, so every
// importer, the worker through `@kesher/api/wallet/loads` included, keeps importing from here.
export { ACH_FLAG, applyVendorState, FUNDING_PROVIDER, HELD_RECHECK_MS, HOLD_JOURNAL_KIND, INSTITUTION_DEPOSIT_JOURNAL_KIND, LOAD_JOURNAL_KIND, LOAD_METHODS, PURSE_CURRENCIES, RELEASE_JOURNAL_KIND, runLoad, WALLET_FLAG };
export type { LoadActivities, LoadInput, LoadRun, LoadState, LoadView };
export { loadState };
export { holdKey, releaseKey, settleKey };
// The credit phase moved to load-credit.ts (T-0766); its public names are re-exported so every importer keeps importing from here.
export { creditAttemptState, creditKey, recordCreditBegan, recordCreditOutcome };
export type { CreditOutcome };
// The funding-account step and the pricing, legs and parsing moved to load-accounts.ts and load-pricing.ts (T-0767); the public names stay exported from here.
export { fundingAccountKey };
export type { FundingDetails };

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
  /** The funding binding's account capability (T-0740). With `details`, a hosted load makes the payer's contact and wallet account first; without either, the hosted method answers FEATURE_OFF. (Named apart from `accounts`, the ledger's.) */
  fundingAccounts?: FundingAccountPort;
  /** The member's own funding details (T-0738's reader); `undefined` when none were given. Personal data: never logged, thrown or stored by this class. */
  details?: { read(partyId: string): Promise<FundingDetails | undefined> };
  /** The funding binding's credit capability (T-0705, found by `isFundingCreditPort`). Without it a load posts the journals it always posted. */
  credit?: FundingCreditPort;
}

export class LoadService implements LoadActivities {
  private readonly d: Deps;
  private reads = 0;
  private credits = 0;
  private refusals = 0;
  constructor(d: Deps) {
    this.d = d;
  }

  /** How many vendor credits answered `credited` in this process, and how many were refused (a new refusal, not a load a case already holds); a sweep reports the difference (T-0705). */
  get creditedCount(): number {
    return this.credits;
  }

  get refusedCount(): number {
    return this.refusals;
  }

  /** How many times this process has asked the vendor about a held load (the release step); a sweep reports the difference over its run (T-0681). */
  get vendorReads(): number {
    return this.reads;
  }

  /** POST /loads: the gate, the eligibility, then the workflow, synchronously, so the payment sheet's secret can go back. */
  async request(payerPartyId: string, body: unknown, key: string, now: Date): Promise<LoadView> {
    if (!(await this.d.flags.isOn(WALLET_FLAG))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
    const input = await this.parse(payerPartyId, body);
    // The account gate runs before the transfer begins: a refused member leaves nothing behind.
    if (input.method === 'hosted') await this.ensureFundingAccount(input.payerPartyId, now);
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
    // A hosted load is paid by the payer's contact at the vendor (`c:<id>`), not by our party id; every other method keeps the party id.
    const customerId = input.method === 'hosted' ? await this.contactRef(input.payerPartyId) : input.payerPartyId;
    try {
      return await this.d.port.createLoad({ customerId, method: input.method, amount: input.amount, ...(input.paymentMethodId ? { paymentMethodId: input.paymentMethodId } : {}) }, workflowId);
    } catch (e) {
      if (e instanceof FundingError && e.code === 'DECLINED') throw e;
      throw mapFundingError(e);
    }
  }

  private async contactRef(partyId: string): Promise<string> {
    return contactRef(this.d, partyId);
  }

  /**
   * The payer's contact and wallet account at the vendor, made once (T-0740, ADR-018 A1/A2). The refs in ops.external_ref are read first, so
   * the second hosted load asks nobody; otherwise the details are read, `ensureAccount` runs under `funding-account:{partyId}`, and both
   * refs are written. The vendor is the KYC authority: a rejected, archived, frozen or closed answer refuses the load, naming the status only.
   */
  private async ensureFundingAccount(partyId: string, now: Date): Promise<void> {
    await ensureFundingAccount(this.d, partyId, now);
  }

  async link(transfer: Transfer, load: VendorLoad): Promise<void> {
    await linkRef(this.d.db, { entityType: 'transfer', entityId: transfer.id, provider: this.d.provider, externalId: load.loadId });
  }

  async settle(transfer: Transfer, load: VendorLoad, workflowId: string, now: Date): Promise<Transfer> {
    // A held load, or a release that began and did not finish, settles through the release: its own journal, never a second credit.
    if (transfer.state === 'pending_hold' || transfer.state === 'pending') return this.release(transfer, now);
    // The vendor moves the money into the member's wallet account first; the journal follows only once it says `credited` (T-0705).
    if (!(await this.creditStep(transfer, load, now))) return transfer;
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
    try {
      return await this.d.transfers.apply(transfer.id, 'hold', now, { journalId: journal.id, holdReleasesAt: new Date(holdUntil), reason: 'bank hold' });
    } catch (e) {
      // A fail that ran before this hold's journal existed saw nothing to reverse and left the row failed (T-0547): the journal
      // posted here would stand against a failed load, so it is reversed now (once, by key) and the error stands.
      const after = (await this.d.transfers.get(transfer.id))?.state;
      if (after === 'failed' || after === 'cancelled') await this.d.ledger.reverse(journal.id, `${holdKey(workflowId)}:reversal`);
      throw e;
    }
  }

  async release(transfer: Transfer, now: Date): Promise<Transfer> {
    // A `pending` load is a release that began (the hold left, its journal is posted) and did not finish: it is finished here.
    if (transfer.state !== 'pending_hold' && transfer.state !== 'pending') throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot release a load that is ${transfer.state}`);
    const workflowId = transfer.idempotencyKey;
    // Ask the vendor before the money leaves pending: a debit the bank returned during the hold is failed (the hold
    // is reversed once), never released. The vendor cannot be asked: the error leaves the hold in place and the next
    // cycle tries again. Releasing blind would credit money that was never collected.
    // (A load with no vendor link, a statement deposit, is never held, so it never gets here without one.)
    const loadId = await this.vendorLoadOf(transfer.id);
    let vendor: VendorLoad | undefined;
    if (loadId) {
      // A load the vendor does not know is a case for people, opened once; it is not asked about again until they act (T-0547).
      if (await this.unknownLoadOpen(transfer.id)) return transfer;
      this.reads += 1;
      try {
        vendor = await this.d.port.getLoad(loadId);
      } catch (e) {
        if (e instanceof FundingError && e.code === 'UNKNOWN_LOAD') {
          await this.holdUnknown(transfer, loadId, now);
          return transfer;
        }
        throw e;
      }
      // Not for a `failed` answer: if failing the load then throws, the load must not be hidden for the interval (T-0558).
      if (transfer.state === 'pending_hold' && vendor.status !== 'failed') await this.recordAsked(transfer.id, now);
      if (vendor.status === 'failed') return this.fail(transfer, vendor.failureCode ?? 'VENDOR_FAILED', now);
    }
    // Read the row again and refuse if the hold was reversed: a return that failed the load since the caller's read must
    // not have a release posted behind it (nothing would repair that journal once the row is failed).
    const fresh = await this.d.transfers.get(transfer.id);
    if (fresh?.state !== 'pending_hold' && fresh?.state !== 'pending') throw new DomainError('IDEMPOTENCY_CONFLICT', 'The load is no longer held');
    if ((await this.d.db.query(`select 1 from ledger.journal where idempotency_key = $1`, [`${holdKey(workflowId)}:reversal`])).rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The hold was already reversed');
    // The hold already converted: the release moves the credited amount within the purse currency.
    // The credit comes before the journal; a `pending` release (its journal already posted) was credited then and is only finished.
    if (fresh.state === 'pending_hold' && !(await this.creditStep(transfer, vendor, now))) return transfer;
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
    try {
      const released = fresh.state === 'pending' ? fresh : await this.d.transfers.apply(transfer.id, 'release_hold', now, { reason: 'hold days passed' });
      return await this.d.transfers.apply(released.id, 'settle', now, { journalId: journal.id });
    } catch (e) {
      // A return (webhook or sweep) failed the load after the vendor check, before the row moved or between its two
      // steps. Its journal is already posted, so reverse it (once: the key is idempotent and `fail` uses the same one),
      // or the wallet keeps money that was never collected.
      if ((await this.d.transfers.get(transfer.id))?.state === 'failed') await this.d.ledger.reverse(journal.id, `${releaseKey(workflowId)}:reversal`);
      throw e;
    }
  }

  /**
   * Fails the load. While the money is held (`pending_hold`, or `pending` once a release has begun) it undoes what is
   * posted: the hold journal and the release journal, each found by its key (a release that posted and then died
   * leaves one). It decides on the row as it stands now, not on the caller's read, which may be older than a hold that
   * has posted since. If the row has in fact moved on to keep the money (the release won), the reversals are undone
   * and the error stands; while it is still held they are left, so a retry finishes the same work.
   */
  async fail(transfer: Transfer, code: string, now: Date): Promise<Transfer> {
    const workflowId = transfer.idempotencyKey;
    const current = (await this.d.transfers.get(transfer.id)) ?? transfer;
    const held = current.state === 'pending_hold' || current.state === 'pending';
    const reversals: PostedJournal[] = [];
    // A return after the vendor may have credited the wallet and before our journal posted leaves the money at the vendor (T-0742): decided
    // from our own records only, never by asking the vendor (a credit call here could move money on a stale read). The case is opened after the
    // hold is reversed below, so no database trouble with it delays the reversal.
    const mayHaveMoved = (held || current.state === 'submitted') && this.d.credit ? await this.creditMayHaveMoved(current) : undefined;
    // A load still `submitted` may have a hold journal posted a moment before its row moved (T-0547): the journal decides, not the state.
    if (held || current.state === 'submitted') {
      for (const key of [holdKey(workflowId), releaseKey(workflowId)]) {
        const posted = await this.d.db.query<{ id: string }>(`select id from ledger.journal where idempotency_key = $1`, [key]);
        if (posted.rows[0]) reversals.push(await this.d.ledger.reverse(posted.rows[0].id, `${key}:reversal`));
      }
    }
    // A failure of this insert leaves the transfer unfailed: the next sweep retries the whole step, idempotently (reversals are keyed `{key}:reversal`).
    // It is visible only as sweep lag or errors.
    if (mayHaveMoved) await this.openReturnedCase(current, mayHaveMoved, code, 'before_journal', now);
    try {
      return await this.d.transfers.apply(transfer.id, 'fail', now, { failureCode: code, reason: held ? 'returned during hold' : 'vendor' });
    } catch (e) {
      const after = (await this.d.transfers.get(transfer.id))?.state;
      if (after === 'settled' || after === 'cancelled') for (const r of reversals) await this.d.ledger.reverse(r.id, `${r.idempotencyKey}:undo`);
      throw e;
    }
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
    return this.applyToTransfer(transfer, load, now);
  }

  /**
   * A vendor that reports in batches (Crowded, T-0703): re-reads the load by its id through the port, finds the transfer it belongs to
   * and moves it to where the vendor says the load stands now. The event that led here decides nothing, so a repeat, or two events in
   * either order, change nothing more. A load no transfer owns, or one the vendor does not know, is ignored. A load the vendor now
   * says failed after it was credited opens one case for people and moves nothing: no journal, no state change, no debit of the wallet
   * (a return after release is a platform loss and who bears it is the owner's to decide, T-0742).
   */
  async applyVendorLoad(loadId: string, now: Date): Promise<Transfer | undefined> {
    let vendor: VendorLoad;
    try {
      vendor = await this.d.port.getLoad(loadId);
    } catch (e) {
      if (e instanceof FundingError && e.code === 'UNKNOWN_LOAD') return undefined;
      throw e;
    }
    // The load may be named by one of its payments; the transfer is linked under the id the load was made under.
    const linked = (vendor as { metadata?: { intentLoadId?: unknown } }).metadata?.intentLoadId;
    const transfer = (await this.byVendorLoad(vendor.loadId)) ?? (typeof linked === 'string' ? await this.byVendorLoad(linked) : undefined);
    if (!transfer) return undefined;
    const linkedId = (await this.vendorLoadOf(transfer.id)) ?? vendor.loadId;
    if (transfer.state === 'settled' && vendor.status === 'failed') {
      await this.openReturnedCase(transfer, linkedId, vendor.failureCode ?? 'VENDOR_FAILED', 'after_release', now);
      return transfer;
    }
    return this.applyToTransfer(transfer, { ...vendor, loadId: linkedId }, now);
  }

  private async applyToTransfer(transfer: Transfer, load: VendorLoad, now: Date): Promise<Transfer> {
    if (load.amount.minor !== transfer.amount.minor || load.amount.currency !== transfer.amount.currency) throw new DomainError('VALIDATION_FAILED', 'Webhook amount differs from the transfer');
    if (transfer.state === 'failed' || transfer.state === 'cancelled' || transfer.state === 'reversed') return transfer;
    return (await applyVendorState(this, transfer, load, transfer.idempotencyKey, now)).transfer;
  }

  // ---- lookups ----

  async byVendorLoad(loadId: string): Promise<Transfer | undefined> {
    const id = await entityOf(this.d.db, 'transfer', this.d.provider, loadId);
    return id !== undefined ? this.d.transfers.get(id) : undefined;
  }

  async vendorLoadOf(transferId: string): Promise<string | undefined> {
    return refOf(this.d.db, 'transfer', transferId, this.d.provider);
  }

  /** Notes that the vendor was just asked about a held load (upsert, never moving the time backwards), so `stale()` leaves it alone until HELD_RECHECK_MS passes (T-0558). */
  async recordAsked(transferId: string, now: Date): Promise<void> {
    await this.d.db.query(`insert into ops.load_check (transfer_id, last_asked_at) values ($1, $2) on conflict (transfer_id) do update set last_asked_at = excluded.last_asked_at where ops.load_check.last_asked_at < excluded.last_asked_at`, [transferId, now]);
  }

  /** The vendor does not know a held load: notes that it was asked (an answer too) and opens the one case for people (T-0547, T-0558). */
  async holdUnknown(transfer: Transfer, loadId: string, now: Date): Promise<void> {
    await this.recordAsked(transfer.id, now);
    await this.openUnknownLoadCase(transfer, loadId, now);
  }

  /** True while a case people have not decided exists for a held load the vendor does not know; a resolved or dismissed one lets it be asked again. */
  async unknownLoadOpen(transferId: string): Promise<boolean> {
    return unknownLoadOpen(this.d.db, transferId);
  }

  /**
   * The vendor credit before the journal (T-0705): the step itself is `creditStep` in load-credit.ts (T-0766); this adds what it says
   * happened to the `credits` and `refusals` counters the sweep report reads. True when the journal may post.
   */
  private async creditStep(transfer: Transfer, vendor: VendorLoad | undefined, now: Date): Promise<boolean> {
    const r = await creditStep(this.d, transfer, vendor, now);
    if (r.credited) this.credits += 1;
    if (r.refused) this.refusals += 1;
    return r.proceed;
  }

  /**
   * The vendor load id when the vendor may already hold this load's money in the member's wallet without our journal, else undefined. Reads
   * only our own records and calls no vendor: attempt `n` (the next after the credit case's) has a `began` marker, written before the call,
   * and its outcome row is `credited` or `pending`, or missing (a crash between the call and the outcome: the vendor may have credited).
   * A `refused` outcome, no marker, or an open credit case (the last attempt was refused, no later key sent) means no money moved.
   */
  private async creditMayHaveMoved(transfer: Transfer): Promise<string | undefined> {
    if (transfer.kind !== 'load') return undefined;
    const vendorId = await this.vendorLoadOf(transfer.id);
    if (!vendorId) return undefined;
    return creditMayHaveMoved(this.d, transfer, vendorId);
  }

  private async openReturnedCase(transfer: Transfer, loadId: string, failureCode: string, stage: 'after_release' | 'before_journal', now: Date): Promise<void> {
    await openReturnedCase(this.d.db, transfer, loadId, failureCode, stage, now);
  }

  private async openUnknownLoadCase(transfer: Transfer, loadId: string, now: Date): Promise<void> {
    await openUnknownLoadCase(this.d.db, transfer, loadId, now);
  }

  /**
   * Loads the vendor has not finished, idle longer than `olderThanMs`: submitted, pending, or held for the bank's hold days (a return can
   * come during it). The worker asks the vendor about them. A held load is returned only when it was never asked, was last asked
   * HELD_RECHECK_MS ago or more, or its hold is due; `submitted` and `pending` loads are always returned.
   */
  async stale(now: Date, olderThanMs: number, limit = 100): Promise<Transfer[]> {
    // This market's loads only: another market's worker asks its own provider about its own (T-0028). An
    // institution's ACH pull is one too (T-0617); a deposit recorded off a statement (T-0614) never met the vendor.
    const r = await this.d.db.query<{ id: string }>(`select t.id from ops.transfer t
        where (t.kind = 'load' or (t.kind = 'deposit' and exists (select 1 from ops.external_ref r where r.entity_type = 'transfer' and r.entity_id = t.id and r.provider = $4)))
          and t.state in ('submitted', 'pending_hold', 'pending') and t.updated_at <= $1 and t.market = $3
          and (t.state <> 'pending_hold' or t.hold_releases_at is null or t.hold_releases_at <= $5
            or not exists (select 1 from ops.load_check c where c.transfer_id = t.id and c.last_asked_at > $6))
        order by (t.state = 'pending_hold'), t.updated_at limit $2`,
      [new Date(now.getTime() - olderThanMs), limit, this.d.transfers.market, this.d.provider, now, new Date(now.getTime() - HELD_RECHECK_MS)]);
    return this.d.transfers.getMany(r.rows.map((row) => row.id));
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
    return price(this.d, input, now);
  }

  /**
   * partner_settlement in the instrument currency to the member's wallet or pending purse. Same currency:
   * two legs. Converting: fx_position takes the instrument amount and pays out the gross in the purse
   * currency; the purse takes the credited amount and fee income the markup, when above zero. Balanced per
   * currency; the gap to the vendor's real rate is fx_position's to carry.
   */
  private async legs(transfer: Transfer, into: 'wallet' | 'pending'): Promise<Posting[]> {
    return legs(this.d, transfer, into);
  }

  /** Where a load lands: the member's wallet or pending purse, or for an institution's pull its own account or its hold. */
  private destination(transfer: Transfer, into: 'wallet' | 'pending', currency: Currency): Promise<string> {
    return destination(this.d, transfer, into, currency);
  }

  private async parse(payerPartyId: string, body: unknown): Promise<LoadInput> {
    return parse(this.d, payerPartyId, body);
  }
}
