// Collections (T-0606, REQ-INS-006): a member pays an institution's fee item from their purse. The
// payment is a transfer of kind 'fee' whose idempotency key is `fee:{feeItemId}`, so it shows in the
// purse's activity and in monitoring like any other movement; its one journal, wallet → the
// institution's own account (T-0613), is keyed the same and tagged with the institution, the member and the fee item,
// so the monthly export reads it straight off the ledger. The journal is the fact: the fee item's
// status and the transfer's state follow it, and a replay after a crash finishes whatever is left.
// The receipt number is derived from the journal, so the same payment always has the same receipt.
// Staff list a month's collections for their institution. Descriptions and roster names are data.
import { DomainError, money, toWire, type Currency } from '@kesher/domain';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { ok, requireIdempotencyKey, requirePrincipal, requireRole, route, type Handler } from '../http.ts';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { Transfer, TransferService } from '../transfers/service.ts';
import { MONTH } from './export.ts';

export const COLLECTIONS_FLAG = 'institutions.money';
export const FEE_JOURNAL_KIND = 'fee';
export const feeKey = (feeItemId: string): string => `fee:${feeItemId}`;

export interface Receipt {
  receiptNumber: string;
  feeItemId: string;
  institutionId: string;
  institutionName: string;
  memberPartyId: string;
  description: string;
  amount: ReturnType<typeof toWire>;
  paidAt: string;
  journalId: string;
}

export interface FeeItemView {
  id: string;
  institutionId: string;
  institutionName: string;
  description: string;
  amount: ReturnType<typeof toWire>;
  status: 'due' | 'paid' | 'waived';
  dueAt: string;
  receipt?: Receipt;
}

/** A fee item still due, for the institution's "who owes" list. Description and name are data. */
export interface OwedFee {
  feeItemId: string;
  memberName: string;
  description: string;
  amount: ReturnType<typeof toWire>;
  dueAt: string;
}

const sumByCurrency = (rows: readonly { amount_minor: string; currency: Currency }[]): ReturnType<typeof toWire>[] => {
  const totals = new Map<Currency, bigint>();
  for (const x of rows) totals.set(x.currency, (totals.get(x.currency) ?? 0n) + BigInt(x.amount_minor));
  return [...totals.entries()].map(([currency, minor]) => toWire(money(minor, currency)));
};

interface FeeRow {
  id: string;
  institution_id: string;
  institution_name: string;
  member_party_id: string;
  description: string;
  amount_minor: string;
  currency: Currency;
  status: 'due' | 'paid' | 'waived';
  due_at: string | Date;
}

interface FeeWithJournal extends FeeRow {
  journal_id: string | null;
  effective_at: string | Date | null;
}

/** What the receipt needs of a journal: the posted journal, or the row read back by key. */
interface JournalRef {
  id: string;
  effectiveAt: string | Date;
}

const FEE_COLUMNS = 'f.id, f.institution_id, i.name as institution_name, f.member_party_id, f.description, f.amount_minor::text, f.currency, f.status, f.due_at';

/**
 * "KC-202611-7F3A9C1B2D4E": the month the journal posted and the last twelve hex digits of the journal
 * id. A uuidv7's leading digits are its timestamp, shared by every id minted in the same minute; the
 * tail is random, so two receipts in a month collide with odds of about one in 10^14.
 */
export function receiptNumber(journalId: string, effectiveAt: Date): string {
  const ym = effectiveAt.toISOString().slice(0, 7).replace('-', '');
  return `KC-${ym}-${journalId.replaceAll('-', '').slice(-12).toUpperCase()}`;
}

export class CollectionsService {
  private readonly db: Database;
  private readonly ledger: PostgresLedger;
  private readonly accounts: AccountService;
  private readonly transfers: TransferService;
  private readonly flags: FeatureFlags;
  constructor(
    db: Database,
    ledger: PostgresLedger,
    accounts: AccountService,
    transfers: TransferService,
    flags: FeatureFlags,
  ) {
    this.db = db;
    this.ledger = ledger;
    this.accounts = accounts;
    this.transfers = transfers;
    this.flags = flags;
  }

