// Closure (T-0504, REQ-WAL-005): a member closes their account only once every purse is empty. What
// remains is returned to where it came from: refunds against the member's settled loads, newest first,
// through FundingPort.refund, each a transfer of kind 'refund' keyed `closure:{partyId}:{loadTransferId}`
// and journaled wallet → partner_settlement only when the vendor confirms. The account closes the moment
// the last purse reads zero (REQ-WAL-005): sessions no longer sign in, auto-reload is off, and the audit
// chain carries the closure. Money that has no load behind it (received by transfer) cannot be refunded
// here and waits on a payout (T-0510): the closure reports it as blocked rather than guessing.
// A load that converted into the other purse (T-0517) refunds to its source in the instrument currency at
// the load's own club rate (T-0521, ADR-014 decision 12), so neither side gains from a rate move between
// the load and the closure. The club keeps the load's markup (T-0523, ADR-015): the conversion was
// delivered, so what is left in the purse goes back at the rate before markup, rounded down, and never
// more than the load paid. No second markup is charged on the way back.
import { DomainError, money, toWire, type Currency, type Money, type Posting } from '@kesher/domain';
import { FundingError, RATE_SCALE, type FundingPort, type Refund } from '@kesher/ports';
import type { IdentityRepository } from '../auth/repository.ts';
import type { AuditService } from '../audit/service.ts';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferConversion, TransferService } from '../transfers/service.ts';

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
  private readonly d: Deps;
  constructor(d: Deps) {
    this.d = d;
  }

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
    t ??= await this.d.transfers.create({ idempotencyKey: key, kind: 'refund', fromPartyId: partyId, amount, ...(load.converted ? { conversion: backToSource(load, amount) } : {}) }, now);
    if (t.state === 'created') t = await this.d.transfers.apply(t.id, 'submit', now, { reason: 'closure refund' });
    let refund: Refund;
    try {
      // The vendor refunds in the instrument's currency: for a converted load, that is the conversion's leg.
      refund = await this.d.port.refund({ loadId: load.vendorLoadId, amount: t.conversion?.received ?? t.amount }, key);
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
        const journal = await this.d.ledger.post({
          idempotencyKey: refundSettleKey(t.idempotencyKey),
          kind: REFUND_JOURNAL_KIND,
          transferId: t.id,
          effectiveAt: now,
          postings: await this.refundLegs(t),
          metadata: {
            closure: true,
            provider: this.d.provider,
            refundId: refund.refundId,
            loadId: refund.loadId,
            ...(t.conversion ? { fx_rate_version: t.conversion.rateVersion, fx_rate_id: t.conversion.rateId, fromPurse: toWire(t.amount), toSource: toWire(t.conversion.received) } : {}),
          },
        });
        return this.d.transfers.apply(t.id, 'settle', now, { journalId: journal.id });
      }
    }
  }

  /**
   * The member's purse back to partner_settlement. Same currency: two legs. Converted: fx_position takes
   * the purse amount and pays partner_settlement the source amount in the instrument's currency. Fee income
   * keeps the load's markup (ADR-015), so after a whole refund the club's FX position holds exactly the
   * shekels (or dollars) the markup earned.
   */
  private async refundLegs(t: Transfer): Promise<Posting[]> {
    const { minor, currency } = t.amount;
    const wallet = await this.d.accounts.memberAccount(t.fromPartyId!, 'wallet', currency);
    const c = t.conversion;
    if (!c) {
      const partner = await this.d.accounts.systemAccount('partner_settlement', currency);
      return [
        { accountId: wallet, currency, amountMinor: minor },
        { accountId: partner, currency, amountMinor: -minor },
      ];
    }
    const to = c.received.currency;
    return [
      { accountId: wallet, currency, amountMinor: minor },
      { accountId: await this.d.accounts.systemAccount('fx_position', currency), currency, amountMinor: -minor },
      { accountId: await this.d.accounts.systemAccount('fx_position', to), currency: to, amountMinor: c.received.minor },
      { accountId: await this.d.accounts.systemAccount('partner_settlement', to), currency: to, amountMinor: -c.received.minor },
    ];
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

  /**
   * The member's settled loads that credited this purse, newest first, with what each can still give back
   * in the purse's currency. A converted load credited `received_minor` in the purse and took `amount_minor`
   * from the instrument; its refunds so far are counted on both sides.
   */
  private async refundableLoads(partyId: string, currency: Currency): Promise<RefundableLoad[]> {
    const r = await this.d.db.query<{ id: string; amount_minor: string; currency: Currency; received_minor: string | null; fx_rate_id: string | null; fx_rate_version: number | null; fx_rate_scaled: string | null; external_id: string; refunded: string; refunded_source: string }>(
      `select t.id, t.amount_minor::text, t.currency, t.received_minor::text, t.fx_rate_id, t.fx_rate_version, t.fx_rate_scaled::text, x.external_id,
              coalesce((select sum(r.amount_minor) from ops.transfer r where r.kind = 'refund' and r.idempotency_key = $3 || t.id and r.state <> 'failed'), 0)::text as refunded,
              coalesce((select sum(coalesce(r.received_minor, r.amount_minor)) from ops.transfer r where r.kind = 'refund' and r.idempotency_key = $3 || t.id and r.state <> 'failed'), 0)::text as refunded_source
         from ops.transfer t join ops.external_ref x on x.entity_type = 'transfer' and x.entity_id = t.id and x.provider = $4
        where t.kind = 'load' and t.to_party_id = $1 and coalesce(t.received_currency, t.currency) = $2 and t.state = 'settled'
        order by (select max(e.id) from ops.transfer_event e where e.transfer_id = t.id) desc`,
      [partyId, currency, `closure:${partyId}:`, this.d.provider],
    );
    return r.rows
      .map((x): RefundableLoad => {
        const credited = BigInt(x.received_minor ?? x.amount_minor);
        const base = { transferId: x.id, vendorLoadId: x.external_id, refundable: credited - BigInt(x.refunded) };
        if (x.received_minor === null || x.fx_rate_id === null || x.fx_rate_version === null || x.fx_rate_scaled === null) return base;
        return { ...base, converted: { credited, paid: money(BigInt(x.amount_minor), x.currency), paidRemaining: BigInt(x.amount_minor) - BigInt(x.refunded_source), rateId: x.fx_rate_id, rateVersion: x.fx_rate_version, rateScaled: BigInt(x.fx_rate_scaled) } };
      })
      .filter((l) => l.refundable > 0n);
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
  /** What the load can still give back, in the purse's currency. */
  refundable: bigint;
  /** Set when the load converted into this purse: what it paid at the source, what of that is left, and the
   *  club rate it converted at (purse units per source unit × 1e6, before markup). */
  converted?: { credited: bigint; paid: Money; paidRemaining: bigint; rateId: string; rateVersion: number; rateScaled: bigint };
}

/**
 * The source's share of a refund from a converted load: the purse amount back at the load's club rate,
 * before markup (ADR-015: the club keeps the markup), rounded down and never more than the load has left
 * to give. The scaled rate recorded is the one this refund applied (source units per purse unit × 1e6).
 */
function backToSource(load: RefundableLoad, fromPurse: Money): TransferConversion {
  const c = load.converted!;
  const atClubRate = (fromPurse.minor * RATE_SCALE) / c.rateScaled;
  const source = atClubRate < c.paidRemaining ? atClubRate : c.paidRemaining;
  if (source <= 0n) throw new DomainError('VALIDATION_FAILED', 'The amount is too small to refund to the source');
  return { received: money(source, c.paid.currency), rateId: c.rateId, rateVersion: c.rateVersion, rateScaled: (source * 1_000_000n) / fromPurse.minor || 1n, markupBps: 0n };
}
