// Fees collected from US funders on the provider's payment page (T-0652, REQ-INS-023), behind institutions.usBanking.
//
// A fee batch (T-0629) on an institution whose US account is approved and open in KYB may be "collected in the US": each item's funder gets a
// payment page, created once per item (the provider's key `us-fee-item:<item>`), and the batch one provider collection (`us-fee-batch:<batch>`).
// The money lands in the institution's own US account, outside Kesher's ledger: nothing here posts to `ledger.*`. The funder's name, email and
// mobile are personal data the institution entered: they are sent to the provider and not stored here or logged.
//
// Paid comes from the provider, never from an event body: the T-0649 `collected` hint (and the nightly sweep, T-0654) re-read the entity's
// payments through the port, and `reconcileEntity` records each one. `org.fee_external_payment` is insert-only and unique on the provider's
// payment ref per kind, so a payment marks its item paid exactly once however often it is told. A payment of another amount, one for an item
// Kesher's purse already paid, and a refund are not marked: each opens a case for a person. The provider's ids live in ops.external_ref.
import { DomainError, money, toWire, uuidv7, type Money } from '@kesher/domain';
import { InstitutionBankingError, type InstitutionBankingPort, type ProviderRegistry } from '@kesher/ports';
import type { AuditService } from '../audit/service.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import { created, requireIdempotencyKey, requireRole, route, type Handler, type HttpRequest } from '../http.ts';
import type { KybGate } from './kyb-gate.ts';
import { asDomain } from './us-funding.ts';
import { US_BANKING_FLAG, type InstitutionUsBanking } from './us-banking.ts';

const COLLECTION_REF = 'fee_batch_us_collection';
const INTENT_REF = 'fee_item_us_intent';
const MAX_FUNDERS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const MOBILE = /^\+?\d{7,15}$/;

export interface UsCollectionsDeps {
  db: Database;
  flags: FeatureFlags;
  audit: AuditService;
  kyb: Pick<KybGate, 'require'>;
  registry: ProviderRegistry;
  usBanking: Pick<InstitutionUsBanking, 'account'>;
}

interface Funder {
  feeItemId: string;
  name: string;
  email: string;
  mobile: string;
}

export interface UsCollectionView {
  batchId: string;
  items: { feeItemId: string; status: 'collecting' | 'paid'; paymentUrl: string }[];
}

function parseFunders(body: unknown): Funder[] {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const list = b['funders'];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_FUNDERS) throw new DomainError('VALIDATION_FAILED', `funders must list 1 to ${MAX_FUNDERS} fee items with a contact each`);
  const seen = new Set<string>();
  return list.map((x: unknown) => {
    const f = typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};
    const id = typeof f['feeItemId'] === 'string' && UUID.test(f['feeItemId']) ? f['feeItemId'].toLowerCase() : '';
    const name = typeof f['name'] === 'string' ? f['name'].trim() : '';
    const email = typeof f['email'] === 'string' ? f['email'].trim() : '';
    const mobile = typeof f['mobile'] === 'string' ? f['mobile'].replace(/[\s()-]/g, '') : '';
    if (!id || seen.has(id)) throw new DomainError('VALIDATION_FAILED', 'Every funder needs a distinct feeItemId');
    seen.add(id);
    if (!name || name.length > 100 || !EMAIL.test(email) || !MOBILE.test(mobile)) throw new DomainError('VALIDATION_FAILED', 'Every funder needs a name (up to 100 characters), an email and a mobile number', { feeItemId: id });
    return { feeItemId: id, name, email, mobile };
  });
}

interface ItemRow {
  id: string;
  institution_id: string;
  batch_id: string | null;
  amount_minor: string;
  currency: string;
  status: string;
}

export class UsCollections {
  private readonly d: UsCollectionsDeps;
  constructor(deps: UsCollectionsDeps) {
    this.d = deps;
  }

  private async requireOn(): Promise<void> {
    if (!(await this.d.flags.isOn(US_BANKING_FLAG))) throw new DomainError('FEATURE_OFF', 'US banking is not available');
  }