  /** GET /fee-items: what the member owes and has paid; due first, soonest and smallest first. One query. */
  async listForMember(memberPartyId: string): Promise<{ items: FeeItemView[] }> {
    const r = await this.db.query<FeeWithJournal>(
      `select ${FEE_COLUMNS}, j.id as journal_id, j.effective_at
         from org.fee_item f join org.institution i on i.id = f.institution_id
         left join ledger.journal j on j.idempotency_key = 'fee:' || f.id::text
        where f.member_party_id = $1 order by (f.status = 'due') desc, f.due_at, f.amount_minor, f.id limit 200`,
      [memberPartyId],
    );
    return { items: r.rows.map((row) => this.view(row)) };
  }

  /** POST /fee-items/{id}/pay: the member's purse pays the institution; paid is final and idempotent. */
  async pay(memberPartyId: string, feeItemId: string, now: Date): Promise<Receipt> {
    if (!(await this.flags.isOn(COLLECTIONS_FLAG))) throw new DomainError('FEATURE_OFF', 'Institution payments are not enabled yet');
    const row = await this.fee(feeItemId);
    if (!row || row.member_party_id !== memberPartyId) throw new DomainError('NOT_FOUND', 'Fee item not found');
    // The journal is the fact. If it exists, the fee is paid, whatever the row says: finish the bookkeeping and answer.
    const posted = await this.journal(row.id);
    if (posted) return this.finish(row, posted, now);
    if (row.status === 'waived') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This fee was waived');
    if (row.status === 'paid') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This fee is marked paid without a payment on the ledger');
    const amount = money(BigInt(row.amount_minor), row.currency);
    const purse = (await this.accounts.purses(memberPartyId)).find((p) => p.currency === amount.currency)!;
    if (purse.available.minor < amount.minor) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the purse for this fee', { available: purse.available.minor.toString(), currency: amount.currency });
    const transfer = await this.transfer(row, amount, now);
    const wallet = await this.accounts.memberAccount(memberPartyId, 'wallet', amount.currency);
    const master = await this.accounts.institutionAccount(row.institution_id, amount.currency);
    const journal = await this.ledger.post({
      idempotencyKey: feeKey(row.id),
      kind: FEE_JOURNAL_KIND,
      effectiveAt: now,
      transferId: transfer.id,
      postings: [
        { accountId: wallet, currency: amount.currency, amountMinor: amount.minor },
        { accountId: master, currency: amount.currency, amountMinor: -amount.minor },
      ],
      metadata: { institutionId: row.institution_id, memberPartyId, feeItemId: row.id, description: row.description },
    });
    return this.finish(row, journal, now);
  }

  /** GET /institutions/{id}/collections: a month's paid fee items with the receipt each produced. */
  async listForInstitution(institutionId: string, month: string): Promise<{ month: string; items: (Receipt & { memberName: string })[]; total: ReturnType<typeof toWire>[]; owed: OwedFee[]; owedTotal: ReturnType<typeof toWire>[] }> {
    const r = await this.db.query<FeeRow & { journal_id: string; effective_at: string | Date; member_name: string | null }>(
      `select ${FEE_COLUMNS}, j.id as journal_id, j.effective_at,
              (select m.member_name from org.member m where m.institution_id = f.institution_id and m.member_party_id = f.member_party_id order by m.updated_at desc limit 1) as member_name
         from org.fee_item f join org.institution i on i.id = f.institution_id
         join ledger.journal j on j.idempotency_key = 'fee:' || f.id::text
        where f.institution_id = $1 and to_char(j.effective_at at time zone 'UTC', 'YYYY-MM') = $2
        order by j.effective_at, j.id`,
      [institutionId, month],
    );
    const items = r.rows.map((x) => ({ ...this.toReceipt(x, x.journal_id, new Date(x.effective_at)), memberName: x.member_name ?? '' }));
    // Who still owes, whatever month the fee falls due in (T-0611): unpaid items, the oldest due first.
    const o = await this.db.query<FeeRow & { member_name: string | null }>(
      `select ${FEE_COLUMNS},
              (select m.member_name from org.member m where m.institution_id = f.institution_id and m.member_party_id = f.member_party_id order by m.updated_at desc limit 1) as member_name
         from org.fee_item f join org.institution i on i.id = f.institution_id
        where f.institution_id = $1 and f.status = 'due'
        order by f.due_at, f.id limit 500`,
      [institutionId],
    );
    const owed = o.rows.map((x) => ({ feeItemId: x.id, memberName: x.member_name ?? '', description: x.description, amount: toWire(money(BigInt(x.amount_minor), x.currency)), dueAt: new Date(x.due_at).toISOString().slice(0, 10) }));
    return { month, items, total: sumByCurrency(r.rows), owed, owedTotal: sumByCurrency(o.rows) };
  }

