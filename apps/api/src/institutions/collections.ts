// Collections (T-0606, REQ-INS-006): a member pays an institution's fee item from their purse. One
// journal, wallet → institution_master, keyed `fee:{feeItemId}` and tagged with the institution and the
// member, so the monthly export reads it straight off the ledger; the fee item turns paid and the
// receipt number is derived from the journal, so the same payment always has the same receipt. Staff
// list a month's collections for their institution. Descriptions and roster names are data.
import { DomainError, money, toWire, type Currency, type Money } from '@kesher/domain';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { ok, requireIdempotencyKey, requirePrincipal, requireRole, route, type Handler } from '../http.ts';
import type { Database } from '../db.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';

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

/** "KC-202611-3F9A2C1B": the month the journal posted and the first eight hex digits of the journal id. */
export function receiptNumber(journalId: string, effectiveAt: Date): string {
  const ym = effectiveAt.toISOString().slice(0, 7).replace('-', '');
  return `KC-${ym}-${journalId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

export class CollectionsService {
  constructor(
    private readonly db: Database,
    private readonly ledger: PostgresLedger,
    private readonly accounts: AccountService,
    private readonly flags: FeatureFlags,
  ) {}

  /** GET /fee-items: what the member owes and has paid; due first, soonest and smallest first. */
  async listForMember(memberPartyId: string): Promise<{ items: FeeItemView[] }> {
    const r = await this.db.query<FeeRow>(
      `select f.id, f.institution_id, i.name as institution_name, f.member_party_id, f.description, f.amount_minor::text, f.currency, f.status, f.due_at
         from org.fee_item f join org.institution i on i.id = f.institution_id
        where f.member_party_id = $1 order by (f.status = 'due') desc, f.due_at, f.amount_minor, f.id limit 200`,
      [memberPartyId],
    );
    const items: FeeItemView[] = [];
    for (const row of r.rows) items.push(await this.view(row));
    return { items };
  }

  /** POST /fee-items/{id}/pay: the member's purse pays the institution; paid is final and idempotent. */
  async pay(memberPartyId: string, feeItemId: string, now: Date): Promise<Receipt> {
    if (!(await this.flags.isOn(COLLECTIONS_FLAG))) throw new DomainError('FEATURE_OFF', 'Institution payments are not enabled yet');
    const row = await this.fee(feeItemId);
    if (!row || row.member_party_id !== memberPartyId) throw new DomainError('NOT_FOUND', 'Fee item not found');
    if (row.status === 'paid') return (await this.receiptFor(row))!;
    if (row.status === 'waived') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This fee was waived');
    const amount = money(BigInt(row.amount_minor), row.currency);
    const purse = (await this.accounts.purses(memberPartyId)).find((p) => p.currency === amount.currency)!;
    if (purse.available.minor < amount.minor) throw new DomainError('INSUFFICIENT_FUNDS', 'Not enough in the purse for this fee', { available: purse.available.minor.toString(), currency: amount.currency });
    const wallet = await this.accounts.memberAccount(memberPartyId, 'wallet', amount.currency);
    const master = await this.accounts.systemAccount('institution_master', amount.currency);
    const journal = await this.ledger.post({
      idempotencyKey: feeKey(row.id),
      kind: FEE_JOURNAL_KIND,
      effectiveAt: now,
      postings: [
        { accountId: wallet, currency: amount.currency, amountMinor: amount.minor },
        { accountId: master, currency: amount.currency, amountMinor: -amount.minor },
      ],
      metadata: { institutionId: row.institution_id, memberPartyId, feeItemId: row.id, description: row.description },
    });
    await this.db.query(`update org.fee_item set status = 'paid' where id = $1 and status = 'due'`, [row.id]);
    return this.toReceipt(row, journal.id, new Date(journal.effectiveAt));
  }

  /** GET /institutions/{id}/collections: a month's paid fee items with the receipt each produced. */
  async listForInstitution(institutionId: string, month: string): Promise<{ month: string; items: (Receipt & { memberName: string })[]; total: ReturnType<typeof toWire>[] }> {
    const r = await this.db.query<FeeRow & { journal_id: string; effective_at: string | Date; member_name: string | null }>(
      `select f.id, f.institution_id, i.name as institution_name, f.member_party_id, f.description, f.amount_minor::text, f.currency, f.status, f.due_at, j.id as journal_id, j.effective_at,
              (select m.member_name from org.member m where m.institution_id = f.institution_id and m.member_party_id = f.member_party_id order by m.updated_at desc limit 1) as member_name
         from org.fee_item f join org.institution i on i.id = f.institution_id
         join ledger.journal j on j.idempotency_key = 'fee:' || f.id::text
        where f.institution_id = $1 and f.status = 'paid' and to_char(j.effective_at at time zone 'UTC', 'YYYY-MM') = $2
        order by j.effective_at, j.id`,
      [institutionId, month],
    );
    const items = r.rows.map((x) => ({ ...this.toReceipt(x, x.journal_id, new Date(x.effective_at)), memberName: x.member_name ?? '' }));
    const totals = new Map<Currency, bigint>();
    for (const x of r.rows) totals.set(x.currency, (totals.get(x.currency) ?? 0n) + BigInt(x.amount_minor));
    return { month, items, total: [...totals.entries()].map(([currency, minor]) => toWire(money(minor, currency))) };
  }

  private async fee(id: string): Promise<FeeRow | undefined> {
    const r = await this.db.query<FeeRow>(`select f.id, f.institution_id, i.name as institution_name, f.member_party_id, f.description, f.amount_minor::text, f.currency, f.status, f.due_at from org.fee_item f join org.institution i on i.id = f.institution_id where f.id = $1`, [id]);
    return r.rows[0];
  }

  private async receiptFor(row: FeeRow): Promise<Receipt | undefined> {
    const j = await this.db.query<{ id: string; effective_at: string | Date }>('select id, effective_at from ledger.journal where idempotency_key = $1', [feeKey(row.id)]);
    return j.rows[0] ? this.toReceipt(row, j.rows[0].id, new Date(j.rows[0].effective_at)) : undefined;
  }

  private toReceipt(row: FeeRow, journalId: string, effectiveAt: Date): Receipt {
    return { receiptNumber: receiptNumber(journalId, effectiveAt), feeItemId: row.id, institutionId: row.institution_id, institutionName: row.institution_name, memberPartyId: row.member_party_id, description: row.description, amount: toWire(money(BigInt(row.amount_minor), row.currency)), paidAt: effectiveAt.toISOString(), journalId };
  }

  private async view(row: FeeRow): Promise<FeeItemView> {
    const receipt = row.status === 'paid' ? await this.receiptFor(row) : undefined;
    return { id: row.id, institutionId: row.institution_id, institutionName: row.institution_name, description: row.description, amount: toWire(money(BigInt(row.amount_minor), row.currency)), status: row.status, dueAt: new Date(row.due_at).toISOString().slice(0, 10), ...(receipt ? { receipt } : {}) };
  }
}

export type { Money };

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
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new DomainError('VALIDATION_FAILED', 'month must be YYYY-MM');
      return ok(await collections.listForInstitution(institutionId, month));
    }),
  };
}