  /** Marks a batch's items for collection in the US and answers each funder's payment page. Safe to repeat: the provider's keys are the item and the batch. */
  async collect(institutionId: string, batchId: string, body: unknown, actorId: string, now: Date): Promise<UsCollectionView> {
    await this.requireOn();
    const funders = parseFunders(body);
    const acct = await this.d.usBanking.account(institutionId);
    if (!acct || acct.status !== 'approved' || !acct.ref) throw new DomainError('VALIDATION_FAILED', 'The US account is not approved yet');
    await this.d.kyb.require(institutionId, 'us_banking');
    const batch = (await this.d.db.query<{ description: string; amount_minor: string; currency: string }>('select description, amount_minor::text, currency from org.fee_batch where id = $1 and institution_id = $2', [UUID.test(batchId) ? batchId : '00000000-0000-0000-0000-000000000000', institutionId])).rows[0];
    if (!batch) throw new DomainError('NOT_FOUND', 'Fee batch not found');
    if (batch.currency !== 'USD') throw new DomainError('VALIDATION_FAILED', 'Only USD fees are collected in the US');
    const items = (await this.d.db.query<ItemRow>('select id, institution_id, batch_id, amount_minor::text, currency, status from org.fee_item where batch_id = $1 and id = any($2::uuid[])', [batchId, funders.map((f) => f.feeItemId)])).rows;
    if (items.length !== funders.length) throw new DomainError('VALIDATION_FAILED', 'Every fee item must belong to this batch');
    // Under a lock on the items: the fee is still due (or already collected here), no purse journal exists, and the marker is written BEFORE the provider is
    // called, so the purse cannot pay a fee whose page is about to go out. A failed provider call leaves the marker; repeating the call finishes the job.
    await this.d.db.transaction(async (tx) => {
      const locked = (await tx.query<ItemRow>('select id, institution_id, batch_id, amount_minor::text, currency, status from org.fee_item where id = any($1::uuid[]) order by id for update', [funders.map((f) => f.feeItemId)])).rows;
      const marked = new Set((await tx.query<{ fee_item_id: string }>('select fee_item_id from org.fee_us_collect where fee_item_id = any($1::uuid[])', [funders.map((f) => f.feeItemId)])).rows.map((r) => r.fee_item_id));
      for (const it of locked) {
        const purse = (await tx.query('select 1 from ledger.journal where idempotency_key = $1', [`fee:${it.id}`])).rows.length > 0;
        // A fee already paid (by the purse or by the funder) is not collected again; a due one, or one already collected here, is.
        if (purse || (it.status !== 'due' && !(marked.has(it.id) && it.status === 'paid'))) throw new DomainError('IDEMPOTENCY_CONFLICT', 'A fee that is not due cannot be collected', { feeItemId: it.id });
        await tx.query('insert into org.fee_us_collect (fee_item_id, institution_id, batch_id, requested_by, created_at) values ($1, $2, $3, $4, $5) on conflict do nothing', [it.id, institutionId, batchId, actorId, now]);
      }
    });
    const port = this.d.registry.resolve<InstitutionBankingPort>('institution-banking', acct.market);
    const amount = money(BigInt(batch.amount_minor), 'USD');
    const collectionRef = await this.collectionOf(port, acct.ref, acct.provider ?? 'simulator', batchId, batch.description, amount);
    const out: UsCollectionView['items'] = [];
    for (const f of funders) {
      const page = await port.createPaymentPage({ collectionRef, funder: { name: f.name, email: f.email, mobile: f.mobile }, idempotencyKey: `us-fee-item:${f.feeItemId}` }).catch(asDomain);
      await this.d.db.query('insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ($1, $2, $3, $4) on conflict do nothing', [INTENT_REF, f.feeItemId, acct.provider ?? 'simulator', page.intentRef]);
      out.push({ feeItemId: f.feeItemId, status: items.find((i) => i.id === f.feeItemId)!.status === 'paid' ? 'paid' : 'collecting', paymentUrl: page.paymentUrl });
    }
    await this.d.audit.record({ actorId, actorRole: 'org_finance', action: 'institution.us_fee_collection.create', subject: institutionId, reason: 'Fee batch collected in the US', payload: { batchId, items: funders.length } }, now);
    return { batchId, items: out };
  }

