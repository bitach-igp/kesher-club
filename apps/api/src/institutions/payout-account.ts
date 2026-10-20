// Institution payout accounts (T-0623, REQ-INS-012, ADR-017): an institution pays out only to its own bank
// account, verified as held in its registered name. Suppliers are paid by the institution from there (decision
// 2026-10-20, until the bank answers question 9 of docs/bank-review/institution-kyb.md).
// - Compliance records the account with the holder name the bank's ownership letter states and a reference to
//   that letter. It is refused unless that name matches the registered name the identifier check recorded
//   (T-0622).
// - The account takes effect only when a different compliance member approves it: changing where an
//   institution's money goes is the classic fraud, so it is never one person's call.
// - A replacement waits the same way, and payouts stop until it is approved.
// - A payout to any other account is refused and opens a compliance case.
import { createHash } from 'node:crypto';
import { DomainError, uuidv7, type Currency } from '@kesher/domain';
import type { Approver } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import { isPgError, PG, type Database } from '../db.ts';
import { requireStaff, staffActor } from '../admin/staff-token.ts';
import { created, ok, requireIdempotencyKey, route, type Handler, type HttpRequest } from '../http.ts';
import { checkPayee, maskIban } from '../payouts/iban.ts';

export interface PayoutAccount {
  id: string;
  currency: Currency;
  ibanMasked: string;
  holderName: string;
  evidenceRef: string;
  /** `active`: the latest and approved; `pending`: the latest, waiting for a second compliance member; `superseded`: replaced. */
  status: 'active' | 'pending' | 'superseded';
  recordedBy: string;
  recordedAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

interface Row {
  id: string;
  institution_id: string;
  currency: Currency;
  iban: string;
  holder_name: string;
  evidence_ref: string;
  recorded_by: string;
  recorded_at: string | Date;
  approved_by: string | null;
  approved_at: string | Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date): string => new Date(v).toISOString();
/** Trailing legal forms a register or a bank letter may add or leave off. */
const LEGAL_FORMS = /\s*(?:\(?ע"?ר\)?|\(?חל"?צ\)?|בע"?מ|ltd|limited|inc|incorporated|corp|corporation|llc)\s*$/iu;

/** "Yeshivat Example (ע"ר)" and "YESHIVAT EXAMPLE" are the same holder; punctuation, case and legal forms aside. */
export function sameHolder(a: string, b: string): boolean {
  const norm = (s: string) => {
    let t = s.normalize('NFKC').toLowerCase().replace(/[׳״'"`]/g, '"').replace(/[.,]+/g, ' ').trim();
    for (let i = 0; i < 2; i++) t = t.replace(LEGAL_FORMS, '');
    return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  };
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

export class PayoutAccounts {
  private readonly db: Database;
  private readonly audit: AuditService;
  constructor(db: Database, audit: AuditService) {
    this.db = db;
    this.audit = audit;
  }

  async list(institutionId: string): Promise<PayoutAccount[]> {
    await this.requireInstitution(institutionId);
    const rows = await this.rows(institutionId);
    const latest = new Map<Currency, string>();
    for (const r of rows) if (!latest.has(r.currency)) latest.set(r.currency, r.id);
    return rows.map((r) => view(r, latest.get(r.currency) === r.id));
  }

  /** Compliance records the account; a retry with the same key answers it. It takes effect on a second approval. */
  async record(institutionId: string, input: { iban: unknown; holderName: unknown; evidenceRef: unknown }, key: string, actor: Approver, now: Date): Promise<PayoutAccount> {
    await this.requireInstitution(institutionId);
    const check = checkPayee({ iban: input.iban, name: input.holderName });
    if (!check.ok) throw new DomainError('VALIDATION_FAILED', 'The account could not be validated', { problems: check.problems });
    const evidenceRef = typeof input.evidenceRef === 'string' ? input.evidenceRef.trim() : '';
    if (!evidenceRef || evidenceRef.length > 500) throw new DomainError('VALIDATION_FAILED', 'evidenceRef must say where the bank\'s ownership letter is kept');
    const registered = await this.registeredName(institutionId);
    if (!registered) throw new DomainError('VALIDATION_FAILED', 'No registered name yet: run the KYB identifier check first', { reason: 'no_registered_name' });
    if (!sameHolder(check.name, registered)) throw new DomainError('VALIDATION_FAILED', 'The account holder is not the institution\'s registered name', { reason: 'holder_not_registered_name', registeredName: registered });
    const id = uuidv7(now);
    try {
      await this.db.query('insert into org.payout_account (id, institution_id, idempotency_key, currency, iban, holder_name, evidence_ref, recorded_by, recorded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [id, institutionId, key, 'ILS', check.iban, check.name, evidenceRef, actor.partyId, now]);
    } catch (e) {
      if (!isPgError(e, PG.UNIQUE_VIOLATION)) throw e;
      const prior = (await this.db.query<Row>(`${SELECT} where a.idempotency_key = $1`, [key])).rows[0]!;
      if (prior.institution_id !== institutionId || prior.iban !== check.iban) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key recorded a different account');
      return (await this.list(institutionId)).find((a) => a.id === prior.id)!;
    }
    await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.payout_account.record', subject: institutionId, reason: `Payout account ••••${check.last4} for ${check.name}`, payload: { accountId: id, ibanLast4: check.last4, evidenceRef } }, now);
    return (await this.list(institutionId)).find((a) => a.id === id)!;
  }

  /** A different compliance member approves; then the account is where payouts go. */
  async approve(accountId: string, actor: Approver, now: Date): Promise<PayoutAccount> {
    const r = UUID.test(accountId) ? (await this.db.query<Row>(`${SELECT} where a.id = $1`, [accountId])).rows[0] : undefined;
    if (!r) throw new DomainError('NOT_FOUND', 'Payout account not found');
    if (r.approved_by) return (await this.list(r.institution_id)).find((a) => a.id === accountId)!;
    if (r.recorded_by === actor.partyId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The member who recorded the account cannot approve it');
    try {
      await this.db.query('insert into org.payout_account_approval (account_id, approved_by, approved_at) values ($1, $2, $3)', [accountId, actor.partyId, now]);
    } catch (e) {
      if (!isPgError(e, PG.UNIQUE_VIOLATION)) throw e;
    }
    await this.audit.record({ actorId: actor.partyId, actorRole: actor.role, action: 'institution.payout_account.approve', subject: r.institution_id, reason: `Payout account ••••${r.iban.slice(-4)} approved`, payload: { accountId, recordedBy: r.recorded_by, approvedBy: actor.partyId } }, now);
    return (await this.list(r.institution_id)).find((a) => a.id === accountId)!;
  }

  /** The account an institution withdraws to now, in full, for the payout itself; never sent to a client. */
  async active(institutionId: string): Promise<{ iban: string; holderName: string } | undefined> {
    const [latest] = await this.rows(institutionId, 'ILS');
    return latest?.approved_by ? { iban: latest.iban, holderName: latest.holder_name } : undefined;
  }

  /** What the institution's own finance staff see (T-0625): the masked active account, and whether a change waits. */
  async summary(institutionId: string): Promise<{ account?: { ibanMasked: string; holderName: string }; changePending: boolean }> {
    const rows = await this.rows(institutionId, 'ILS');
    const active = rows.find((r) => r.approved_by);
    return { ...(active ? { account: { ibanMasked: maskIban(active.iban), holderName: active.holder_name } } : {}), changePending: !!rows[0] && !rows[0].approved_by };
  }

  /**
   * The payout gate: the IBAN must be the institution's active account. Anything else is refused. A
   * different IBAN also opens a compliance case, keyed by the payout's key so a retry opens one.
   */
  async requirePayee(institutionId: string, iban: string, payoutKey: string, now: Date): Promise<void> {
    const [latest] = await this.rows(institutionId, 'ILS');
    if (!latest) throw new DomainError('VALIDATION_FAILED', 'The institution has no verified payout account yet', { reason: 'no_verified_account' });
    if (!latest.approved_by) throw new DomainError('VALIDATION_FAILED', 'The institution\'s new payout account is waiting for a second compliance approval', { reason: 'account_pending_approval' });
    if (latest.iban === iban) return;
    const hash = createHash('sha256').update(iban).digest('hex').slice(0, 16);
    await this.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'payout_account_mismatch', $2, 'high', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
      [uuidv7(now), `payout-account-mismatch:${payoutKey}`, JSON.stringify({ institutionId, ibanLast4: iban.slice(-4), ibanHash: hash, payoutKey }), now],
    );
    throw new DomainError('VALIDATION_FAILED', 'Institution payouts go only to the institution\'s own verified account', { reason: 'not_own_account' });
  }

  /** The name the latest identifier check found on the register. */
  private async registeredName(institutionId: string): Promise<string | undefined> {
    const r = await this.db.query<{ name: string | null }>(`select detail->>'registeredName' as name from org.kyb_check where institution_id = $1 and kind = 'identifier' and person_id is null order by seq desc limit 1`, [institutionId]);
    return r.rows[0]?.name ?? undefined;
  }

  private async rows(institutionId: string, currency?: Currency): Promise<Row[]> {
    return (await this.db.query<Row>(`${SELECT} where a.institution_id = $1 and ($2::text is null or a.currency::text = $2) order by a.seq desc`, [institutionId, currency ?? null])).rows;
  }

  private async requireInstitution(id: string): Promise<void> {
    const r = UUID.test(id) ? await this.db.query('select 1 from org.institution where id = $1', [id]) : { rowCount: 0 };
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Institution not found');
  }
}

const SELECT = `select a.id, a.institution_id, a.currency, a.iban, a.holder_name, a.evidence_ref, a.recorded_by, a.recorded_at, p.approved_by, p.approved_at
                  from org.payout_account a left join org.payout_account_approval p on p.account_id = a.id`;

const view = (r: Row, latest: boolean): PayoutAccount => ({
  id: r.id,
  currency: r.currency,
  ibanMasked: maskIban(r.iban),
  holderName: r.holder_name,
  evidenceRef: r.evidence_ref,
  status: !latest ? 'superseded' : r.approved_by ? 'active' : 'pending',
  recordedBy: r.recorded_by,
  recordedAt: iso(r.recorded_at),
  ...(r.approved_by ? { approvedBy: r.approved_by, approvedAt: iso(r.approved_at!) } : {}),
});

const compliance = (req: HttpRequest): Approver => ({ ...staffActor(requireStaff(req, 'compliance')), role: 'compliance' });

/** /admin/institutions/{id}/payout-accounts and /admin/payout-accounts/{id}/approve: staff read, compliance writes. */
export function payoutAccountHandlers(accounts: PayoutAccounts): Record<'listAdminPayoutAccounts' | 'recordAdminPayoutAccount' | 'approveAdminPayoutAccount', Handler> {
  return {
    listAdminPayoutAccounts: route(async (req) => {
      requireStaff(req);
      return ok({ items: await accounts.list(req.params['id'] ?? '') });
    }),
    recordAdminPayoutAccount: route(async (req) => {
      const by = compliance(req);
      const b = (req.body ?? {}) as { iban?: unknown; holderName?: unknown; evidenceRef?: unknown };
      return created(await accounts.record(req.params['id'] ?? '', { iban: b.iban, holderName: b.holderName, evidenceRef: b.evidenceRef }, requireIdempotencyKey(req), by, req.now));
    }),
    approveAdminPayoutAccount: route(async (req) => ok(await accounts.approve(req.params['id'] ?? '', compliance(req), req.now))),
  };
}
