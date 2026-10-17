// Closure (T-0504, REQ-WAL-005): a member closes their account only once every purse is empty. What
// remains is returned to where it came from: refunds against the member's settled loads, newest first,
// through FundingPort.refund, each a transfer of kind 'refund' keyed `closure:{partyId}:{loadTransferId}`
// and journaled wallet → partner_settlement only when the vendor confirms. The account closes the moment
// the last purse reads zero (REQ-WAL-005): sessions no longer sign in, auto-reload is off, and the audit
// chain carries the closure. Money that has no load behind it (received by transfer) cannot be refunded
// here and waits on a payout (T-0510): the closure reports it as blocked rather than guessing.
import { DomainError, money, toWire, type Currency, type Money } from '@kesher/domain';
import { FundingError, type FundingPort, type Refund } from '@kesher/ports';
import type { IdentityRepository } from '../auth/repository.ts';
import type { AuditService } from '../audit/service.ts';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferService } from '../transfers/service.ts';

export const REFUND_JOURNAL_KIND = 'refund';
export type ClosureState = 'open' | 'refunding' | 'blocked' | 'closed';
export type BlockedReason = 'HOLDS_OUTSTANDING' | 'OVERDRAWN' | 'NO_REFUND_SOURCE' | 'REFUND_FAILED';

export interface ClosureView {
  state: ClosureState;
  balances: { currency: Currency; available: ReturnType<typeof toWire>; holds: ReturnType<typeof toWire> }[];
  refunds: { id: string; amount: ReturnType<typeof toWire>; state: 'pending' | 'settled' | 'failed'; failureCode?: string }[];
  blockedReason?: BlockedReason;
  closedAt?: string;
}

interface Deps {
  db: Database;
  port: FundingPort;
  ledger: PostgresLedger;
  accounts: AccountService;
  transfers: TransferService;
  identity: IdentityRepository;
  audit: AuditService;
  provider: string;
}

export const refundKey = (partyId: string, loadTransferId: string): string => `closure:${partyId}:${loadTransferId}`;
export const refundSettleKey = (key: string): string => `${key}:settle`;

export class ClosureService {
  constructor(private readonly d: Deps) {}

  /** POST /me/closure: start, or continue, closing the member's account. Idempotent: every call reports the current state. */
  async close(partyId: string, now: Date): Promise<ClosureView> {
    const user = await this.d.identity.findUser(partyId);
    if (!user) throw new DomainError('NOT_FOUND', 'Account not found');
    if (user.status === 'closed') return this.status(partyId, now);
    const purses = await this.d.accounts.purses(partyId);
    if (purses.some((p) => p.holds.minor !== 0n)) return this.blocked(partyId, 'HOLDS_OUTSTANDING', now);
    if (purses.some((p) => p.available.minor < 0n)) return this.blocked(partyId, 'OVERDRAWN', now);
    await this.d.db.query(`update ops.auto_reload set enabled = false, updated_at = $2 where party_id = $1 and enabled`, [partyId, now]);

    for (const purse of purses) {
      let remaining = purse.available.minor;
      for (const r of await this.refundTransfers(partyId, purse.currency)) if (r.state === 'submitted') remaining -= r.amount.minor;
      if (remaining <= 0n) continue;
      for (const load of await this.refundableLoads(partyId, purse.currency)) {
        if (remaining <= 0n) break;
        const amount = money(remaining < load.refundable ? remaining : load.refundable, purse.currency);
        const r = await this.refundAgainst(partyId, load, amount, now);
        if (r.state !== 'failed') remaining -= amount.minor;
      }
    }
    return this.settle(partyId, now);
  }

  /** GET /me/closure: where the closure stands; pending refunds are asked about at the vendor. */
  async status(partyId: string, now: Date): Promise<ClosureView> {
    const user = await this.d.identity.findUser(partyId);
    if (!user) throw new DomainError('NOT_FOUND', 'Account not found');
    if (user.status === 'closed') return this.view(partyId, 'closed', now);
    const pending = (await this.refundTransfers(partyId)).filter((t) => t.state === 'submitted');
    if (pending.length === 0) return this.view(partyId, 'open', now);
    for (const t of pending) {
      const refundId = await this.vendorRefundOf(t.id);
      if (refundId) await this.applyRefund(t, await this.d.port.getRefund(refundId), now);
    }
    return this.settle(partyId, now);
  }

  // ---- the pieces ----

