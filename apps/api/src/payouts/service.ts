// Payouts (T-0510, REQ-PO-001/002): ILS to a validated payee through the PayoutPort. Every payout is a
// transfer of kind 'payout' driven by the PayoutWorkflow, whose id is the member's Idempotency-Key. The
// rules sit in front of the money: a new payee over ₪2,000 cools off 24 hours (the transfer waits in
// pending_hold with the release time and nothing has moved); amounts over the two-person threshold wait
// for a finance approver (ops.approval_request, kind payout, subject the transfer id). Only then does
// the journal post, wallet → partner_settlement under `{key}:settle`, and the vendor pull carry the same
// key. A failed webhook reverses that journal once and tells the payer by push (SEQ-09).
//
// `runPayout` is the deterministic body over `PayoutActivities`, so Temporal (ADR-002) can host it
// unchanged; `PayoutService` is both the activities and the HTTP-facing entry.
import { DomainError, fromWire, money, toWire, type Money } from '@kesher/domain';
import { PayoutError, type NotifyPort, type Payout as VendorPayout, type PayoutPort } from '@kesher/ports';
import { uuidv7 } from '@kesher/domain';
import type { ApprovalService } from '../approvals/service.ts';
import type { IdentityRepository } from '../auth/repository.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferService } from '../transfers/service.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import type { WebhookVerifier } from '../webhooks/verify.ts';
import { checkPayee, type PayeeCheck } from './iban.ts';
import type { KybGate } from '../institutions/kyb-gate.ts';
import type { PayoutAccounts } from '../institutions/payout-account.ts';

export const PAYOUT_FLAG = 'payouts.nium';
export const PAYOUT_PROVIDER = 'payout';
export const PAYOUT_JOURNAL_KIND = 'payout';
export const COOL_OFF_MS = 24 * 60 * 60_000;
/** A first payout to a payee above this cools off (REQ-PO-002: ₪2,000). */
export const COOL_OFF_THRESHOLD_MINOR = 200_000n;
export const FAILED_TEMPLATE = 'money.payout_failed';
export type PayoutState = 'cooling_off' | 'awaiting_second_approval' | 'submitted' | 'processing' | 'settled' | 'failed' | 'reversed' | 'rejected';
/** A second finance member rejected the payout: the transfer fails with this code before anything moved. */
export const REJECTED = 'REJECTED';
/** A payout the rail never took (it was down) is retried by the sweep from this age, and failed (reversed, the member told) at STRANDED_AFTER_MS (T-0541, RUN-01). */
export const RETRY_AFTER_MS = 5 * 60_000;
export const STRANDED_AFTER_MS = 30 * 60_000;
/** A payout whose second approval was never given within its time (T-0540): failed, and its reserve released. */
export const APPROVAL_EXPIRED = 'APPROVAL_EXPIRED';

/** Whose money it is (T-0527): a member's own purse, or an institution's account, asked for by its finance staff. */
export type PayoutSource = { kind: 'member' } | { kind: 'institution'; requestedBy: string; requesterRole: 'finance' | 'org_admin' };

export interface PayoutInput {
  /** The member, or the institution, whose money pays out; the transfer's from party. */
  partyId: string;
  source: PayoutSource;
  payeeId: string;
  payee: { iban: string; name: string };
  amount: Money;
  reference: string;
}

/** The OpenAPI `Payout`. */
export interface PayoutView {
  id: string;
  state: PayoutState;
  amount: ReturnType<typeof toWire>;
  scheduledFor?: string;
}

/** One institution payout as the list shows it; names come from the handler, which knows the staff. */
export interface InstitutionPayoutRow {
  view: PayoutView;
  transfer: Transfer;
  payee: { name: string; ibanLast4: string };
  requestedBy: string | undefined;
  approvers: string[];
  required: number;
  requestedByViewer: boolean;
}

export interface PayoutActivities {
  begin(input: PayoutInput, workflowId: string, now: Date): Promise<Transfer>;
  /** True when the payee is new to this member and the amount is over the cooling-off threshold. */
  needsCoolOff(input: PayoutInput): Promise<boolean>;
  /** Parks the transfer for 24 hours. */
  coolOff(transfer: Transfer, now: Date): Promise<Transfer>;
  /**
   * A member's payout that waits has its amount reserved (wallet → pending), so it cannot be spent meanwhile; idempotent.
   * When the money is no longer there (spent before the reserve, on a run that resumes) the payout is failed and returned.
   */
  reserve(transfer: Transfer, input: PayoutInput, now: Date): Promise<Transfer | undefined>;
  /** The 24 hours passed: the transfer leaves the hold and goes on to the approval and the rail. */
  release(transfer: Transfer, now: Date): Promise<Transfer>;
  /** Approved, or no second approver needed. Opens the request on the first ask. */
  approved(transfer: Transfer, input: PayoutInput, now: Date): Promise<boolean>;
  /** A member's payout whose approval was rejected or ran out: failed, the reserve released, the approval marked expired. Undefined when it is not due. */
  expireIfDue(transfer: Transfer, input: PayoutInput, now: Date): Promise<Transfer | undefined>;
  /** True when the vendor has a payout for this transfer (its webhook finishes it). */
  atRail(transfer: Transfer): Promise<boolean>;
  /** A submitted payout the rail never took, 30 minutes on: failed and reversed once, the payer told, a case opened. Undefined when it is not due. */
  stranded(transfer: Transfer, now: Date): Promise<Transfer | undefined>;
  /** The journal (from the reserve, or the wallet when nothing was reserved → partner_settlement) and the vendor pull, both keyed by the workflow id. */
  submit(transfer: Transfer, input: PayoutInput, workflowId: string, now: Date): Promise<{ transfer: Transfer; payout: VendorPayout }>;
  settle(transfer: Transfer, now: Date): Promise<Transfer>;
  /** Reverses the journal and the reserve once and fails the transfer; tells the payer. */
  fail(transfer: Transfer, code: string, now: Date, reason?: string): Promise<Transfer>;
}

