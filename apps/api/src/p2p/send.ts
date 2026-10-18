// P2P send (T-0505, REQ-PAY-001/002/005): a verified member sends money to another verified member as a
// book transfer. The transfer's key is the member's Idempotency-Key and the SendWorkflow's id, so two
// POSTs with one key are one transfer (REQ-PAY-005). The workflow posts one balanced journal, the
// sender's wallet to the recipient's wallet, keyed `{key}:settle`, settles the transfer, records the
// plan's usage, and tells the recipient within seconds. A first send over ₪500 to a new counterparty
// (REQ-PAY-003, T-0506) instead reserves the money and waits two hours in pending_hold, cancellable; the
// worker resumes the same run when the time passes. Requests or splits (REQ-PAY-004) are a later card.
//
// Currency (T-0515, REQ-PAY-006, ADR-007): the amount's currency names the purse paid from; the recipient's
// receiving currency (T-0514) names the purse credited. When the two differ the send is priced once, at
// `begin`, from the club rate in force, with the recipient's plan markup on top (they chose to receive
// converted, so their plan prices it), and the transfer carries the received leg and the rate version:
// the post, the sweep and the hold's release move that amount and never re-price. No valid rate refuses
// the send with PROVIDER_UNAVAILABLE before anything is created. Limits and the hold rule judge the sent
// amount; the journal is one, balanced per currency, through `fx_position`.
//
// `runSend` is the deterministic body over `SendActivities`, so Temporal (ADR-002) can host it unchanged;
// `P2pSendService` is both the activities and the HTTP-facing entry. The note is member text: stored,
// rendered, never interpreted.
import { applyBps, DomainError, fromWire, money, sub, toWire, type Money, type Posting } from '@kesher/domain';
import { applyRate, type NotifyPort } from '@kesher/ports';
import type { IdentityRepository } from '../auth/repository.ts';
import type { Database } from '../db.ts';
import type { RateService } from '../fx/rates.ts';
import { rateString } from '../fx/service.ts';
import type { KycService } from '../kyc/service.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { PreferenceService } from '../me/preferences.ts';
import type { Transfer, TransferConversion, TransferService } from '../transfers/service.ts';
import { RELEASE_JOURNAL_KIND, releaseKey, type P2pHoldService } from './holds.ts';
import type { P2pLimitService } from './limits.ts';

export const P2P_JOURNAL_KIND = 'p2p';
export const RECEIVED_TEMPLATE = 'money.p2p_received';
/** REQ-PAY-001: the recipient hears within this long of the send settling. */
export const NOTIFY_SLA_MS = 5_000;
export const NOTE_MAX = 140;

export interface SendInput {
  fromPartyId: string;
  toPartyId: string;
  amount: Money;
  note?: string;
}

export interface SendActivities {
  begin(input: SendInput, workflowId: string, now: Date): Promise<Transfer>;
  submit(transfer: Transfer, now: Date): Promise<Transfer>;
  /** The book transfer: one journal, wallet → wallet (through fx_position when converting), keyed by the workflow id. */
  post(transfer: Transfer, workflowId: string, now: Date): Promise<{ journalId: string }>;
  settle(transfer: Transfer, journalId: string, now: Date): Promise<Transfer>;
  /** The plan's P2P usage, idempotent by the workflow id. */
  recordUsage(transfer: Transfer, workflowId: string, now: Date): Promise<void>;
  /** The recipient's notification, idempotent by the workflow id. */
  notify(transfer: Transfer, workflowId: string, now: Date): Promise<void>;
  /** REQ-PAY-003: a first send over the threshold to a new counterparty waits. */
  shouldHold(transfer: Transfer): Promise<boolean>;
  /** Reserves the money (wallet → pending) and parks the transfer for two hours. */
  hold(transfer: Transfer, workflowId: string, now: Date): Promise<Transfer>;
  /** The hold's time passed: pending → the recipient's wallet, and the transfer settles. */
  release(transfer: Transfer, workflowId: string, now: Date): Promise<Transfer>;
}

export interface SendRun {
  workflowId: string;
  transfer: Transfer;
  replayed: boolean;
  /** True when this run told the recipient (a replay does not). */
  notified: boolean;
  /** True when this run parked the send in a new-pair hold. */
  held: boolean;
}

/**
 * The workflow body: created → submitted → settled, or → pending_hold and, once the time passes, →
 * settled by way of the release; each step safe to repeat. A run on a hold that has not expired returns it.
 */
