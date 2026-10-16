// addon_order lifecycle (T-0701, REQ-MKT-001, SEQ-10): created → charged → fulfilling → fulfilled,
// or failed → refunded. Charging posts cost, price and commission to the ledger in one journal:
//   wallet            +price      (member pays)
//   addon_payable     −cost       (we owe the vendor)
//   fee_income        −(price − cost)   (commission; negative when a credit makes us subsidise)
// Given a $25 eSIM with $20 cost: addon_payable $20 and fee_income $5. Fulfilment is the
// AddonWorkflow's job through the port; failure refunds to source and restores the credit.
import { DomainError, money, uuidv7, type Currency, type Money } from '@kesher/domain';
import { isPgError, PG, type Database, type SqlClient } from '../db.ts';
import type { MembershipRef } from '../billing/entitlements.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import { enqueue } from '../transfers/outbox.ts';
import type { CreditService } from './credit.ts';

export type OrderState = 'created' | 'charged' | 'fulfilling' | 'fulfilled' | 'failed' | 'refunded';

export interface AddonOrder {
  id: string;
  idempotencyKey: string;
  memberPartyId: string;
  sku: string;
  kind: string;
  provider: string;
  quantity: number;
  state: OrderState;
  cost: Money;
  listPrice: Money;
  credit: Money;
  price: Money;
  chargeJournalId?: string;
  refundJournalId?: string;
  fulfilment?: Record<string, unknown>;
  failureCode?: string;
}

export interface CatalogueItem {
  sku: string;
  kind: 'esim' | 'insurance' | 'concierge';
  provider: string;
  vendorSku: string;
  title: string;
  attributes: Record<string, unknown>;
  cost: Money;
  price: Money;
  active: boolean;
}

const TRANSITIONS: Record<OrderState, OrderState[]> = {
  created: ['charged', 'failed'],
  charged: ['fulfilling', 'failed'],
  fulfilling: ['fulfilled', 'failed'],
  fulfilled: [],
  failed: ['refunded'],
  refunded: [],
};

interface Row {
  id: string;
  idempotency_key: string;
  member_party_id: string;
  sku: string;
  kind: string;
  provider: string;
  quantity: number;
  state: OrderState;
  cost_minor: string;
  price_minor: string;
  list_price_minor: string;
  credit_minor: string;
  currency: Currency;
  charge_journal_id: string | null;
  refund_journal_id: string | null;
  fulfilment: Record<string, unknown> | null;
  failure_code: string | null;
}

export class AddonOrderService {
  constructor(
    private readonly db: Database,
    private readonly ledger: PostgresLedger,
    private readonly accounts: AccountService,
    private readonly credit: CreditService,
  ) {}

  async catalogueItem(sku: string, db: SqlClient = this.db): Promise<CatalogueItem | undefined> {
    const r = await db.query<{ sku: string; kind: CatalogueItem['kind']; provider: string; vendor_sku: string; title: string; attributes: Record<string, unknown>; cost_minor: string; price_minor: string; currency: Currency; active: boolean }>('select * from addons.catalogue_item where sku = $1', [sku]);
    const x = r.rows[0];
    return x ? { sku: x.sku, kind: x.kind, provider: x.provider, vendorSku: x.vendor_sku, title: x.title, attributes: x.attributes, cost: money(BigInt(x.cost_minor), x.currency), price: money(BigInt(x.price_minor), x.currency), active: x.active } : undefined;
  }

