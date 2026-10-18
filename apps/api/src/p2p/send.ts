// P2P send (T-0505, REQ-PAY-001/002/005): a verified member sends money to another verified member as a
// book transfer. The transfer's key is the member's Idempotency-Key and the SendWorkflow's id, so two
// POSTs with one key are one transfer (REQ-PAY-005). The workflow posts one balanced journal, the
// sender's wallet to the recipient's wallet, keyed `{key}:settle`, settles the transfer, records the
// plan's usage, and tells the recipient within seconds. Holds for a new counterparty (REQ-PAY-003) and
// requests or splits (REQ-PAY-004) are later cards; every send here settles at once.
//
// `runSend` is the deterministic body over `SendActivities`, so Temporal (ADR-002) can host it unchanged;
// `P2pSendService` is both the activities and the HTTP-facing entry. The note is member text: stored,
// rendered, never interpreted.
import { DomainError, fromWire, toWire, type Money } from '@kesher/domain';
import type { NotifyPort } from '@kesher/ports';
import type { IdentityRepository } from '../auth/repository.ts';
import type { Database } from '../db.ts';
import type { KycService } from '../kyc/service.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferService } from '../transfers/service.ts';
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
  /** The book transfer: one journal, wallet → wallet, keyed by the workflow id. */
  post(transfer: Transfer, workflowId: string, now: Date): Promise<{ journalId: string }>;
  settle(transfer: Transfer, journalId: string, now: Date): Promise<Transfer>;
  /** The plan's P2P usage, idempotent by the workflow id. */
  recordUsage(transfer: Transfer, workflowId: string, now: Date): Promise<void>;
  /** The recipient's notification, idempotent by the workflow id. */
  notify(transfer: Transfer, workflowId: string, now: Date): Promise<void>;
}

export interface SendRun {
  workflowId: string;
  transfer: Transfer;
  replayed: boolean;
  /** True when this run told the recipient (a replay does not). */
  notified: boolean;
}

/** The workflow body: created → submitted → settled, each step safe to repeat. */
export async function runSend(a: SendActivities, input: SendInput, workflowId: string, now: Date): Promise<SendRun> {
  let t = await a.begin(input, workflowId, now);
  if (t.state === 'settled' || t.state === 'failed' || t.state === 'cancelled' || t.state === 'reversed') return { workflowId, transfer: t, replayed: true, notified: false };
  const replayed = t.state !== 'created';
  if (t.state === 'created') t = await a.submit(t, now);
  const { journalId } = await a.post(t, workflowId, now);
  t = await a.settle(t, journalId, now);
  await a.recordUsage(t, workflowId, now);
  await a.notify(t, workflowId, now);
  return { workflowId, transfer: t, replayed, notified: true };
}

export const settleKey = (workflowId: string): string => `${workflowId}:settle`;

interface Deps {
  db: Database;
  ledger: PostgresLedger;
  accounts: AccountService;
  transfers: TransferService;
  limits: P2pLimitService;
  kyc: KycService;
  identity: IdentityRepository;
  notify: NotifyPort;
}

export class P2pSendService implements SendActivities {
  constructor(private readonly d: Deps) {}

  /** POST /transfers: eligibility, limits and balance, then the workflow. */
  async send(fromPartyId: string, body: unknown, key: string, now: Date): Promise<{ id: string; state: Transfer['state']; amount: ReturnType<typeof toWire> }> {
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

  // ---- activities ----

  async begin(input: SendInput, workflowId: string, now: Date): Promise<Transfer> {
    const t = await this.d.transfers.create({ idempotencyKey: workflowId, kind: 'p2p', fromPartyId: input.fromPartyId, toPartyId: input.toPartyId, amount: input.amount, ...(input.note ? { note: input.note } : {}) }, now);
    if (t.kind !== 'p2p') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key already names another operation');
    return t;
  }

  submit(transfer: Transfer, now: Date): Promise<Transfer> {
    return this.d.transfers.apply(transfer.id, 'submit', now);
  }

  async post(transfer: Transfer, workflowId: string, now: Date): Promise<{ journalId: string }> {
    const { currency } = transfer.amount;
    const from = await this.d.accounts.memberAccount(transfer.fromPartyId!, 'wallet', currency);
    const to = await this.d.accounts.memberAccount(transfer.toPartyId!, 'wallet', currency);
    const journal = await this.d.ledger.post({
      idempotencyKey: settleKey(workflowId),
      kind: P2P_JOURNAL_KIND,
      transferId: transfer.id,
      effectiveAt: now,
      postings: [
        { accountId: from, currency, amountMinor: transfer.amount.minor },
        { accountId: to, currency, amountMinor: -transfer.amount.minor },
      ],
      metadata: { workflowId, fromPartyId: transfer.fromPartyId, toPartyId: transfer.toPartyId },
    });
    return { journalId: journal.id };
  }

  settle(transfer: Transfer, journalId: string, now: Date): Promise<Transfer> {
    return this.d.transfers.apply(transfer.id, 'settle', now, { journalId });
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
    // The amount and the transfer id only: the sender's name and the note are not for an SMS.
    await this.d.notify.send(
      { channel: 'sms', to: recipient.phone, template: RECEIVED_TEMPLATE, locale: 'en', data: { amount: transfer.amount.minor.toString(), currency: transfer.amount.currency, transferId: transfer.id }, category: 'money' },
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

function view(t: Transfer): { id: string; state: Transfer['state']; amount: ReturnType<typeof toWire> } {
  return { id: t.id, state: t.state, amount: toWire(t.amount) };
}