export async function runSend(a: SendActivities, input: SendInput, workflowId: string, now: Date): Promise<SendRun> {
  let t = await a.begin(input, workflowId, now);
  if (t.state === 'settled' || t.state === 'failed' || t.state === 'cancelled' || t.state === 'reversed') return { workflowId, transfer: t, replayed: true, notified: false, held: false };
  const replayed = t.state !== 'created';
  if (t.state === 'pending_hold') {
    if (!t.holdReleasesAt || Date.parse(t.holdReleasesAt) > now.getTime()) return { workflowId, transfer: t, replayed, notified: false, held: false };
    t = await a.release(t, workflowId, now);
  } else {
    if (t.state === 'created') t = await a.submit(t, now);
    if (t.state === 'submitted' && (await a.shouldHold(t))) return { workflowId, transfer: await a.hold(t, workflowId, now), replayed, notified: false, held: true };
    const { journalId } = await a.post(t, workflowId, now);
    t = await a.settle(t, journalId, now);
  }
  await a.recordUsage(t, workflowId, now);
  await a.notify(t, workflowId, now);
  return { workflowId, transfer: t, replayed, notified: true, held: false };
}

export const settleKey = (workflowId: string): string => `${workflowId}:settle`;

interface Deps {
  db: Database;
  ledger: PostgresLedger;
  accounts: AccountService;
  transfers: TransferService;
  limits: P2pLimitService;
  holds: P2pHoldService;
  kyc: KycService;
  identity: IdentityRepository;
  notify: NotifyPort;
  preferences: Pick<PreferenceService, 'receiveCurrencyOf'>;
  rates: Pick<RateService, 'rateFor'>;
  /** The recipient's plan markup in basis points (FxService.markupFor). */
  markups: { markupFor(partyId: string): Promise<bigint> };
}

export class P2pSendService implements SendActivities {
  constructor(private readonly d: Deps) {}

