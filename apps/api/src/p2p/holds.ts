// New-pair holds (T-0506, REQ-PAY-003): the first send over ₪500 (or its dollar cousin) to a counterparty
// the member has never paid waits two hours, during which the sender may cancel. The hold reserves the
// money: wallet → pending on the sender's side under `{key}:hold`, so it cannot be spent twice while it
// waits. A cancel reverses that journal; the release, by the worker when the two hours pass, posts
// pending(sender) → wallet(recipient) under `{key}:release` and the send settles as any other.
import { DomainError, type Currency, type Money } from '@kesher/domain';
import type { Database, SqlClient } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferService } from '../transfers/service.ts';

export const HOLD_MS = 2 * 60 * 60_000;
/** Above this, a first send to a new counterparty holds (REQ-PAY-003: ₪500). */
export const HOLD_THRESHOLD_MINOR: Readonly<Record<Currency, bigint>> = { ILS: 50_000n, USD: 15_000n };
export const HOLD_JOURNAL_KIND = 'p2p_hold';
export const RELEASE_JOURNAL_KIND = 'p2p_release';
export const holdKey = (workflowId: string): string => `${workflowId}:hold`;
export const releaseKey = (workflowId: string): string => `${workflowId}:release`;

export class P2pHoldService {
  private readonly db: Database;
  private readonly ledger: PostgresLedger;
  private readonly accounts: AccountService;
  private readonly transfers: TransferService;
  constructor(
    db: Database,
    ledger: PostgresLedger,
    accounts: AccountService,
    transfers: TransferService,
  ) {
    this.db = db;
    this.ledger = ledger;
    this.accounts = accounts;
    this.transfers = transfers;
  }

  /** A new pair is one with no settled send from this member to that one, in any currency. */
  async isNewPair(fromPartyId: string, toPartyId: string): Promise<boolean> {
    const r = await this.db.query<{ n: number }>(`select count(*)::int as n from ops.transfer where kind = 'p2p' and from_party_id = $1 and to_party_id = $2 and state = 'settled'`, [fromPartyId, toPartyId]);
    return r.rows[0]!.n === 0;
  }

  async shouldHold(fromPartyId: string, toPartyId: string, amount: Money): Promise<boolean> {
    if (amount.minor <= HOLD_THRESHOLD_MINOR[amount.currency]) return false;
    return this.isNewPair(fromPartyId, toPartyId);
  }

  /** Reserves the money and parks the transfer for two hours. */
  async hold(transfer: Transfer, workflowId: string, now: Date, extraGuard?: (tx: SqlClient) => Promise<void>): Promise<Transfer> {
    const { currency } = transfer.amount;
    const wallet = await this.accounts.memberAccount(transfer.fromPartyId!, 'wallet', currency);
    const pending = await this.accounts.memberAccount(transfer.fromPartyId!, 'pending', currency);
    let journal;
    try {
      journal = await this.ledger.postNoOverdraft({
        idempotencyKey: holdKey(workflowId),
        kind: HOLD_JOURNAL_KIND,
        transferId: transfer.id,
        effectiveAt: now,
        postings: [
          { accountId: wallet, currency, amountMinor: transfer.amount.minor },
          { accountId: pending, currency, amountMinor: -transfer.amount.minor },
        ],
        metadata: { workflowId, reason: 'new counterparty over the threshold (REQ-PAY-003)' },
      }, extraGuard);
    } catch (e) {
      // Refused under the sender's wallet lock (T-0544): the hold would overdraw it. The send ends here, nothing moved.
      if (e instanceof DomainError && (e.code === 'INSUFFICIENT_FUNDS' || e.code === 'LIMIT_EXCEEDED')) await this.transfers.apply(transfer.id, 'fail', now, { failureCode: e.code, reason: 'refused under the wallet lock' });
      throw e;
    }
    return this.transfers.apply(transfer.id, 'hold', now, { journalId: journal.id, holdReleasesAt: new Date(now.getTime() + HOLD_MS), reason: 'new counterparty' });
  }

  /** True when the hold's money was already returned to the sender (a cancel that reversed it and died before the cancel was recorded). */
  async holdReversed(workflowId: string): Promise<boolean> {
    return (await this.db.query(`select 1 from ledger.journal where idempotency_key = $1`, [`${holdKey(workflowId)}:reversal`])).rows.length > 0;
  }

  /** The two hours passed: the reserved money goes to the recipient and the send settles. */
  async release(transfer: Transfer, workflowId: string, now: Date): Promise<Transfer> {
    if (transfer.state !== 'pending_hold' && transfer.state !== 'pending') throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot release a transfer that is ${transfer.state}`);
    if (transfer.state === 'pending_hold' && (!transfer.holdReleasesAt || Date.parse(transfer.holdReleasesAt) > now.getTime())) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The hold has not expired yet');
    // Never pay out of money that went back to the sender: a cancel that reversed the hold and died, or one that raced the release.
    if (await this.holdReversed(workflowId)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The hold was already returned to the sender');
    const { currency } = transfer.amount;
    const pending = await this.accounts.memberAccount(transfer.fromPartyId!, 'pending', currency);
    const to = await this.accounts.memberAccount(transfer.toPartyId!, 'wallet', currency);
    const journal = await this.ledger.post({
      idempotencyKey: releaseKey(workflowId),
      kind: RELEASE_JOURNAL_KIND,
      transferId: transfer.id,
      effectiveAt: now,
      postings: [
        { accountId: pending, currency, amountMinor: transfer.amount.minor },
        { accountId: to, currency, amountMinor: -transfer.amount.minor },
      ],
      metadata: { workflowId, heldUntil: transfer.holdReleasesAt },
    });
    // A pending row already left its hold (a release that died before it settled): the journal above is the one already posted, and only the settle is left.
    const released = transfer.state === 'pending' ? transfer : await this.transfers.apply(transfer.id, 'release_hold', now, { reason: 'hold expired' });
    return this.transfers.apply(released.id, 'settle', now, { journalId: journal.id });
  }

  /** The sender takes it back while it waits: the hold journal is reversed and the transfer cancelled. Idempotent. */
  async cancel(transferId: string, partyId: string, now: Date): Promise<Transfer> {
    const t = await this.transfers.get(transferId);
    if (!t || t.kind !== 'p2p' || t.fromPartyId !== partyId) throw new DomainError('NOT_FOUND', 'Transfer not found');
    if (t.state === 'cancelled') return t;
    if (t.state !== 'pending_hold') throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot cancel a transfer that is ${t.state}`);
    if (t.journalId) await this.ledger.reverse(t.journalId, `${holdKey(t.idempotencyKey)}:reversal`);
    return this.transfers.apply(t.id, 'cancel', now, { reason: 'member cancelled' });
  }
}
