// Institution deposits (T-0614, REQ-INS-007): an institution pays into Kesher's bank account by Masav, wire
// or ACH, quoting its payment reference. Kesher finance reads the statement and records each transfer
// against the institution; a second, different finance member approves it; only then does it post, as a
// `deposit` transfer settled by its journal: Dr partner_settlement, Cr the institution's own account
// (T-0613). One statement line is one deposit: the rail and the bank reference are unique among deposits
// not rejected, so the same line cannot post twice, whoever records it and for whichever institution.
//
// The bank feed (T-0618): when Kesher's bank reports an incoming credit (BankPort), a credit quoting exactly one
// payment reference that names an institution is recorded here by the feed and posted through the same `post()`,
// so it is the same transfer and journal keys, and the same uniqueness: a statement line already recorded by hand
// never posts twice. A bank-verified credit needs no second person; the two-person rule is for lines people type.
// Anything else (no reference, an unknown or second one, the wrong currency for the rail, an amount that
// differs from a line recorded by hand, KYB not allowing deposits) opens a `suspense` case for ops and posts
// nothing: money is never guessed onto an institution, and ops record it through the two-person path once known.
//
// From the case (T-0631, REQ-INS-015): finance record a suspense credit against the institution ops identified by
// naming its `caseId`. The rail, bank reference, amount and value date come from the case, so nothing is retyped
// (a field given anyway must agree); the credit id is linked through `ops.external_ref`, so the daily statement finds
// the line recorded; and when the second approver posts it, the case resolves naming the deposit.
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
import { SYSTEM_OWNER } from '../ledger/accounts.ts';
import type { WebhookVerifier } from '../webhooks/verify.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import type { KybGate } from './kyb-gate.ts';
import { BankError, type BankPort, type IncomingCredit } from '@kesher/ports';

export const DEPOSITS_FLAG = 'institutions.deposits';
export const BANK_FEED_FLAG = 'institutions.bankFeed';
/** The webhook route's provider, /hooks/bank. */
export const BANK_PROVIDER = 'bank';
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

/** Every payment reference a remitter's text quotes, normalised and without repeats; a reference is never guessed from a near miss. */
export function referencesIn(text: string): string[] {
  const found = text.toUpperCase().match(/KC-[0-9A-HJKMNP-TV-Z]{8}(?![0-9A-Z])/g) ?? [];
  return [...new Set(found)];
}

export type SuspenseReason = 'no_reference' | 'ambiguous_reference' | 'unknown_reference' | 'rail_currency' | 'amount_differs' | 'kyb_blocked';
export type CreditOutcome = { kind: 'off' } | { kind: 'posted'; depositId: string } | { kind: 'already_recorded'; depositId: string } | { kind: 'suspense'; reason: SuspenseReason };