  /** createAddonOrder: prices from the catalogue, credit from entitlements, then charge. Idempotent by key. */
  async create(input: { idempotencyKey: string; memberPartyId: string; membership?: MembershipRef | undefined; sku: string; quantity?: number; disclosuresAcknowledged?: boolean }, now: Date): Promise<AddonOrder> {
    const existing = await this.byKey(input.idempotencyKey);
    if (existing) return existing;
    const item = await this.catalogueItem(input.sku);
    if (!item || !item.active) throw new DomainError('NOT_FOUND', 'Add-on not available');
    if (item.kind === 'insurance' && !input.disclosuresAcknowledged) throw new DomainError('VALIDATION_FAILED', 'Insurance disclosures must be acknowledged before payment (REQ-INSR-001)');
    const quantity = input.quantity ?? 1;
    const id = uuidv7(now);
    const q = await this.credit.apply(input.membership, item, quantity, id, now);
    const cost = money(item.cost.minor * BigInt(quantity), item.cost.currency);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `insert into addons.addon_order (id, idempotency_key, member_party_id, sku, kind, provider, quantity, state, cost_minor, price_minor, list_price_minor, credit_minor, currency, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'created', $8, $9, $10, $11, $12, $13, $13)`,
          [id, input.idempotencyKey, input.memberPartyId, item.sku, item.kind, item.provider, quantity, cost.minor.toString(), q.price.minor.toString(), q.listPrice.minor.toString(), q.credit.minor.toString(), item.price.currency, now],
        );
        await tx.query(`insert into addons.addon_order_event (order_id, from_state, to_state, at) values ($1, null, 'created', $2)`, [id, now]);
        await enqueue(tx, 'addon_order', id, 'addon_order.created', { sku: item.sku, kind: item.kind, price: q.price, credit: q.credit });
      });
    } catch (e) {
      if (isPgError(e, PG.UNIQUE_VIOLATION)) return (await this.byKey(input.idempotencyKey))!;
      throw e;
    }
    return this.charge(id, now);
  }

  /** Posts the charge journal (REQ-MKT-001). Idempotent on the order id. */
  async charge(orderId: string, now: Date): Promise<AddonOrder> {
    const o = await this.must(orderId);
    if (o.state !== 'created') return o;
    const wallet = await this.accounts.memberAccount(o.memberPartyId, 'wallet', o.price.currency);
    const payable = await this.accounts.systemAccount('addon_payable', o.price.currency);
    const feeIncome = await this.accounts.systemAccount('fee_income', o.price.currency);
    const commission = o.price.minor - o.cost.minor;
    const postings = [
      { accountId: wallet, currency: o.price.currency, amountMinor: o.price.minor },
      { accountId: payable, currency: o.price.currency, amountMinor: -o.cost.minor },
      { accountId: feeIncome, currency: o.price.currency, amountMinor: -commission },
    ].filter((p) => p.amountMinor !== 0n);
    let journalId: string | undefined;
    if (postings.length >= 2) {
      journalId = (await this.ledger.post({ idempotencyKey: `addon:${o.id}:charge`, kind: 'addon', postings, metadata: { orderId: o.id, sku: o.sku, listPriceMinor: o.listPrice.minor.toString(), creditMinor: o.credit.minor.toString() } })).id;
    }
    return this.transition(o.id, 'charged', now, { chargeJournalId: journalId });
  }

  async transition(orderId: string, to: OrderState, now: Date, extra: { chargeJournalId?: string; refundJournalId?: string; fulfilment?: Record<string, unknown>; failureCode?: string; reason?: string } = {}): Promise<AddonOrder> {
    return this.db.transaction(async (tx) => {
      const r = await tx.query<Row>('select * from addons.addon_order where id = $1 for update', [orderId]);
      const o = r.rows[0];
      if (!o) throw new DomainError('NOT_FOUND', 'Order not found');
      if (!TRANSITIONS[o.state].includes(to)) throw new DomainError('IDEMPOTENCY_CONFLICT', `Cannot move an order from ${o.state} to ${to}`);
      await tx.query(
        `update addons.addon_order set state = $2, charge_journal_id = coalesce($3, charge_journal_id), refund_journal_id = coalesce($4, refund_journal_id), fulfilment = coalesce($5, fulfilment), failure_code = coalesce($6, failure_code), updated_at = $7 where id = $1`,
        [orderId, to, extra.chargeJournalId ?? null, extra.refundJournalId ?? null, extra.fulfilment ? JSON.stringify(extra.fulfilment) : null, extra.failureCode ?? null, now],
      );
      await tx.query(`insert into addons.addon_order_event (order_id, from_state, to_state, reason, at) values ($1, $2, $3, $4, $5)`, [orderId, o.state, to, extra.reason ?? null, now]);
      await enqueue(tx, 'addon_order', orderId, `addon_order.${to}`, { from: o.state, ...(extra.failureCode ? { failureCode: extra.failureCode } : {}) });
      return (await this.get(orderId, tx))!;
    });
  }

  /** Failure after charge: reverse the charge journal (refund to source) and restore the credit (SEQ-10 compensation). */
  async refund(orderId: string, now: Date, reason: string): Promise<AddonOrder> {
    const o = await this.must(orderId);
    if (o.state !== 'failed') throw new DomainError('IDEMPOTENCY_CONFLICT', 'Only a failed order can be refunded');
    let refundJournalId: string | undefined;
    if (o.chargeJournalId) refundJournalId = (await this.ledger.reverse(o.chargeJournalId, `addon:${o.id}:refund`)).id;
    await this.restoreCredit(o);
    return this.transition(o.id, 'refunded', now, { ...(refundJournalId ? { refundJournalId } : {}), reason });
  }

  async get(id: string, db: SqlClient = this.db): Promise<AddonOrder | undefined> {
    const r = await db.query<Row>('select * from addons.addon_order where id = $1', [id]);
    return r.rows[0] ? toOrder(r.rows[0]) : undefined;
  }

  async byKey(key: string): Promise<AddonOrder | undefined> {
    const r = await this.db.query<Row>('select * from addons.addon_order where idempotency_key = $1', [key]);
    return r.rows[0] ? toOrder(r.rows[0]) : undefined;
  }

  private async must(id: string): Promise<AddonOrder> {
    const o = await this.get(id);
    if (!o) throw new DomainError('NOT_FOUND', 'Order not found');
    return o;
  }

  /** Credits are consumed with `addon:<orderId>`; a refund hands the units back with a negative consumption row (idempotent). */
  private async restoreCredit(o: AddonOrder): Promise<void> {
    if (o.credit.minor <= 0n) return;
    const units = await this.db.query<{ membership_id: string; amount: string; key: string; period_start: string }>(`select membership_id, amount::text as amount, key, period_start::text as period_start from billing.entitlement_consumption where idempotency_key = $1`, [`addon:${o.id}`]);
    const u = units.rows[0];
    if (!u) return;
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query(`insert into billing.entitlement_consumption (idempotency_key, membership_id, key, amount, period_start) values ($1, $2, $3, $4, $5::date) on conflict do nothing returning 1`, [`addon:${o.id}:refund`, u.membership_id, u.key, (-BigInt(u.amount)).toString(), u.period_start]);
      if (inserted.rows.length === 0) return;
      await tx.query(`update billing.entitlement_usage set used = greatest(used - $3, 0), updated_at = now() where membership_id = $1 and key = $2 and period_start = $4::date`, [u.membership_id, u.key, u.amount, u.period_start]);
    });
  }
}

function toOrder(r: Row): AddonOrder {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    memberPartyId: r.member_party_id,
    sku: r.sku,
    kind: r.kind,
    provider: r.provider,
    quantity: r.quantity,
    state: r.state,
    cost: money(BigInt(r.cost_minor), r.currency),
    listPrice: money(BigInt(r.list_price_minor), r.currency),
    credit: money(BigInt(r.credit_minor), r.currency),
    price: money(BigInt(r.price_minor), r.currency),
    ...(r.charge_journal_id ? { chargeJournalId: r.charge_journal_id } : {}),
    ...(r.refund_journal_id ? { refundJournalId: r.refund_journal_id } : {}),
    ...(r.fulfilment ? { fulfilment: r.fulfilment } : {}),
    ...(r.failure_code ? { failureCode: r.failure_code } : {}),
  };
}