  /** The batch's provider collection: created once (the key is the batch), remembered in ops.external_ref. */
  private async collectionOf(port: InstitutionBankingPort, entityRef: string, provider: string, batchId: string, description: string, amount: Money): Promise<string> {
    const known = (await this.d.db.query<{ external_id: string }>('select external_id from ops.external_ref where entity_type = $1 and entity_id = $2', [COLLECTION_REF, batchId])).rows[0];
    if (known) return known.external_id;
    // The title is staff text; the batch id keeps two batches of one description apart at a provider that reuses a collection by name.
    const title = `${description.slice(0, 80)} (${batchId.slice(-8)})`;
    const made = await port.createCollection({ entityRef, title, amount, idempotencyKey: `us-fee-batch:${batchId}` }).catch(asDomain);
    await this.d.db.query('insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ($1, $2, $3, $4) on conflict do nothing', [COLLECTION_REF, batchId, provider, made.collectionRef]);
    return made.collectionRef;
  }

  /**
   * Reads an entity's payments since a time through the port and records each against its fee item. The provider's answer is the only source of
   * "paid". Payments for pages we did not make are left to the nightly reconciliation (T-0654). A page boundary loses nothing: the port yields
   * every page. Answers how many items it marked paid and how many cases it opened.
   */
  async reconcileEntity(port: InstitutionBankingPort, entityRef: string, since: Date, now: Date, provider?: string): Promise<{ marked: number; cases: number }> {
    let marked = 0;
    let cases = 0;
    for await (const p of port.collectPayments({ entityRef, since })) {
      const r = await this.record(p, provider, now);
      marked += r.marked;
      cases += r.cases;
    }
    return { marked, cases };
  }

  /**
   * The provider's `collected` hint: only for an entity we hold (an institution's own, or the platform's), re-read from the oldest page still being
   * collected so a late refund is found, through the port of that institution's market. An entity we do not know, or one the provider does not
   * answer for, is ignored (a stored event that threw would be replayed for ever).
   */
  async onCollectedHint(entityRef: string, platformEntityRef: string | undefined, fallbackMarket: 'IL' | 'US', now: Date): Promise<void> {
    const own = (await this.d.db.query<{ entity_id: string; provider: string }>(`select entity_id, provider from ops.external_ref where entity_type = 'institution_us_banking' and external_id = $1`, [entityRef])).rows[0];
    if (!own && entityRef !== platformEntityRef) return;
    const acct = own ? await this.d.usBanking.account(own.entity_id) : undefined;
    const since = (await this.d.db.query<{ since: string | Date | null }>(own ? 'select min(created_at) as since from org.fee_us_collect where institution_id = $1' : 'select min(created_at) as since from org.fee_us_collect', own ? [own.entity_id] : [])).rows[0]?.since;
    if (!since) return;
    const port = this.d.registry.resolve<InstitutionBankingPort>('institution-banking', acct?.market ?? fallbackMarket);
    try {
      await this.reconcileEntity(port, entityRef, new Date(since), now, own?.provider);
    } catch (e) {
      if (e instanceof InstitutionBankingError && (e.code === 'NOT_FOUND' || e.code === 'NOT_APPROVED')) return;
      throw e;
    }
  }

  /** One provider payment, applied as `reconcileEntity` applies it (the nightly reconciliation, T-0654, applies the ones the hint missed). */
  applyPayment(p: { paymentRef: string; intentRef: string; amount: Money; status: 'paid' | 'declined' | 'refunded' }, provider: string | undefined, now: Date): Promise<{ marked: number; cases: number }> {
    return this.record(p, provider, now);
  }

