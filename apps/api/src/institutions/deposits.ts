// Institution deposits (T-0614, REQ-INS-007): an institution pays into Kesher's bank account by Masav, wire
// or ACH, quoting its payment reference. Kesher finance reads the statement and records each transfer
// against the institution; a second, different finance member approves it; only then does it post, as a
// `deposit` transfer settled by its journal: Dr partner_settlement, Cr the institution's own account
// (T-0613). One statement line is one deposit: the rail and the bank reference are unique among deposits
// not rejected, so the same line cannot post twice, whoever records it and for whichever institution.
import { createHash } from 'node:crypto';
import { DomainError, fromWire, money, toWire, uuidv7, type Currency, type Money } from '@kesher/domain';
import type { Approver, ApprovalService } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import { requireStaff, staffActor } from '../admin/staff-token.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { isPgError, PG, type Database } from '../db.ts';
import { created, ok, requireIdempotencyKey, route, type Handler } from '../http.ts';
import type { AccountService } from '../ledger/accounts.ts';
import type { PostgresLedger } from '../ledger/post.ts';
import type { TransferService } from '../transfers/service.ts';
import type { KybGate } from './kyb-gate.ts';

export const DEPOSITS_FLAG = 'institutions.deposits';
export const DEPOSIT_JOURNAL_KIND = 'deposit';
export const RAILS = ['masav', 'wire', 'ach'] as const;
export type Rail = (typeof RAILS)[number];
type Status = 'pending' | 'posted' | 'rejected';