/** The bank's notification, verified through its port; a forged one is stored for forensics and never processed. */
export function bankCreditVerifier(port: BankPort): WebhookVerifier {
  return {
    verify: async (headers, rawBody) => {
      try {
        const { eventId, credit } = await port.parseWebhook(headers, rawBody);
        return { ok: true, eventId, payload: { eventId, credit: { ...credit, amount: toWire(credit.amount) } } };
      } catch (e) {
        if (!(e instanceof BankError)) throw e;
        const eventId = /"eventId"\s*:\s*"([^"]{1,200})"/.exec(rawBody)?.[1] ?? '';
        // A forged notification is refused; a signed one the port cannot read is kept and carries no credit
        // (the daily statement still finds the credit itself).
        return { ok: e.code !== 'BAD_SIGNATURE', eventId, payload: { error: e.code }, reason: e.code };
      }
    },
  };
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
    const fromCase = await this.suspenseCase(body);
    const input = this.parse(fromCase ? { ...fromCase.fields, ...(body as object) } : body, now);
    if (fromCase && (input.rail !== fromCase.fields.rail || input.bankReference !== fromCase.fields.bankReference || input.amount.minor !== BigInt(fromCase.fields.amount.minor) || input.amount.currency !== fromCase.fields.amount.currency || input.valueDate !== fromCase.fields.valueDate)) {
      throw new DomainError('VALIDATION_FAILED', 'The deposit must be the credit the case holds: leave out the rail, bank reference, amount and value date');
    }
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
    if (fromCase) {
      await this.d.db.query(`update ops.case set payload = payload || jsonb_build_object('depositId', $2::text), status = 'investigating' where id = $1 and status in ('open', 'investigating')`, [fromCase.id, id]);
      // A recording rejected earlier left the credit linked to its deposit: the link follows the credit to this one.
      await this.d.db.query(
        `insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('institution_deposit', $1, $2, $3) on conflict (provider, external_id) do update set entity_id = excluded.entity_id where ops.external_ref.entity_type = 'institution_deposit'`,
        [id, fromCase.provider, fromCase.creditId],
      );
    }
    let approval = await this.d.approvals.request({ kind: 'institution_deposit', subject: `deposit:${id}`, scope: institutionId, requestedBy: actor, amount: input.amount, payload: { institutionId, rail: input.rail, bankReference: input.bankReference, valueDate: input.valueDate } }, now);
    if (approval.approvals === 0) approval = await this.d.approvals.decide(approval.id, actor, 'approve', now, 'recorded');
    await this.d.db.query('update ops.institution_deposit set approval_id = $2 where id = $1', [id, approval.id]);
    await this.d.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.deposit.record', subject: institutionId, reason: `Deposit ${input.rail} ${input.bankReference}`, payload: { depositId: id, amount: toWire(input.amount), rail: input.rail, bankReference: input.bankReference, valueDate: input.valueDate, ...(fromCase ? { caseId: fromCase.id } : {}) } }, now);
    return this.view((await this.row(id))!, actor.partyId);
  }

  /** The open suspense case a `caseId` names, with the credit it holds as a deposit body; none without a `caseId`. */
  private async suspenseCase(body: unknown): Promise<{ id: string; provider: string; creditId: string; fields: { rail: Rail; bankReference: string; amount: { minor: string; currency: Currency }; valueDate: string } } | undefined> {
    const caseId = (body as { caseId?: unknown } | null | undefined)?.caseId;
    if (caseId === undefined) return undefined;
    type Payload = { provider: string; creditId: string; rail: Rail; bankReference: string; amount: { minor: string; currency: Currency }; valueDate: string };
    const c = typeof caseId === 'string' && UUID.test(caseId) ? (await this.d.db.query<{ kind: string; status: string; payload: Payload }>('select kind, status, payload from ops.case where id = $1', [caseId])).rows[0] : undefined;
    if (!c || c.kind !== 'suspense' || (c.status !== 'open' && c.status !== 'investigating')) throw new DomainError('VALIDATION_FAILED', 'caseId must name an open suspense case');
    const p = c.payload;
    return { id: caseId as string, provider: p.provider, creditId: p.creditId, fields: { rail: p.rail, bankReference: normalizeReference(p.bankReference).slice(0, 64), amount: p.amount, valueDate: p.valueDate } };
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
    // A suspense case recorded through this deposit is open again for the corrected record.
    await this.d.db.query(`update ops.case set payload = payload - 'depositId' where kind = 'suspense' and payload->>'depositId' = $1 and status in ('open', 'investigating')`, [id]);
    await this.d.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.deposit.reject', subject: r.institution_id, reason: why, payload: { depositId: id, bankReference: r.bank_reference } }, now);
    return this.view((await this.row(id))!, actor.partyId);
  }

  /** Whether the bank feed runs: deposits on, and the feed itself (`institutions.bankFeed`). */
  async bankFeedOn(): Promise<boolean> {
    return (await this.d.flags.isOn(DEPOSITS_FLAG)) && (await this.d.flags.isOn(BANK_FEED_FLAG));
  }

  /** The stored notification (`/hooks/bank`), processed: the credit it carries, applied. */
  async applyBankEvent(event: InboundEvent, now: Date): Promise<CreditOutcome | undefined> {
    const p = event.payload as { credit?: Omit<IncomingCredit, 'amount'> & { amount: { minor: string; currency: string } } } | undefined;
    if (!p?.credit) return undefined;
    return this.applyBankCredit({ ...p.credit, amount: fromWire(p.credit.amount) }, event.provider, now);
  }

  /**
   * One incoming credit, applied once however often it is told: from the notification, a bank's retry, or the
   * daily statement after a notification was lost. Posts it to the institution its one payment reference names,
   * finds the line already recorded, or opens a suspense case.
   */
  async applyBankCredit(credit: IncomingCredit, provider: string, now: Date): Promise<CreditOutcome> {
    if (!(await this.bankFeedOn())) return { kind: 'off' };
    const key = `bank-credit:${provider}:${credit.creditId}`;
    const bankReference = normalizeReference(credit.bankReference).slice(0, 64);
    const mine = await this.byKey(key);
    // A line recorded by hand, or by an earlier notification for another credit id: the same line never posts twice.
    const line = mine ?? (await this.d.db.query<Row>(`select ${COLUMNS} from ops.institution_deposit where rail = $1 and bank_reference = $2 and status <> 'rejected'`, [credit.rail, bankReference])).rows[0];
    if (line && !mine) {
      if (BigInt(line.amount_minor) !== credit.amount.minor || line.currency !== credit.amount.currency) return this.suspense(credit, provider, 'amount_differs', now, line.institution_id);
      return { kind: 'already_recorded', depositId: line.id };
    }
    if (mine?.status === 'posted') return { kind: 'already_recorded', depositId: mine.id };
    if (!RAIL_CURRENCIES[credit.rail].includes(credit.amount.currency)) return this.suspense(credit, provider, 'rail_currency', now);
    const refs = referencesIn(credit.remitterReference);
    if (refs.length !== 1) return this.suspense(credit, provider, refs.length ? 'ambiguous_reference' : 'no_reference', now);
    const institutionId = await this.institutionByReference(refs[0]!);
    if (!institutionId) return this.suspense(credit, provider, 'unknown_reference', now);
    try {
      await this.d.kyb.require(institutionId, 'deposits');
    } catch (e) {
      if (e instanceof DomainError) return this.suspense(credit, provider, 'kyb_blocked', now, institutionId);
      throw e;
    }
    let row = mine;
    if (!row) {
      const id = uuidv7(now);
      try {
        await this.d.db.query(
          `insert into ops.institution_deposit (id, idempotency_key, institution_id, rail, bank_reference, amount_minor, currency, value_date, note, status, recorded_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)`,
          [id, key, institutionId, credit.rail, bankReference, credit.amount.minor.toString(), credit.amount.currency, credit.valueDate, 'Bank feed', SYSTEM_OWNER, now],
        );
      } catch (e) {
        // Someone recorded the same line a moment ago: theirs stands.
        if (isPgError(e, PG.UNIQUE_VIOLATION)) return this.applyBankCredit(credit, provider, now);
        throw e;
      }
      await this.d.db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('institution_deposit', $1, $2, $3) on conflict do nothing`, [id, provider, credit.creditId]);
      row = (await this.row(id))!;
    }
    await this.post(row, { partyId: SYSTEM_OWNER, role: 'bank_feed' }, now);
    return { kind: 'posted', depositId: row.id };
  }

  /**
   * The daily reconciliation's other half: a deposit recorded for this value date that the bank's statement does
   * not show is either a typo or money that never came. Opens one case each; returns how many it found.
   */
  async notOnStatement(valueDate: string, statement: readonly IncomingCredit[], now: Date): Promise<number> {
    const seen = new Set(statement.map((c) => `${c.rail}:${normalizeReference(c.bankReference).slice(0, 64)}`));
    const rows = await this.d.db.query<Row>(`select ${COLUMNS} from ops.institution_deposit where value_date = $1 and status <> 'rejected'`, [valueDate]);
    let n = 0;
    for (const r of rows.rows) {
      if (seen.has(`${r.rail}:${r.bank_reference}`)) continue;
      n += 1;
      await this.d.db.query(
        `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'deposit_not_on_statement', $2, 'high', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
        [uuidv7(now), `deposit-not-on-statement:${r.id}`, { depositId: r.id, institutionId: r.institution_id, rail: r.rail, bankReference: r.bank_reference, amount: toWire(money(BigInt(r.amount_minor), r.currency)), valueDate, status: r.status }, now],
      );
    }
    return n;
  }

  /** The institution whose payment reference this is. The reference is a hash of the id, so it is computed, not stored. */
  private async institutionByReference(reference: string): Promise<string | undefined> {
    const all = await this.d.db.query<{ id: string }>('select id from org.institution');
    return all.rows.find((r) => paymentReference(r.id) === reference)?.id;
  }

  /** Money that came in for no one we can name: a case for ops, never a journal. One case per credit. */
  private async suspense(credit: IncomingCredit, provider: string, reason: SuspenseReason, now: Date, institutionId?: string): Promise<CreditOutcome> {
    await this.d.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'suspense', $2, 'high', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
      [
        uuidv7(now),
        `bank-credit:${provider}:${credit.creditId}`,
        // The remitter's text is data for ops to read, never instructions; it is already cut to 140 characters.
        { reason, provider, creditId: credit.creditId, rail: credit.rail, amount: toWire(credit.amount), bankReference: credit.bankReference, valueDate: credit.valueDate, remitterReference: credit.remitterReference, ...(institutionId ? { institutionId } : {}) },
        now,
      ],
    );
    return { kind: 'suspense', reason };
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
    // The suspense case it was recorded from (T-0631) closes, naming the deposit; keyed by status, so a repeat closes nothing.
    const resolution = `Recorded as deposit ${r.id}`;
    const closed = await this.d.db.query<{ id: string }>(
      `update ops.case set status = 'resolved', decided_by = $2, decided_at = $3, decision_note = $4, resolved_at = $3, resolved_by = $5::uuid, resolution = $4
        where kind = 'suspense' and payload->>'depositId' = $1 and status in ('open', 'investigating') returning id`,
      [r.id, approver.partyId, now, resolution, approver.partyId],
    );
    for (const c of closed.rows) {
      await this.d.audit.record({ actorId: approver.partyId, actorRole: approver.role, action: 'case.resolved', subject: c.id, reason: resolution, after: { status: 'resolved' }, payload: { kind: 'suspense', depositId: r.id } }, now);
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