  /** One provider payment, applied once, under a lock on its fee item. */
  private async record(p: { paymentRef: string; intentRef: string; amount: Money; status: 'paid' | 'declined' | 'refunded' }, provider: string | undefined, now: Date): Promise<{ marked: number; cases: number }> {
    if (p.status === 'declined') return { marked: 0, cases: 0 };
    const ref = (await this.d.db.query<{ entity_id: string }>(`select entity_id from ops.external_ref where entity_type = $1 and external_id = $2 ${provider ? 'and provider = $3' : ''}`, provider ? [INTENT_REF, p.intentRef, provider] : [INTENT_REF, p.intentRef])).rows[0];
    if (!ref) return { marked: 0, cases: 0 };
    return this.d.db.transaction(async (tx) => {
      const item = (await tx.query<ItemRow>('select id, institution_id, batch_id, amount_minor::text, currency, status from org.fee_item where id = $1 for update', [ref.entity_id])).rows[0];
      if (!item) return { marked: 0, cases: 0 };
      const matches = p.amount.currency === 'USD' && item.currency === 'USD' && p.amount.minor === BigInt(item.amount_minor);
      if (!matches) return { marked: 0, cases: await this.openCaseIn(tx, item, p.paymentRef, 'amount_mismatch', { paid: toWire(p.amount), owed: { minor: item.amount_minor, currency: item.currency } }, now) };
      // The purse already paid this fee: the funder paid twice, which a person must settle.
      if ((await tx.query('select 1 from ledger.journal where idempotency_key = $1', [`fee:${item.id}`])).rows.length > 0) return { marked: 0, cases: await this.openCaseIn(tx, item, p.paymentRef, 'paid_twice', {}, now) };
      const row = (kind: 'payment' | 'refund') => tx.query(`insert into org.fee_external_payment (id, fee_item_id, kind, provider_payment_ref, amount_minor, currency, at) values ($1, $2, $3, $4, $5, 'USD', $6) on conflict do nothing`, [uuidv7(now), item.id, kind, p.paymentRef, p.amount.minor.toString(), now]);
      if (p.status === 'refunded') {
        // Money given back is a person's call. Seen refunded for the first time, the payment never counted: only the refund is recorded, the fee stays due.
        const had = (await tx.query(`select 1 from org.fee_external_payment where provider_payment_ref = $1 and kind = 'payment'`, [p.paymentRef])).rows.length > 0;
        const refunded = await row('refund');
        return { marked: 0, cases: refunded.rowCount > 0 ? await this.openCaseIn(tx, item, p.paymentRef, 'refunded', { afterPayment: had }, now) : 0 };
      }
      const paid = await row('payment');
      if (item.status === 'waived') return { marked: 0, cases: paid.rowCount > 0 ? await this.openCaseIn(tx, item, p.paymentRef, 'paid_after_waive', {}, now) : 0 };
      await tx.query(`update org.fee_item set status = 'paid' where id = $1 and status = 'due'`, [item.id]);
      return { marked: paid.rowCount, cases: 0 };
    });
  }

  private async openCase(item: ItemRow, paymentRef: string, reason: string, extra: Record<string, unknown>, now: Date): Promise<number> {
    return this.openCaseIn(this.d.db, item, paymentRef, reason, extra, now);
  }

  private async openCaseIn(db: Pick<Database, 'query'>, item: ItemRow, paymentRef: string, reason: string, extra: Record<string, unknown>, now: Date): Promise<number> {
    const r = await db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'us_fee_collection', $2, 'medium', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
      [uuidv7(now), `us-fee-case:${paymentRef}:${reason}`, { feeItemId: item.id, institutionId: item.institution_id, paymentRef, reason, ...extra }, now],
    );
    return r.rowCount;
  }
}

type StaffOfFn = (partyId: string) => Promise<{ institutionId: string; role: 'staff' | 'finance' | 'admin' } | undefined>;

export function usCollectionsHandlers(svc: UsCollections, staffOf: StaffOfFn): Record<string, Handler> {
  return {
    collectFeeBatchInUs: route(async (req: HttpRequest) => {
      const p = requireRole(req, 'org_finance', 'org_admin');
      requireIdempotencyKey(req);
      const institutionId = req.params['id'] ?? '';
      const staff = await staffOf(p.partyId);
      if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
      if (staff.role !== 'finance' && staff.role !== 'admin') throw new DomainError('FORBIDDEN', 'Only finance staff and admins collect fees');
      return created(await svc.collect(institutionId, req.params['batchId'] ?? '', req.body, p.partyId, req.now));
    }),
  };
}