export interface PayoutRun {
  workflowId: string;
  transfer: Transfer;
  /** Why the run stopped short of the vendor, when it did. */
  waiting?: 'cooling_off' | 'approval';
  replayed: boolean;
}

/**
 * The workflow body. created → (cooling off: pending_hold → pending) → (approval) → submitted (journal
 * posted, vendor asked) → settled | failed by webhook. Every step is safe to repeat; a rerun resumes.
 */
export async function runPayout(a: PayoutActivities, input: PayoutInput, workflowId: string, now: Date): Promise<PayoutRun> {
  let t = await a.begin(input, workflowId, now);
  const replayed = t.state !== 'created';
  if (t.state === 'settled' || t.state === 'failed' || t.state === 'cancelled' || t.state === 'reversed') return { workflowId, transfer: t, replayed };
  // At the rail already: its webhook finishes it. Otherwise (a `submitted` payout with no vendor ref) the rail was down, or its answer
  // was lost: it is asked again under the same key below (the journal is posted once, the vendor makes one payout).
  if (t.state === 'submitted' && (await a.atRail(t))) return { workflowId, transfer: t, replayed };
  // Past the hold and already at the rail: the webhook finishes it.
  if (t.state === 'pending' && t.journalId) return { workflowId, transfer: t, replayed };
  if (t.state === 'pending_hold') {
    if (!t.holdReleasesAt || Date.parse(t.holdReleasesAt) > now.getTime()) return { workflowId, transfer: t, waiting: 'cooling_off', replayed };
    // The cool-off is over. A payout waiting before it was reserved (a crash between the hold and the reserve, or one older than the
    // reserve) is reserved now, or failed if the money has gone.
    const gone = await a.reserve(t, input, now);
    if (gone) return { workflowId, transfer: gone, replayed };
    t = await a.release(t, now);
  } else if (t.state === 'created' && (await a.needsCoolOff(input))) {
    const held = await a.coolOff(t, now);
    const gone = await a.reserve(held, input, now);
    return { workflowId, transfer: gone ?? held, ...(gone ? {} : { waiting: 'cooling_off' as const }), replayed };
  }
  if (!(await a.approved(t, input, now))) {
    // A rejected or lapsed approval ends the wait first (and returns the reserve); only then does a waiting payout hold funds.
    const ended = await a.expireIfDue(t, input, now);
    if (ended) return { workflowId, transfer: ended, replayed };
    const gone = await a.reserve(t, input, now);
    return gone ? { workflowId, transfer: gone, replayed } : { workflowId, transfer: t, waiting: 'approval', replayed };
  }
  let r;
  try {
    r = await a.submit(t, input, workflowId, now);
  } catch (e) {
    // The rail answered "unavailable" to this attempt too. Only now, 30 minutes after the first attempt, is the payout given up on: the
    // vendor was asked once more first (it may have taken the payout and lost its answer, or be back), so a payout it holds is never refunded.
    if (e instanceof DomainError && e.code === 'PROVIDER_UNAVAILABLE') {
      const dead = await a.stranded(t, now);
      if (dead) return { workflowId, transfer: dead, replayed };
    }
    throw e;
  }
  t = r.transfer;
  if (r.payout.status === 'settled') t = await a.settle(t, now);
  else if (r.payout.status === 'failed') t = await a.fail(t, r.payout.failureReason ?? 'PAYOUT_FAILED', now);
  return { workflowId, transfer: t, replayed };
}

export const settleKey = (workflowId: string): string => `${workflowId}:settle`;
/** A member's payout that has to wait moves the amount wallet → pending under this key (T-0540); `unreserveKey` reverses it, once. */
export const reserveKey = (workflowId: string): string => `${workflowId}:reserve`;
export const unreserveKey = (workflowId: string): string => `${workflowId}:unreserve`;