  private async refundAgainst(partyId: string, load: RefundableLoad, amount: Money, now: Date): Promise<Transfer> {
    const key = refundKey(partyId, load.transferId);
    let t = await this.d.transfers.byKey(key);
    if (t && t.state !== 'created' && t.state !== 'submitted') return t;
    t ??= await this.d.transfers.create({ idempotencyKey: key, kind: 'refund', fromPartyId: partyId, amount }, now);
    if (t.state === 'created') t = await this.d.transfers.apply(t.id, 'submit', now, { reason: 'closure refund' });
    let refund: Refund;
    try {
      refund = await this.d.port.refund({ loadId: load.vendorLoadId, amount: t.amount }, key);
    } catch (e) {
      if (e instanceof FundingError && e.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('PROVIDER_UNAVAILABLE', 'Funding is temporarily unavailable; try again');
      if (e instanceof FundingError) return this.d.transfers.apply(t.id, 'fail', now, { failureCode: e.code, reason: e.message.slice(0, 200) });
      throw e;
    }
    await this.d.db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('refund', $1, $2, $3) on conflict do nothing`, [t.id, this.d.provider, refund.refundId]);
    return this.applyRefund(t, refund, now);
  }

  private async applyRefund(t: Transfer, refund: Refund, now: Date): Promise<Transfer> {
    if (t.state !== 'submitted') return t;
    switch (refund.status) {
      case 'pending':
        return t;
      case 'failed':
        return this.d.transfers.apply(t.id, 'fail', now, { failureCode: refund.failureCode ?? 'REFUND_FAILED', reason: 'vendor refused the refund' });
      case 'succeeded': {
        const { currency } = t.amount;
        const wallet = await this.d.accounts.memberAccount(t.fromPartyId!, 'wallet', currency);
        const partner = await this.d.accounts.systemAccount('partner_settlement', currency);
        const journal = await this.d.ledger.post({
          idempotencyKey: refundSettleKey(t.idempotencyKey),
          kind: REFUND_JOURNAL_KIND,
          transferId: t.id,
          effectiveAt: now,
          postings: [
            { accountId: wallet, currency, amountMinor: t.amount.minor },
            { accountId: partner, currency, amountMinor: -t.amount.minor },
          ],
          metadata: { closure: true, provider: this.d.provider, refundId: refund.refundId, loadId: refund.loadId },
        });
        return this.d.transfers.apply(t.id, 'settle', now, { journalId: journal.id });
      }
    }
  }

  /** Closes when every purse is empty and nothing is pending; otherwise reports why not. */
  private async settle(partyId: string, now: Date): Promise<ClosureView> {
    const purses = await this.d.accounts.purses(partyId);
    const refunds = await this.refundTransfers(partyId);
    if (refunds.some((t) => t.state === 'submitted')) return this.view(partyId, 'refunding', now);
    if (purses.every((p) => p.available.minor === 0n && p.holds.minor === 0n)) {
      await this.d.identity.setUserStatus(partyId, 'closed');
      await this.d.audit.record({ actorId: partyId, actorRole: 'member', action: 'account.closed', subject: partyId, reason: 'member closed the account (REQ-WAL-005)', payload: { refunds: refunds.filter((t) => t.state === 'settled').map((t) => t.id) } }, now);
      return this.view(partyId, 'closed', now);
    }
    const lastFailed = refunds.filter((t) => t.state === 'failed').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    return this.blocked(partyId, lastFailed && Date.parse(lastFailed.updatedAt) >= now.getTime() - 60_000 ? 'REFUND_FAILED' : 'NO_REFUND_SOURCE', now);
  }

  private async blocked(partyId: string, reason: BlockedReason, now: Date): Promise<ClosureView> {
    return { ...(await this.view(partyId, 'blocked', now)), blockedReason: reason };
  }

  private async view(partyId: string, state: ClosureState, now: Date): Promise<ClosureView> {
    const purses = await this.d.accounts.purses(partyId);
    const refunds = await this.refundTransfers(partyId);
    return {
      state,
      balances: purses.map((p) => ({ currency: p.currency, available: toWire(p.available), holds: toWire(p.holds) })),
      refunds: refunds.map((t) => ({ id: t.id, amount: toWire(t.amount), state: t.state === 'settled' ? 'settled' : t.state === 'failed' ? 'failed' : 'pending', ...(t.failureCode ? { failureCode: t.failureCode } : {}) })),
      ...(state === 'closed' ? { closedAt: now.toISOString() } : {}),
    };
  }

  /** The member's settled loads of one currency, newest first, with what each can still give back. */
  private async refundableLoads(partyId: string, currency: Currency): Promise<RefundableLoad[]> {
    const r = await this.d.db.query<{ id: string; amount_minor: string; external_id: string; refunded: string }>(
      `select t.id, t.amount_minor::text, x.external_id,
              coalesce((select sum(r.amount_minor) from ops.transfer r where r.kind = 'refund' and r.idempotency_key = $3 || t.id and r.state <> 'failed'), 0)::text as refunded
         from ops.transfer t join ops.external_ref x on x.entity_type = 'transfer' and x.entity_id = t.id and x.provider = $4
        where t.kind = 'load' and t.to_party_id = $1 and t.currency = $2 and t.state = 'settled'
        order by (select max(e.id) from ops.transfer_event e where e.transfer_id = t.id) desc`,
      [partyId, currency, `closure:${partyId}:`, this.d.provider],
    );
    return r.rows.map((x) => ({ transferId: x.id, vendorLoadId: x.external_id, refundable: BigInt(x.amount_minor) - BigInt(x.refunded) })).filter((l) => l.refundable > 0n);
  }

  private async refundTransfers(partyId: string, currency?: Currency): Promise<Transfer[]> {
    const r = await this.d.db.query<{ id: string }>(`select id from ops.transfer where kind = 'refund' and idempotency_key like $1 ${currency ? 'and currency = $2' : ''} order by created_at, id`, currency ? [`closure:${partyId}:%`, currency] : [`closure:${partyId}:%`]);
    const out: Transfer[] = [];
    for (const row of r.rows) {
      const t = await this.d.transfers.get(row.id);
      if (t) out.push(t);
    }
    return out;
  }

  private async vendorRefundOf(transferId: string): Promise<string | undefined> {
    const r = await this.d.db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'refund' and entity_id = $1 and provider = $2`, [transferId, this.d.provider]);
    return r.rows[0]?.external_id;
  }
}

interface RefundableLoad {
  transferId: string;
  vendorLoadId: string;
  refundable: bigint;
}