/** Masav moves shekels and ACH dollars; a wire carries either. */
const RAIL_CURRENCIES: Record<Rail, readonly Currency[]> = { masav: ['ILS'], wire: ['ILS', 'USD'], ach: ['USD'] };
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "KC-7M4QX2HD": what an institution quotes on its transfer so finance can tell whose money arrived. Derived
 * from a hash of the whole id (a UUIDv7's leading digits are its timestamp, shared by ids minted together),
 * in Crockford base 32: no I, L, O or U to misread on a statement.
 */
export function paymentReference(institutionId: string): string {
  const h = createHash('sha256').update(`kesher-institution:${institutionId.toLowerCase()}`).digest();
  let out = '';
  for (let i = 0; i < 8; i++) out += CROCKFORD[h[i]! % 32];
  return `KC-${out}`;
}

/** A statement's reference as one string: upper case, no spaces, so "ft 2611-abc" and "FT2611-ABC" are the same line. */
export const normalizeReference = (r: string): string => r.replace(/\s+/g, '').toUpperCase();

export interface InstitutionDeposit {
  id: string;
  institutionId: string;
  amount: ReturnType<typeof toWire>;
  rail: Rail;
  bankReference: string;
  valueDate: string;
  note?: string;
  status: Status;
  /** Approvals so far: 1 once recorded, 2 when posted. */
  approvals: number;
  recordedByMe: boolean;
  createdAt: string;
  decidedAt?: string;
  journalId?: string;
}

interface Row {
  id: string;
  idempotency_key: string;
  institution_id: string;
  rail: Rail;
  bank_reference: string;
  amount_minor: string;
  currency: Currency;
  value_date: string;
  note: string | null;
  status: Status;
  approval_id: string | null;
  journal_id: string | null;
  recorded_by: string;
  created_at: string | Date;
  decided_at: string | Date | null;
}

const COLUMNS = 'id, idempotency_key, institution_id, rail, bank_reference, amount_minor::text, currency, value_date::text as value_date, note, status, approval_id, journal_id, recorded_by, created_at, decided_at';
const iso = (v: string | Date): string => new Date(v).toISOString();
/** The `date` column, read as text (YYYY-MM-DD) so no driver turns it into a local midnight. */
const day = (v: string): string => v.slice(0, 10);

export interface DepositDeps {
  db: Database;
  ledger: PostgresLedger;
  accounts: AccountService;
  transfers: TransferService;
  approvals: ApprovalService;
  audit: AuditService;
  flags: FeatureFlags;
  /** A deposit posts only while the institution's KYB decision opens deposits (T-0621). */
  kyb: Pick<KybGate, 'require'>;
}

export class InstitutionDeposits {
  private readonly d: DepositDeps;
  constructor(d: DepositDeps) {
    this.d = d;
  }

  /** Records a statement line against the institution; the recorder's own approval is the first of two. */
  async record(institutionId: string, body: unknown, key: string, actor: Approver, now: Date): Promise<InstitutionDeposit> {
    await this.requireOn();
    await this.requireInstitution(institutionId);
    const input = this.parse(body, now);
    const replay = await this.byKey(key);
    if (replay) {
      if (replay.institution_id !== institutionId || replay.rail !== input.rail || replay.bank_reference !== input.bankReference || BigInt(replay.amount_minor) !== input.amount.minor || replay.currency !== input.amount.currency) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key recorded a different deposit');
      return this.view(replay, actor.partyId);
    }
    const id = uuidv7(now);
    try {
      await this.d.db.query(
        `insert into ops.institution_deposit (id, idempotency_key, institution_id, rail, bank_reference, amount_minor, currency, value_date, note, status, recorded_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)`,
        [id, key, institutionId, input.rail, input.bankReference, input.amount.minor.toString(), input.amount.currency, input.valueDate, input.note ?? null, actor.partyId, now],
      );
    } catch (e) {
      if (!isPgError(e, PG.UNIQUE_VIOLATION)) throw e;
      const raced = await this.byKey(key);
      if (raced) return this.view(raced, actor.partyId);
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'This bank reference is already recorded on this rail', { rail: input.rail, bankReference: input.bankReference });
    }
    let approval = await this.d.approvals.request({ kind: 'institution_deposit', subject: `deposit:${id}`, scope: institutionId, requestedBy: actor, amount: input.amount, payload: { institutionId, rail: input.rail, bankReference: input.bankReference, valueDate: input.valueDate } }, now);
    if (approval.approvals === 0) approval = await this.d.approvals.decide(approval.id, actor, 'approve', now, 'recorded');
    await this.d.db.query('update ops.institution_deposit set approval_id = $2 where id = $1', [id, approval.id]);
    await this.d.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.deposit.record', subject: institutionId, reason: `Deposit ${input.rail} ${input.bankReference}`, payload: { depositId: id, amount: toWire(input.amount), rail: input.rail, bankReference: input.bankReference, valueDate: input.valueDate } }, now);
    return this.view((await this.row(id))!, actor.partyId);
  }

  /** The second finance member's approval; the deposit then posts. The recorder's own approval answers 409; a posted one is a no-op. */
  async approve(id: string, actor: Approver, now: Date): Promise<InstitutionDeposit> {
    await this.requireOn();
    const r = await this.requireRow(id);
    if (r.status === 'rejected') throw new DomainError('IDEMPOTENCY_CONFLICT', 'This deposit was rejected');
    // Posted already: approving again is a no-op that answers the deposit as it stands.
    if (r.status === 'posted') return this.view(r, actor.partyId);
    // Before anything is decided: a blocked deposit stays pending with nothing written.
    await this.d.kyb.require(r.institution_id, 'deposits');
    const approval = r.approval_id ? await this.d.approvals.get(r.approval_id) : undefined;
    if (!approval) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This deposit is still being recorded');
    // Approved already but not posted (a crash between the two): finish the post, which is keyed and safe to repeat.
    const after = approval.status === 'approved' ? approval : await this.d.approvals.decide(approval.id, actor, 'approve', now);
    if (after.status !== 'approved') return this.view(r, actor.partyId);
    await this.post(r, actor, now);
    return this.view((await this.row(id))!, actor.partyId);
  }

  async reject(id: string, actor: Approver, reason: unknown, now: Date): Promise<InstitutionDeposit> {
    await this.requireOn();
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (!why || why.length > 500) throw new DomainError('VALIDATION_FAILED', 'A reason of 1 to 500 characters is required');
    const r = await this.requireRow(id);
    if (r.status !== 'pending' || !r.approval_id) throw new DomainError('IDEMPOTENCY_CONFLICT', `This deposit is already ${r.status}`);
    await this.d.approvals.decide(r.approval_id, actor, 'reject', now, why);
    await this.d.db.query(`update ops.institution_deposit set status = 'rejected', decided_at = $2 where id = $1 and status = 'pending'`, [id, now]);
    await this.d.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.deposit.reject', subject: r.institution_id, reason: why, payload: { depositId: id, bankReference: r.bank_reference } }, now);
    return this.view((await this.row(id))!, actor.partyId);
  }

  /** The institution's deposits, newest first, with its payment reference and what its account holds. */
  async list(institutionId: string, viewer: string): Promise<{ paymentReference: string; balances: ReturnType<typeof toWire>[]; items: InstitutionDeposit[] }> {
    await this.requireOn();
    await this.requireInstitution(institutionId);
    const rows = await this.d.db.query<Row>(`select ${COLUMNS} from ops.institution_deposit where institution_id = $1 order by created_at desc, id desc limit 200`, [institutionId]);
    const balances = await Promise.all((['ILS', 'USD'] as const).map(async (c) => toWire(await this.d.accounts.institutionBalance(institutionId, c))));
    return { paymentReference: paymentReference(institutionId), balances, items: await Promise.all(rows.rows.map((r) => this.view(r, viewer))) };
  }

  /** The transfer and its journal, both keyed by the deposit, so a repeat finds them; then the row. */
  private async post(r: Row, approver: Approver, now: Date): Promise<void> {
    const amount = money(BigInt(r.amount_minor), r.currency);
    let t = await this.d.transfers.create({ idempotencyKey: `deposit:${r.id}`, kind: 'deposit', toPartyId: r.institution_id, amount, note: r.bank_reference }, now);
    if (t.state === 'created') t = await this.d.transfers.apply(t.id, 'submit', now, { reason: 'deposit approved' });
    const journal = await this.d.ledger.post({
      idempotencyKey: `deposit:${r.id}:settle`,
      kind: DEPOSIT_JOURNAL_KIND,
      transferId: t.id,
      effectiveAt: now,
      postings: [
        { accountId: await this.d.accounts.systemAccount('partner_settlement', r.currency), currency: r.currency, amountMinor: amount.minor },
        { accountId: await this.d.accounts.institutionAccount(r.institution_id, r.currency), currency: r.currency, amountMinor: -amount.minor },
      ],
      metadata: { institutionId: r.institution_id, depositId: r.id, rail: r.rail, bankReference: r.bank_reference, valueDate: day(r.value_date) },
    });
    if (t.state !== 'settled') await this.d.transfers.apply(t.id, 'settle', now, { journalId: journal.id });
    const updated = await this.d.db.query(`update ops.institution_deposit set status = 'posted', journal_id = $2, decided_at = $3 where id = $1 and status = 'pending'`, [r.id, journal.id, now]);
    if (updated.rowCount > 0) {
      await this.d.audit.record({ actorId: approver.partyId, actorRole: approver.role, action: 'institution.deposit.post', subject: r.institution_id, reason: `Deposit ${r.rail} ${r.bank_reference} approved`, after: { amount: toWire(amount), journalId: journal.id }, payload: { depositId: r.id, recordedBy: r.recorded_by, approvedBy: approver.partyId } }, now);
    }
  }

  private parse(body: unknown, now: Date): { rail: Rail; amount: Money; bankReference: string; valueDate: string; note?: string } {
    const b = (body ?? {}) as { amount?: unknown; rail?: unknown; bankReference?: unknown; valueDate?: unknown; note?: unknown };
    if (typeof b.rail !== 'string' || !(RAILS as readonly string[]).includes(b.rail)) throw new DomainError('VALIDATION_FAILED', 'rail must be masav, wire or ach');
    const rail = b.rail as Rail;
    let amount: Money;
    try {
      amount = fromWire(b.amount as { minor: string; currency: string });
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency }');
    }
    if (amount.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'amount must be positive');
    if (!RAIL_CURRENCIES[rail].includes(amount.currency)) throw new DomainError('VALIDATION_FAILED', `${rail} carries ${RAIL_CURRENCIES[rail].join(' or ')}`);
    const bankReference = typeof b.bankReference === 'string' ? normalizeReference(b.bankReference) : '';
    if (!bankReference || bankReference.length > 64) throw new DomainError('VALIDATION_FAILED', 'bankReference must be 1 to 64 characters');
    const valueDate = typeof b.valueDate === 'string' ? b.valueDate : '';
    // A real calendar day, not in the future: money that has not arrived is not a deposit.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valueDate) || new Date(`${valueDate}T00:00:00Z`).toISOString().slice(0, 10) !== valueDate) throw new DomainError('VALIDATION_FAILED', 'valueDate must be a calendar date, YYYY-MM-DD');
    if (valueDate > now.toISOString().slice(0, 10)) throw new DomainError('VALIDATION_FAILED', 'valueDate cannot be in the future');
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : undefined;
    if (note && note.length > 500) throw new DomainError('VALIDATION_FAILED', 'note is up to 500 characters');
    return { rail, amount, bankReference, valueDate, ...(note ? { note } : {}) };
  }

  private async view(r: Row, viewer: string): Promise<InstitutionDeposit> {
    const approval = r.approval_id ? await this.d.approvals.get(r.approval_id) : undefined;
    return {
      id: r.id,
      institutionId: r.institution_id,
      amount: toWire(money(BigInt(r.amount_minor), r.currency)),
      rail: r.rail,
      bankReference: r.bank_reference,
      valueDate: day(r.value_date),
      ...(r.note ? { note: r.note } : {}),
      status: r.status,
      approvals: approval?.approvals ?? 0,
      recordedByMe: r.recorded_by === viewer,
      createdAt: iso(r.created_at),
      ...(r.decided_at ? { decidedAt: iso(r.decided_at) } : {}),
      ...(r.journal_id ? { journalId: r.journal_id } : {}),
    };
  }

  private async requireOn(): Promise<void> {
    if (!(await this.d.flags.isOn(DEPOSITS_FLAG))) throw new DomainError('FEATURE_OFF', 'Institution deposits are not enabled yet');
  }

  private async requireInstitution(id: string): Promise<void> {
    const r = UUID.test(id) ? await this.d.db.query('select 1 from org.institution where id = $1', [id]) : { rowCount: 0 };
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Institution not found');
  }

  private async requireRow(id: string): Promise<Row> {
    const r = UUID.test(id) ? await this.row(id) : undefined;
    if (!r) throw new DomainError('NOT_FOUND', 'Deposit not found');
    return r;
  }

  private async row(id: string): Promise<Row | undefined> {
    return (await this.d.db.query<Row>(`select ${COLUMNS} from ops.institution_deposit where id = $1`, [id])).rows[0];
  }

  private async byKey(key: string): Promise<Row | undefined> {
    return (await this.d.db.query<Row>(`select ${COLUMNS} from ops.institution_deposit where idempotency_key = $1`, [key])).rows[0];
  }
}

/** Kesher finance only: the staff token's `finance` role, acting as a finance approver. */
const financeActor = (req: Parameters<typeof requireStaff>[0]): Approver => ({ ...staffActor(requireStaff(req, 'finance')), role: 'finance' });

/** /admin/institutions/{id}/deposits and /admin/deposits/{id}/approve|reject (T-0614). */
export function depositHandlers(deposits: InstitutionDeposits): Record<string, Handler> {
  return {
    listAdminInstitutionDeposits: route(async (req) => {
      const p = requireStaff(req);
      return ok(await deposits.list(req.params['id'] ?? '', p.partyId));
    }),
    recordAdminInstitutionDeposit: route(async (req) => {
      const by = financeActor(req);
      return created(await deposits.record(req.params['id'] ?? '', req.body, requireIdempotencyKey(req), by, req.now));
    }),
    approveAdminDeposit: route(async (req) => ok(await deposits.approve(req.params['id'] ?? '', financeActor(req), req.now))),
    rejectAdminDeposit: route(async (req) => ok(await deposits.reject(req.params['id'] ?? '', financeActor(req), (req.body as { reason?: unknown } | undefined)?.reason, req.now))),
  };
}