interface Deps {
  db: Database;
  port: PayoutPort;
  ledger: PostgresLedger;
  accounts: AccountService;
  transfers: TransferService;
  approvals: ApprovalService;
  identity: IdentityRepository;
  notify: NotifyPort;
  flags: FeatureFlags;
  provider: string;
  /** An institution's payout waits on its KYB decision (T-0621); a member's does not. */
  kyb: Pick<KybGate, 'require'>;
  /** An institution pays out only to its own verified account (T-0623, REQ-INS-012). */
  payoutAccounts: Pick<PayoutAccounts, 'requirePayee'>;
}

interface PayeeRow {
  id: string;
  iban: string;
  iban_last4: string;
  name: string;
  bank_code: string | null;
  first_settled_at: string | Date | null;
}

export class PayoutService implements PayoutActivities {
  private readonly d: Deps;
  constructor(d: Deps) {
    this.d = d;
  }

  /** POST /payouts: the flag, the payee (ours and the vendor's), the purse, then the workflow. */
  async request(partyId: string, body: unknown, key: string, now: Date, source: PayoutSource = { kind: 'member' }): Promise<PayoutView & { newPayee: boolean }> {
    if (!(await this.d.flags.isOn(PAYOUT_FLAG))) throw new DomainError('FEATURE_OFF', 'Payouts are not enabled yet');
    // An institution pays out only while its KYB decision opens payouts (T-0621).
    if (source.kind === 'institution') await this.d.kyb.require(partyId, 'payouts');
    const existing = await this.d.transfers.byKey(key);
    if (existing) {
      if (existing.kind !== 'payout' || existing.fromPartyId !== partyId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
      const input = await this.inputFor(existing);
      return { ...(await this.view((await runPayout(this, input, key, now)).transfer)), newPayee: false };
    }
    const b = (body ?? {}) as { payee?: { iban?: unknown; name?: unknown }; amount?: unknown; reference?: unknown };
    const check = checkPayee({ iban: b.payee?.iban, name: b.payee?.name });
    if (!check.ok) throw new DomainError('VALIDATION_FAILED', 'The payee could not be validated', { problems: check.problems });
    if (source.kind === 'institution') await this.d.payoutAccounts.requirePayee(partyId, check.iban, key, now);
    let amount: Money;
    try {
      amount = fromWire(b.amount as { minor: string; currency: string });
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency }');
    }
    if (amount.currency !== 'ILS') throw new DomainError('VALIDATION_FAILED', 'Payouts are in ILS');
    if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Amount must be positive');
    if (typeof b.reference !== 'string' || !b.reference.trim() || b.reference.length > 64) throw new DomainError('VALIDATION_FAILED', 'reference is required (up to 64 characters)');
    // An institution pays out only what its own account holds (T-0613); never below zero.
    const available = source.kind === 'institution' ? (await this.d.accounts.institutionBalance(partyId, 'ILS')).minor : (await this.d.accounts.purses(partyId)).find((p) => p.currency === 'ILS')!.available.minor;
    if (available < amount.minor) throw new DomainError('INSUFFICIENT_FUNDS', source.kind === 'institution' ? 'Not enough in the institution account for this payout' : 'Not enough in the purse for this payout', { available: available.toString(), currency: 'ILS' });
    const { payee, isNew } = await this.ensurePayee(partyId, check, now);
    const input: PayoutInput = { partyId, source, payeeId: payee.id, payee: { iban: payee.iban, name: payee.name }, amount, reference: b.reference.trim() };
    const run = await runPayout(this, input, key, now);
    return { ...(await this.view(run.transfer)), newPayee: isNew };
  }

  /** Our checks, then the vendor's (name against the account). A payee seen before is not re-asked. */
  private async ensurePayee(partyId: string, check: PayeeCheck, now: Date): Promise<{ payee: PayeeRow; isNew: boolean }> {
    const found = await this.d.db.query<PayeeRow>('select id, iban, iban_last4, name, bank_code, first_settled_at from ops.payee where party_id = $1 and iban = $2', [partyId, check.iban]);
    if (found.rows[0]) return { payee: found.rows[0], isNew: found.rows[0].first_settled_at === null };
    let v;
    try {
      v = await this.d.port.validatePayee({ iban: check.iban, name: check.name });
    } catch (e) {
      throw mapPayoutError(e);
    }
    if (!v.valid) throw new DomainError('VALIDATION_FAILED', 'The bank did not recognise this payee', { problems: v.reasons });
    const id = uuidv7(now);
    await this.d.db.query(
      `insert into ops.payee (id, party_id, iban, iban_last4, name, bank_code, validated_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $7) on conflict (party_id, iban) do nothing`,
      [id, partyId, check.iban, check.last4, check.name, v.bankCode ?? check.bankCode ?? null, now],
    );
    const row = (await this.d.db.query<PayeeRow>('select id, iban, iban_last4, name, bank_code, first_settled_at from ops.payee where party_id = $1 and iban = $2', [partyId, check.iban])).rows[0]!;
    return { payee: row, isNew: true };
  }

  // ---- activities ----