  /** The transfer for a fee: created and submitted once, found again on a replay. */
  private async transfer(row: FeeRow, amount: ReturnType<typeof money>, now: Date): Promise<Transfer> {
    let t = await this.transfers.create({ idempotencyKey: feeKey(row.id), kind: 'fee', fromPartyId: row.member_party_id, amount }, now);
    if (t.state === 'created') t = await this.transfers.apply(t.id, 'submit', now);
    return t;
  }

  /** After the journal exists: settle the transfer and mark the fee paid if a crash left either undone, then the receipt. */
  private async finish(row: FeeRow, journal: JournalRef, now: Date): Promise<Receipt> {
    const t = await this.transfers.byKey(feeKey(row.id));
    if (t && (t.state === 'submitted' || t.state === 'pending')) await this.transfers.apply(t.id, 'settle', now, { journalId: journal.id });
    if (row.status !== 'paid') await this.db.query(`update org.fee_item set status = 'paid' where id = $1 and status <> 'paid'`, [row.id]);
    return this.toReceipt(row, journal.id, new Date(journal.effectiveAt));
  }

  private async journal(feeItemId: string): Promise<JournalRef | undefined> {
    const j = await this.db.query<{ id: string; effective_at: string | Date }>('select id, effective_at from ledger.journal where idempotency_key = $1', [feeKey(feeItemId)]);
    return j.rows[0] ? { id: j.rows[0].id, effectiveAt: j.rows[0].effective_at } : undefined;
  }

  private async fee(id: string): Promise<FeeRow | undefined> {
    const r = await this.db.query<FeeRow>(`select ${FEE_COLUMNS} from org.fee_item f join org.institution i on i.id = f.institution_id where f.id = $1`, [id]);
    return r.rows[0];
  }

  private toReceipt(row: FeeRow, journalId: string, effectiveAt: Date): Receipt {
    return { receiptNumber: receiptNumber(journalId, effectiveAt), feeItemId: row.id, institutionId: row.institution_id, institutionName: row.institution_name, memberPartyId: row.member_party_id, description: row.description, amount: toWire(money(BigInt(row.amount_minor), row.currency)), paidAt: effectiveAt.toISOString(), journalId };
  }

  private view(row: FeeWithJournal): FeeItemView {
    const receipt = row.journal_id && row.effective_at ? this.toReceipt(row, row.journal_id, new Date(row.effective_at)) : undefined;
    // A journal makes a fee paid even when a crash left the row behind; the next pay() call catches the row up.
    const status = receipt ? 'paid' : row.status;
    return { id: row.id, institutionId: row.institution_id, institutionName: row.institution_name, description: row.description, amount: toWire(money(BigInt(row.amount_minor), row.currency)), status, dueAt: new Date(row.due_at).toISOString().slice(0, 10), ...(receipt ? { receipt } : {}) };
  }
}

/** /fee-items for members; /institutions/{id}/collections for the institution's staff. */
export function collectionsHandlers(collections: CollectionsService, stepUp: StepUpService, staffInstitution: (partyId: string) => Promise<string | undefined>): Record<string, Handler> {
  return {
    listFeeItems: route(async (req) => ok(await collections.listForMember(requirePrincipal(req).partyId))),
    payFeeItem: route(async (req) => {
      const p = requirePrincipal(req);
      requireStepUp(stepUp, req);
      requireIdempotencyKey(req);
      return ok(await collections.pay(p.partyId, req.params['id'] ?? '', req.now));
    }),
    listCollections: route(async (req) => {
      const principal = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
      const institutionId = req.params['id'] ?? '';
      if ((await staffInstitution(principal.partyId)) !== institutionId) throw new DomainError('FORBIDDEN', 'Not staff of this institution');
      const month = String(req.query['month'] ?? '');
      if (!MONTH.test(month)) throw new DomainError('VALIDATION_FAILED', 'month must be YYYY-MM');
      return ok(await collections.listForInstitution(institutionId, month));
    }),
  };
}