  /** POST /transfers: eligibility, limits and balance, then the workflow. */
  async send(fromPartyId: string, body: unknown, key: string, now: Date): Promise<TransferView> {
    const input = parse(fromPartyId, body);
    const existing = await this.d.transfers.byKey(key);
    if (existing) {
      if (existing.kind !== 'p2p' || existing.fromPartyId !== fromPartyId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
      return view((await runSend(this, input, key, now)).transfer);
    }
    await this.eligible(input);
    await this.d.limits.check(fromPartyId, input.amount, now);
    const purse = (await this.d.accounts.purses(fromPartyId)).find((p) => p.currency === input.amount.currency)!;
    if (purse.available.minor < input.amount.minor) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the purse for this transfer', { available: purse.available.minor.toString(), currency: purse.currency });
    return view((await runSend(this, input, key, now)).transfer);
  }

  /** Both sides verified members (REQ-PAY-001): an active account with identity approved. */
  async eligible(input: SendInput): Promise<void> {
    if (input.fromPartyId === input.toPartyId) throw new DomainError('VALIDATION_FAILED', 'You cannot send money to yourself');
    const sender = await this.d.identity.findUser(input.fromPartyId);
    if (!sender || sender.status === 'closed') throw new DomainError('UNAUTHENTICATED', 'Account unavailable');
    await this.d.kyc.requireApproved(input.fromPartyId, 'T1');
    const recipient = await this.d.identity.findUser(input.toPartyId);
    if (!recipient || recipient.status === 'closed' || recipient.status === 'pending') throw new DomainError('NOT_FOUND', 'Recipient is not a member');
    if (!(await this.d.kyc.isApproved(input.toPartyId, 'T1'))) throw new DomainError('FORBIDDEN', 'Recipient has not completed identity verification');
  }

  /** POST /transfers/{id}/cancel: only a held send, only by its sender (REQ-PAY-003). */
  async cancel(partyId: string, transferId: string, now: Date): Promise<TransferView> {
    return view(await this.d.holds.cancel(transferId, partyId, now));
  }

  // ---- activities ----

  async begin(input: SendInput, workflowId: string, now: Date): Promise<Transfer> {
    const existing = await this.d.transfers.byKey(workflowId);
    if (existing) {
      if (existing.kind !== 'p2p') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
      return existing; // a replay keeps the price it was created at
    }
    const conversion = await this.price(input, now);
    const t = await this.d.transfers.create({ idempotencyKey: workflowId, kind: 'p2p', fromPartyId: input.fromPartyId, toPartyId: input.toPartyId, amount: input.amount, ...(input.note ? { note: input.note } : {}), ...(conversion ? { conversion } : {}) }, now);
    if (t.kind !== 'p2p') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
    return t;
  }

  /**
   * The received leg when the recipient's receiving currency differs from the sent one: the gross at the
   * club rate, less the recipient's plan markup. PROVIDER_UNAVAILABLE when no valid rate stands (REQ-FX-004).
   */
  async price(input: SendInput, now: Date): Promise<TransferConversion | undefined> {
    const to = await this.d.preferences.receiveCurrencyOf(input.toPartyId, input.amount.currency);
    if (to === input.amount.currency) return undefined;
    const rate = await this.d.rates.rateFor(input.amount.currency, to, now);
    const markupBps = await this.d.markups.markupFor(input.toPartyId);
    const gross = money(applyRate(input.amount.minor, rate.rateScaled), to);
    const received = sub(gross, applyBps(gross, markupBps));
    if (received.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'The amount is too small to convert', { received: received.minor.toString(), currency: to });
    return { received, rateId: rate.rateId, rateVersion: rate.version, rateScaled: rate.rateScaled, markupBps };
  }

  submit(transfer: Transfer, now: Date): Promise<Transfer> {
    return this.d.transfers.apply(transfer.id, 'submit', now);
  }

  async post(transfer: Transfer, workflowId: string, now: Date): Promise<{ journalId: string }> {
    const from = await this.d.accounts.memberAccount(transfer.fromPartyId!, 'wallet', transfer.amount.currency);
    const journal = await this.d.ledger.post({
      idempotencyKey: settleKey(workflowId),
      kind: P2P_JOURNAL_KIND,
      transferId: transfer.id,
      effectiveAt: now,
      postings: await this.legs(transfer, from),
      metadata: { workflowId, fromPartyId: transfer.fromPartyId, toPartyId: transfer.toPartyId, ...conversionMetadata(transfer) },
    });
    return { journalId: journal.id };
  }

  /**
   * The postings from a source account in the sent currency to the recipient's wallet. Same currency: two
   * legs. Converting: the source pays fx_position in the sent currency; fx_position pays out the gross in the
   * received currency, the recipient's wallet takes the received amount and fee income the markup. Balanced
   * per currency; the gap between the club rate and the vendor's lands on fx_position, which reconciliation
   * watches (ADR-007).
   */
  private async legs(transfer: Transfer, source: string): Promise<Posting[]> {
    const { currency } = transfer.amount;
    const c = transfer.conversion;
    if (!c) {
      const to = await this.d.accounts.memberAccount(transfer.toPartyId!, 'wallet', currency);
      return [
        { accountId: source, currency, amountMinor: transfer.amount.minor },
        { accountId: to, currency, amountMinor: -transfer.amount.minor },
      ];
    }
    const to = await this.d.accounts.memberAccount(transfer.toPartyId!, 'wallet', c.received.currency);
    const positionFrom = await this.d.accounts.systemAccount('fx_position', currency);
    const positionTo = await this.d.accounts.systemAccount('fx_position', c.received.currency);
    const feeIncome = await this.d.accounts.systemAccount('fee_income', c.received.currency);
    const markup = markupOf(transfer, c);
    return [
      { accountId: source, currency, amountMinor: transfer.amount.minor },
      { accountId: positionFrom, currency, amountMinor: -transfer.amount.minor },
      { accountId: positionTo, currency: c.received.currency, amountMinor: c.received.minor + markup },
      { accountId: to, currency: c.received.currency, amountMinor: -c.received.minor },
      ...(markup > 0n ? [{ accountId: feeIncome, currency: c.received.currency, amountMinor: -markup }] : []),
    ];
  }

  settle(transfer: Transfer, journalId: string, now: Date): Promise<Transfer> {
    return this.d.transfers.apply(transfer.id, 'settle', now, { journalId });
  }

  shouldHold(transfer: Transfer): Promise<boolean> {
    return this.d.holds.shouldHold(transfer.fromPartyId!, transfer.toPartyId!, transfer.amount);
  }

  hold(transfer: Transfer, workflowId: string, now: Date): Promise<Transfer> {
    return this.d.holds.hold(transfer, workflowId, now);
  }

  /** A converted hold releases here, at the price fixed when it began; a same-currency one through the hold service. */
  async release(transfer: Transfer, workflowId: string, now: Date): Promise<Transfer> {
    if (!transfer.conversion) return this.d.holds.release(transfer, workflowId, now);
    if (transfer.state !== 'pending_hold') throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot release a transfer that is ${transfer.state}`);
    if (!transfer.holdReleasesAt || Date.parse(transfer.holdReleasesAt) > now.getTime()) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The hold has not expired yet');
    const pending = await this.d.accounts.memberAccount(transfer.fromPartyId!, 'pending', transfer.amount.currency);
    const journal = await this.d.ledger.post({
      idempotencyKey: releaseKey(workflowId),
      kind: RELEASE_JOURNAL_KIND,
      transferId: transfer.id,
      effectiveAt: now,
      postings: await this.legs(transfer, pending),
      metadata: { workflowId, heldUntil: transfer.holdReleasesAt, ...conversionMetadata(transfer) },
    });
    const released = await this.d.transfers.apply(transfer.id, 'release_hold', now, { reason: 'hold expired' });
    return this.d.transfers.apply(released.id, 'settle', now, { journalId: journal.id });
  }

  recordUsage(transfer: Transfer, workflowId: string, now: Date): Promise<void> {
    return this.d.limits.consume(transfer.fromPartyId!, transfer.amount, `${workflowId}:usage`, now);
  }

  /** P2P sends left submitted longer than `olderThanMs`: the worker's sweep finishes them with the same keys. */
  async stale(now: Date, olderThanMs: number, limit = 100): Promise<Transfer[]> {
    const r = await this.d.db.query<{ id: string }>(`select id from ops.transfer where kind = 'p2p' and state = 'submitted' and updated_at <= $1 order by updated_at limit $2`, [new Date(now.getTime() - olderThanMs), limit]);
    const out: Transfer[] = [];
    for (const row of r.rows) {
      const t = await this.d.transfers.get(row.id);
      if (t) out.push(t);
    }
    return out;
  }

  async notify(transfer: Transfer, workflowId: string, _now: Date): Promise<void> {
    const recipient = await this.d.identity.findUser(transfer.toPartyId!);
    if (!recipient) return;
    // The amount received and the transfer id only: the sender's name and the note are not for an SMS.
    const received = transfer.conversion?.received ?? transfer.amount;
    await this.d.notify.send(
      { channel: 'sms', to: recipient.phone, template: RECEIVED_TEMPLATE, locale: 'en', data: { amount: received.minor.toString(), currency: received.currency, transferId: transfer.id }, category: 'money' },
      `${workflowId}:notify`,
    );
  }
}

function parse(fromPartyId: string, body: unknown): SendInput {
  const b = (body ?? {}) as { toPartyId?: unknown; amount?: unknown; note?: unknown };
  if (typeof b.toPartyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.toPartyId)) throw new DomainError('VALIDATION_FAILED', 'toPartyId must be a member id');
  let amount: Money;
  try {
    amount = fromWire(b.amount as { minor: string; currency: string });
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency } in USD or ILS');
  }
  if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > NOTE_MAX)) throw new DomainError('VALIDATION_FAILED', `note must be text of at most ${NOTE_MAX} characters`);
  return { fromPartyId, toPartyId: b.toPartyId, amount, ...(typeof b.note === 'string' && b.note ? { note: b.note } : {}) };
}

/** The markup kept by fee income: the gross at the rate applied, less what the recipient received. */
function markupOf(t: Transfer, c: TransferConversion): bigint {
  return applyRate(t.amount.minor, c.rateScaled) - c.received.minor;
}

function conversionMetadata(t: Transfer): Record<string, unknown> {
  const c = t.conversion;
  if (!c) return {};
  const markup = markupOf(t, c);
  return {
    fx_rate_version: c.rateVersion,
    fx_rate_id: c.rateId,
    fx_markup_bps: Number(c.markupBps),
    rateScaled: c.rateScaled.toString(),
    rate: rateString(c.rateScaled),
    sent: toWire(t.amount),
    received: toWire(c.received),
    markup: toWire(money(markup, c.received.currency)),
  };
}

/** The OpenAPI `Transfer`. */
export interface TransferView {
  id: string;
  state: Transfer['state'];
  amount: ReturnType<typeof toWire>;
  holdReleasesAt?: string;
  /** The recipient's leg when the send converted (REQ-PAY-006). */
  received?: ReturnType<typeof toWire>;
  rateVersion?: number;
}

function view(t: Transfer): TransferView {
  return {
    id: t.id,
    state: t.state,
    amount: toWire(t.amount),
    ...(t.state === 'pending_hold' && t.holdReleasesAt ? { holdReleasesAt: t.holdReleasesAt } : {}),
    ...(t.conversion ? { received: toWire(t.conversion.received), rateVersion: t.conversion.rateVersion } : {}),
  };
}