  async begin(input: PayoutInput, workflowId: string, now: Date): Promise<Transfer> {
    const t = await this.d.transfers.create({ idempotencyKey: workflowId, kind: 'payout', fromPartyId: input.partyId, amount: input.amount, note: input.reference }, now);
    if (t.kind !== 'payout') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
    await this.d.db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('payee', $1, 'payee', $2) on conflict do nothing`, [t.id, `${input.payeeId}:${t.id}`]);
    // An institution payout's approval is asked for now, before any cool-off, so it records who asked (T-0628):
    // the worker's sweep rebuilds the requester from it, and without it named the institution, which let the
    // person who asked approve their own withdrawal. The request counts as their approval; a cool-off still
    // keeps a second approver from deciding until it ends.
    if (input.source.kind === 'institution') await this.requestApproval(t, input, now);
    return t;
  }

  async needsCoolOff(input: PayoutInput): Promise<boolean> {
    if (input.amount.minor <= COOL_OFF_THRESHOLD_MINOR) return false;
    const r = await this.d.db.query<{ first_settled_at: string | null }>('select first_settled_at from ops.payee where id = $1', [input.payeeId]);
    return (r.rows[0]?.first_settled_at ?? null) === null;
  }

  async coolOff(transfer: Transfer, now: Date): Promise<Transfer> {
    const submitted = transfer.state === 'created' ? await this.d.transfers.apply(transfer.id, 'submit', now, { reason: 'cooling off' }) : transfer;
    return this.d.transfers.apply(submitted.id, 'hold', now, { holdReleasesAt: new Date(now.getTime() + COOL_OFF_MS), reason: 'new payee over the threshold (REQ-PO-002)' });
  }

  release(transfer: Transfer, now: Date): Promise<Transfer> {
    return this.d.transfers.apply(transfer.id, 'release_hold', now, { reason: 'cooling off over' });
  }

  async approved(transfer: Transfer, input: PayoutInput, now: Date): Promise<boolean> {
    return (await this.requestApproval(transfer, input, now)).status === 'approved';
  }

  async atRail(transfer: Transfer): Promise<boolean> {
    return (await this.d.db.query(`select 1 from ops.external_ref where entity_type = 'transfer' and entity_id = $1 and provider = $2`, [transfer.id, this.d.provider])).rows.length > 0;
  }

  async stranded(transfer: Transfer, now: Date): Promise<Transfer | undefined> {
    if (transfer.state !== 'submitted' && transfer.state !== 'pending') return undefined;
    // Thirty minutes from the first attempt: the settle journal is posted by it (the transfer's own age would count a cool-off or an approval wait).
    const first = await this.d.db.query<{ effective_at: string | Date }>(`select effective_at from ledger.journal where idempotency_key = $1`, [settleKey(transfer.idempotencyKey)]);
    if (!first.rows[0] || now.getTime() - new Date(first.rows[0].effective_at).getTime() < STRANDED_AFTER_MS) return undefined;
    // The case first (deduped): a crash after the fail must still leave ops the signal.
    await this.d.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'payout_stranded', $2, 'high', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
      [uuidv7(now), `payout_stranded:${transfer.id}`, JSON.stringify({ transferId: transfer.id, runbook: 'RUN-01', summary: 'A payout the rail never took in 30 minutes was failed and reversed' }), now],
    );
    return this.fail(transfer, 'PROVIDER_UNAVAILABLE', now, 'the rail stayed down for 30 minutes');
  }

  async expireIfDue(transfer: Transfer, input: PayoutInput, now: Date): Promise<Transfer | undefined> {
    // An institution's payout keeps waiting as before (nothing was reserved for it); a member's ends with its approval.
    if (input.source.kind === 'institution') return undefined;
    const req = await this.d.approvals.find('payout', transfer.id);
    if (!req) return undefined;
    const open = req.status === 'pending' || req.status === 'awaiting_second_approval';
    if (open && Date.parse(req.expiresAt) > now.getTime()) return undefined;
    if (req.status === 'approved') return undefined;
    // Fail first (this releases the reserve), mark the approval after: a crash between leaves a lapsed approval the sweep still finds.
    const code = req.status === 'rejected' ? REJECTED : APPROVAL_EXPIRED;
    const failed = await this.fail(transfer, code, now, req.status === 'rejected' ? 'approval rejected' : 'approval expired');
    if (open) await this.d.db.query(`update ops.approval_request set status = 'expired', decided_at = $2 where id = $1 and status in ('pending', 'awaiting_second_approval')`, [req.id, now]);
    return failed;
  }

  // ---- the reserve (T-0540) ----

  private async journalIdOf(key: string): Promise<string | undefined> {
    return (await this.d.db.query<{ id: string }>(`select id from ledger.journal where idempotency_key = $1`, [key])).rows[0]?.id;
  }

  /**
   * A member's payout that waits (cooling off, or for an approver) moves its amount wallet → pending, so `available` drops at
   * once and the same money cannot be spent twice; the payout later posts from pending. Idempotent by key. When the purse no
   * longer holds the amount (it was spent before the reserve existed) the payout fails instead of overdrawing. An institution's
   * payout is not reserved here (its balance is a single account: a follow-up).
   */
  async reserve(transfer: Transfer, input: PayoutInput, now: Date): Promise<Transfer | undefined> {
    if (input.source.kind === 'institution') return undefined;
    const key = reserveKey(transfer.idempotencyKey);
    if (await this.journalIdOf(key)) return undefined;
    const purse = (await this.d.accounts.purses(input.partyId)).find((p) => p.currency === 'ILS');
    if ((purse?.available.minor ?? 0n) < input.amount.minor) return this.fail(transfer, 'INSUFFICIENT_FUNDS', now, 'the funds were spent before they were reserved');
    const wallet = await this.d.accounts.memberAccount(input.partyId, 'wallet', 'ILS');
    const pending = await this.d.accounts.memberAccount(input.partyId, 'pending', 'ILS');
    await this.d.ledger.post({
      idempotencyKey: key,
      kind: PAYOUT_JOURNAL_KIND,
      transferId: transfer.id,
      effectiveAt: now,
      postings: [
        { accountId: wallet, currency: 'ILS', amountMinor: input.amount.minor },
        { accountId: pending, currency: 'ILS', amountMinor: -input.amount.minor },
      ],
      metadata: { workflowId: transfer.idempotencyKey, reason: 'payout waiting (T-0540)' },
    });
    return undefined;
  }

  /** Returns the reserve to the wallet, once (the reversal key is idempotent). Nothing to do when nothing was reserved. */
  private async unreserve(transfer: Transfer): Promise<void> {
    const id = await this.journalIdOf(reserveKey(transfer.idempotencyKey));
    if (id) await this.d.ledger.reverse(id, unreserveKey(transfer.idempotencyKey));
  }

  /** The payout's approval request, made once per transfer; a later call finds the first, with its requester. */
  private requestApproval(transfer: Transfer, input: PayoutInput, now: Date) {
    const requestedBy = input.source.kind === 'institution' ? { partyId: input.source.requestedBy, role: input.source.requesterRole } : { partyId: input.partyId, role: 'member' };
    const scope = input.source.kind === 'institution' ? input.partyId : 'platform';
    return this.d.approvals.request({ kind: 'payout', subject: transfer.id, scope, requestedBy, amount: input.amount, payload: { payeeLast4: input.payee.iban.slice(-4), reference: input.reference } }, now);
  }

  async submit(transfer: Transfer, input: PayoutInput, workflowId: string, now: Date): Promise<{ transfer: Transfer; payout: VendorPayout }> {
    let t = transfer;
    const institution = input.source.kind === 'institution';
    // A member's payout that waited posts from its reserve; one that did not (it went straight to the rail, or it was already
    // waiting before the reserve existed) posts from the wallet as before.
    const reserved = !institution && !!(await this.journalIdOf(reserveKey(workflowId)));
    const wallet = institution ? await this.d.accounts.institutionAccount(input.partyId, 'ILS') : await this.d.accounts.memberAccount(input.partyId, reserved ? 'pending' : 'wallet', 'ILS');
    const partner = await this.d.accounts.systemAccount('partner_settlement', 'ILS');
    const journal = await this.d.ledger.post({
      idempotencyKey: settleKey(workflowId),
      kind: PAYOUT_JOURNAL_KIND,
      transferId: t.id,
      effectiveAt: now,
      postings: [
        { accountId: wallet, currency: 'ILS', amountMinor: input.amount.minor },
        { accountId: partner, currency: 'ILS', amountMinor: -input.amount.minor },
      ],
      // An institution's payout carries its id, so the monthly export reads it (T-0527), and the payee's name for that row.
      metadata: { workflowId, payeeId: input.payeeId, payeeLast4: input.payee.iban.slice(-4), reference: input.reference, provider: this.d.provider, ...(institution ? { institutionId: input.partyId, payeeName: input.payee.name } : {}) },
    });
    let payout: VendorPayout;
    try {
      payout = await this.d.port.createPayout({ payee: input.payee, amount: input.amount, reference: input.reference }, workflowId);
    } catch (e) {
      if (e instanceof PayoutError && e.code === 'PROVIDER_UNAVAILABLE') {
        // The rail is down: the money is reserved on the journal and the same key retries the pull.
        if (t.state === 'created') await this.d.transfers.apply(t.id, 'submit', now, { journalId: journal.id, reason: 'vendor unavailable; retry' });
        throw mapPayoutError(e);
      }
      if (e instanceof PayoutError && e.code === 'INVALID_PAYEE') {
        await this.d.ledger.reverse(journal.id, `${settleKey(workflowId)}:reversal`);
        await this.unreserve(t);
        if (t.state === 'created') await this.d.transfers.apply(t.id, 'submit', now, { journalId: journal.id });
        await this.d.transfers.apply(t.id, 'fail', now, { failureCode: 'INVALID_PAYEE', reason: e.message.slice(0, 200) });
        throw mapPayoutError(e);
      }
      throw mapPayoutError(e);
    }
    await this.d.db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('transfer', $1, $2, $3) on conflict do nothing`, [t.id, this.d.provider, payout.payoutId]);
    // A payout that cooled off is already past 'submitted' (pending after the hold); it keeps the journal id and
    // waits for the rail's webhook there. A fresh one moves to submitted now.
    if (t.state === 'created') t = await this.d.transfers.apply(t.id, 'submit', now, { journalId: journal.id, reason: 'sent to the rail' });
    else await this.d.db.query(`update ops.transfer set journal_id = coalesce(journal_id, $2), updated_at = $3 where id = $1`, [t.id, journal.id, now]);
    return { transfer: (await this.d.transfers.get(t.id))!, payout };
  }

  async settle(transfer: Transfer, now: Date): Promise<Transfer> {
    const t = await this.d.transfers.apply(transfer.id, 'settle', now, { reason: 'rail settled' });
    const payeeId = await this.payeeIdOf(t.id);
    if (payeeId) await this.d.db.query(`update ops.payee set first_settled_at = coalesce(first_settled_at, $2) where id = $1`, [payeeId, now]);
    return t;
  }

  async fail(transfer: Transfer, code: string, now: Date, reason = 'rail failed'): Promise<Transfer> {
    let reversalJournalId: string | undefined;
    // The payout journal, by key when the transfer does not carry it (a cooled-off payout the rail never took stays `pending` with its journal posted).
    const posted = transfer.journalId ?? (await this.journalIdOf(settleKey(transfer.idempotencyKey)));
    if (posted) reversalJournalId = (await this.d.ledger.reverse(posted, `${settleKey(transfer.idempotencyKey)}:reversal`)).id;
    await this.unreserve(transfer);
    const t = await this.d.transfers.apply(transfer.id, 'fail', now, { failureCode: code, reason, ...(reversalJournalId ? { reversalJournalId } : {}) });
    await this.tellPayer(t, code, now);
    return t;
  }

  // ---- webhooks ----

  webhookVerifier(): WebhookVerifier {
    return {
      verify: async (headers, rawBody) => {
        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          return { ok: false, eventId: '', payload: { raw: rawBody.slice(0, 2_000) }, reason: 'malformed json' };
        }
        const eventId = typeof (body as { eventId?: unknown })?.eventId === 'string' ? (body as { eventId: string }).eventId : '';
        try {
          const { eventId: id, payout } = await this.d.port.parseWebhook(headers, rawBody);
          return { ok: true, eventId: id, payload: { eventId: id, payout: { ...payout, payee: { last4: payout.payee.iban.slice(-4) }, amount: toWire(payout.amount) } } };
        } catch (e) {
          if (e instanceof PayoutError && e.code === 'BAD_SIGNATURE') return { ok: false, eventId, payload: body, reason: 'bad signature' };
          if (e instanceof PayoutError && e.code === 'UNKNOWN_PAYOUT') return { ok: true, eventId, payload: { eventId, ignored: 'unknown payout' } };
          throw e;
        }
      },
    };
  }

  /** settled or failed, once; processing is noted and nothing else changes. */
  async applyWebhook(event: InboundEvent, now: Date): Promise<Transfer | undefined> {
    const p = event.payload as { payout?: { payoutId: string; status: VendorPayout['status']; failureReason?: string; amount: { minor: string; currency: string } } } | undefined;
    if (!p?.payout) return undefined;
    const transfer = await this.byVendorPayout(p.payout.payoutId);
    if (!transfer) return undefined;
    if (fromWire(p.payout.amount).minor !== transfer.amount.minor) throw new DomainError('VALIDATION_FAILED', 'Webhook amount differs from the payout');
    if (transfer.state === 'settled' || transfer.state === 'failed' || transfer.state === 'reversed' || transfer.state === 'cancelled') return transfer;
    if (p.payout.status === 'settled') return this.settle(transfer, now);
    if (p.payout.status === 'failed') return this.fail(transfer, p.payout.failureReason ?? 'PAYOUT_FAILED', now);
    return transfer;
  }

  // ---- institution payouts (T-0527) ----

  /**
   * The second finance member's decision on an institution payout waiting for one. Approve resumes the
   * workflow at once (journal, then the rail); reject fails the transfer with REJECTED before anything
   * moved. The requester cannot decide their own payout (one decision per person); the same person
   * approving again is a no-op that answers the payout as it stands.
   */
  async decide(transferId: string, institutionId: string, by: { partyId: string; role: 'finance' | 'org_admin' }, decision: 'approve' | 'reject', now: Date, reason?: string): Promise<Transfer> {
    const t = /^[0-9a-f-]{36}$/i.test(transferId) ? await this.d.transfers.get(transferId) : undefined;
    // Another institution's payout, or a member's, is not found: its existence is not this caller's to confirm.
    if (!t || t.kind !== 'payout' || t.fromPartyId !== institutionId) throw new DomainError('NOT_FOUND', 'Payout not found');
    // Its approval exists from the start (T-0628), but nobody decides while it cools off.
    if (t.state === 'pending_hold') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This payout is still cooling off');
    const req = await this.d.approvals.find('payout', t.id);
    if (!req) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This payout is not waiting for an approval');
    const mine = await this.d.db.query<{ decision: string }>('select decision from ops.approval_decision where request_id = $1 and decided_by = $2', [req.id, by.partyId]);
    if (mine.rows[0] && mine.rows[0].decision === decision && by.partyId !== req.requestedBy) return t;
    if (req.status !== 'awaiting_second_approval') throw new DomainError('IDEMPOTENCY_CONFLICT', `This payout is already ${req.status === 'approved' ? 'approved' : req.status}`);
    const after = await this.d.approvals.decide(req.id, by, decision, now, reason);
    if (decision === 'reject') await this.unreserve(t);
    if (decision === 'reject') return this.d.transfers.apply(t.id, 'fail', now, { failureCode: REJECTED, reason: 'rejected by a second finance member' });
    if (after.status !== 'approved') return t;
    return (await runPayout(this, await this.inputFor(t), t.idempotencyKey, now)).transfer;
  }

  /** The institution's payouts, newest first, a page at a time, with the approvals so far and its available balance. */
  async listForInstitution(institutionId: string, viewer: string, cursor: { at: string; id: string } | undefined, limit: number): Promise<{ items: InstitutionPayoutRow[]; next?: { at: string; id: string }; available: Money }> {
    return this.institutionRows(institutionId, viewer, cursor, limit);
  }

  /** One of the institution's payouts; another institution's (or a member's) is not found. */
  async institutionPayout(institutionId: string, id: string, viewer: string): Promise<InstitutionPayoutRow> {
    const r = /^[0-9a-f-]{36}$/i.test(id) ? await this.institutionRows(institutionId, viewer, undefined, 1, id) : { items: [] };
    if (!r.items[0]) throw new DomainError('NOT_FOUND', 'Payout not found');
    return r.items[0];
  }

  private async institutionRows(institutionId: string, viewer: string, cursor: { at: string; id: string } | undefined, limit: number, only?: string): Promise<{ items: InstitutionPayoutRow[]; next?: { at: string; id: string }; available: Money }> {
    const r = await this.d.db.query<{ id: string; created_at: string | Date; requested_by: string | null; required: number | null; approvers: string[] | null; name: string | null; iban_last4: string | null }>(
      `select t.id, t.created_at, a.requested_by, a.required,
              (select array_agg(dd.decided_by order by dd.at) from ops.approval_decision dd where dd.request_id = a.id and dd.decision = 'approve') as approvers,
              p.name, p.iban_last4
         from ops.transfer t
         left join ops.approval_request a on a.kind = 'payout' and a.subject = t.id::text
         left join ops.external_ref x on x.entity_type = 'payee' and x.provider = 'payee' and x.entity_id = t.id
         left join ops.payee p on p.id::text = split_part(x.external_id, ':', 1)
        where t.kind = 'payout' and t.from_party_id = $1
          and ($2::timestamptz is null or (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
          and ($5::uuid is null or t.id = $5::uuid)
        order by t.created_at desc, t.id desc limit $4`,
      [institutionId, cursor?.at ?? null, cursor?.id ?? null, limit + 1, only ?? null],
    );
    const page = r.rows.slice(0, limit);
    const items: InstitutionPayoutRow[] = [];
    for (const x of page) {
      const t = (await this.d.transfers.get(x.id))!;
      items.push({ view: await this.view(t), transfer: t, payee: { name: x.name ?? '', ibanLast4: x.iban_last4 ?? '' }, requestedBy: x.requested_by ?? undefined, approvers: x.approvers ?? [], required: x.required ?? 0, requestedByViewer: x.requested_by === viewer });
    }
    const last = page.at(-1);
    return { items, ...(r.rows.length > limit && last ? { next: { at: new Date(last.created_at).toISOString(), id: last.id } } : {}), available: await this.d.accounts.institutionBalance(institutionId, 'ILS') };
  }

  // ---- lookups and views ----

  async view(t: Transfer): Promise<PayoutView> {
    let state: PayoutState;
    switch (t.state) {
      case 'pending_hold':
        state = 'cooling_off';
        break;
      case 'created':
        state = 'awaiting_second_approval';
        break;
      case 'pending':
        state = t.journalId ? 'processing' : 'awaiting_second_approval';
        break;
      case 'submitted':
        state = 'processing';
        break;
      case 'settled':
        state = 'settled';
        break;
      case 'failed':
        state = t.failureCode === REJECTED ? 'rejected' : t.reversalJournalId ? 'reversed' : 'failed';
        break;
      default:
        state = 'failed';
    }
    return { id: t.id, state, amount: toWire(t.amount), ...(t.state === 'pending_hold' && t.holdReleasesAt ? { scheduledFor: t.holdReleasesAt } : {}) };
  }

  /** Rebuilds the workflow input for a rerun (the worker's sweep, a replay with the same key). */
  async inputFor(t: Transfer): Promise<PayoutInput> {
    const payeeId = await this.payeeIdOf(t.id);
    const row = payeeId ? (await this.d.db.query<PayeeRow>('select id, iban, iban_last4, name, bank_code, first_settled_at from ops.payee where id = $1', [payeeId])).rows[0] : undefined;
    if (!row) throw new DomainError('NOT_FOUND', 'Payee not found for this payout');
    return { partyId: t.fromPartyId!, source: await this.sourceOf(t), payeeId: row.id, payee: { iban: row.iban, name: row.name }, amount: money(t.amount.minor, 'ILS'), reference: t.note ?? '' };
  }

  /** An institution's payout is the one whose from party is an institution; its requester is the approval's. */
  private async sourceOf(t: Transfer): Promise<PayoutSource> {
    const r = await this.d.db.query<{ requested_by: string | null }>(
      `select (select a.requested_by from ops.approval_request a where a.kind = 'payout' and a.subject = $2) as requested_by from org.institution i where i.id = $1`,
      [t.fromPartyId, t.id],
    );
    const row = r.rows[0];
    if (!row) return { kind: 'member' };
    return { kind: 'institution', requestedBy: row.requested_by ?? t.fromPartyId!, requesterRole: 'finance' };
  }

  /** Payouts waiting on a cooling-off that ended, or an approval that landed. */
  async resumable(now: Date, limit = 100): Promise<Transfer[]> {
    const r = await this.d.db.query<{ id: string }>(
      `select t.id from ops.transfer t where t.kind = 'payout' and (
          (t.state = 'pending_hold' and t.hold_releases_at <= $1)
          or (t.state in ('created', 'pending') and t.journal_id is null and exists (select 1 from ops.approval_request a where a.kind = 'payout' and a.subject = t.id::text and a.status = 'approved'))
          or (t.state = 'submitted' and t.journal_id is not null and t.updated_at <= $1::timestamptz - ($4 * interval '1 millisecond')
              and not exists (select 1 from ops.external_ref x where x.entity_type = 'transfer' and x.entity_id = t.id and x.provider = $5))
          or (t.state in ('created', 'pending') and t.journal_id is null and not exists (select 1 from org.institution i where i.id = t.from_party_id)
              and exists (select 1 from ops.approval_request a where a.kind = 'payout' and a.subject = t.id::text and (a.status in ('rejected', 'expired') or (a.status in ('pending', 'awaiting_second_approval') and a.expires_at <= $1))))
       ) and t.market = $3 order by t.created_at limit $2`,
      [now, limit, this.d.transfers.market, RETRY_AFTER_MS, this.d.provider],
    );
    const out: Transfer[] = [];
    for (const row of r.rows) {
      const t = await this.d.transfers.get(row.id);
      if (t) out.push(t);
    }
    return out;
  }

  private async payeeIdOf(transferId: string): Promise<string | undefined> {
    const r = await this.d.db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'payee' and entity_id = $1 and provider = 'payee'`, [transferId]);
    return r.rows[0]?.external_id.split(':')[0];
  }

  private async byVendorPayout(payoutId: string): Promise<Transfer | undefined> {
    const r = await this.d.db.query<{ entity_id: string }>(`select entity_id from ops.external_ref where entity_type = 'transfer' and provider = $1 and external_id = $2`, [this.d.provider, payoutId]);
    return r.rows[0] ? this.d.transfers.get(r.rows[0].entity_id) : undefined;
  }

  private async tellPayer(t: Transfer, code: string, now: Date): Promise<void> {
    // An institution has no devices; its finance staff see the reversal in the console's payout list (I09).
    if ((await this.sourceOf(t)).kind === 'institution') return;
    const devices = await this.d.identity.listDevices(t.fromPartyId!);
    for (const d of devices) {
      if (!d.pushToken) continue;
      await this.d.notify.send({ channel: 'push', to: d.pushToken, template: FAILED_TEMPLATE, locale: 'en', data: { amount: t.amount.minor.toString(), currency: t.amount.currency, reason: code, transferId: t.id }, category: 'money' }, `${t.idempotencyKey}:failed:${d.deviceId}`);
    }
    void now;
  }
}

function mapPayoutError(e: unknown): Error {
  if (e instanceof PayoutError) {
    if (e.code === 'PROVIDER_UNAVAILABLE') return new DomainError('PROVIDER_UNAVAILABLE', 'Payouts are temporarily unavailable; try again with the same key');
    if (e.code === 'INVALID_PAYEE') return new DomainError('VALIDATION_FAILED', 'The bank did not recognise this payee', { problems: e.message.split(',') });
    if (e.code === 'VALIDATION_FAILED') return new DomainError('VALIDATION_FAILED', e.message);
  }
  return e as Error;
}
