// Fund the master account from the linked US account (T-0653, REQ-INS-024), behind institutions.usBanking.
//
// A finance user asks for a QUOTE (the fee and, where the bank says, the date); a REQUEST spends the quote (so a late approval cannot fail on
// an expired one) and carries the institution's KC- payment reference; a SECOND finance user or admin APPROVES it, never the person who asked.
// On approval the money moves one of three ways, by how the institution's US account is held (T-0650):
// - its own entity: an ACH credit to Kesher's US collection account, the KC- reference in `addenda`, the provider's idempotency key `us-fund:<institution>:<key>`;
// - a platform sub-account with its own number: a book transfer to Kesher's collection account, the reference in the memo, the same key;
// - a pooled platform account: no bank movement at all.
// Nothing here posts money. The master account is credited only by the existing deposit path (T-0614, T-0618), when the ACH arrives with the
// KC- reference (the bank feed posts it) or, for the two book-keeping paths, when Kesher finance approves the deposit this card records
// for them. The deposit path tells this card when a deposit posts, and the request is linked to it (`received`): by deposit id for the
// recorded ones, by amount for an ACH that arrived (the credit is already tied to the institution by its reference).
//
// A request's life is an insert-only event log. A provider failure that may pass (unavailable) leaves it `approved` for the sweep to send
// again under the same key; a refusal, a rejection or a return opens a case and the status says so.
import { DomainError, fromWire, money, toWire, uuidv7, type Money } from '@kesher/domain';
import { InstitutionBankingError, isAddenda, type AchStatus, type InstitutionBankingPort, type ProviderRegistry } from '@kesher/ports';
import type { AuditService } from '../audit/service.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database, SqlClient } from '../db.ts';
import { created, ok, requireIdempotencyKey, requireRole, route, type Handler, type HttpRequest } from '../http.ts';
import { paymentReference, type InstitutionDeposits } from './deposits.ts';
import type { KybGate } from './kyb-gate.ts';
import { US_BANKING_FLAG, type InstitutionUsBanking } from './us-banking.ts';

const ENTITY_TYPE = 'institution_us_funding';
const QUOTE_TTL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FundingStatus = 'awaiting_approval' | 'approved' | 'in_transit' | 'deposit_pending' | 'received' | 'returned' | 'rejected' | 'cancelled' | 'failed';
type EventKind = 'requested' | 'approved' | 'sent' | 'ach_status' | 'book_transferred' | 'deposit_recorded' | 'linked' | 'cancelled' | 'failed';
interface Event {
  kind: EventKind;
  by_party: string | null;
  payload: Record<string, unknown>;
  at: string | Date;
}
interface RequestRow {
  id: string;
  institution_id: string;
  idempotency_key: string;
  quote_id: string;
  holder: 'platform' | 'institution';
  amount_minor: string;
  currency: 'USD';
  reference: string;
  requested_by: string;
  created_at: string | Date;
}

export interface UsFundingDeps {
  db: Database;
  flags: FeatureFlags;
  audit: AuditService;
  kyb: KybGate;
  registry: ProviderRegistry;
  deposits: InstitutionDeposits;
  usBanking: InstitutionUsBanking;
  /** The provider's saved counterparty for Kesher's US collection account (set up by ops), for an ACH. */
  collectionCounterpartyRef: () => string | undefined;
  /** The provider's id of Kesher's collection account, for a book transfer from a platform sub-account. */
  collectionAccountRef: () => string | undefined;
}

export interface UsFundingView {
  id: string;
  status: FundingStatus;
  amount: { minor: string; currency: string };
  reference: string;
  holder: 'platform' | 'institution';
  requestedBy: string;
  approvedBy?: string;
  createdAt: string;
  achStatus?: AchStatus;
  depositId?: string;
  failure?: string;
}

/** What a request's events say it is now. */
function fold(events: readonly Event[]): { status: FundingStatus; paymentRef?: string; achStatus?: AchStatus; depositId?: string; approvedBy?: string; failure?: string } {
  let status: FundingStatus = 'awaiting_approval';
  const out: { paymentRef?: string; achStatus?: AchStatus; depositId?: string; approvedBy?: string; failure?: string } = {};
  for (const e of events) {
    const p = e.payload;
    switch (e.kind) {
      case 'approved':
        status = 'approved';
        if (e.by_party) out.approvedBy = e.by_party;
        break;
      case 'sent':
      case 'ach_status': {
        if (typeof p['paymentRef'] === 'string') out.paymentRef = p['paymentRef'];
        out.achStatus = p['status'] as AchStatus;
        status = out.achStatus === 'returned' ? 'returned' : out.achStatus === 'rejected' ? 'rejected' : out.achStatus === 'cancelled' ? 'cancelled' : 'in_transit';
        break;
      }
      case 'deposit_recorded':
        status = 'deposit_pending';
        if (typeof p['depositId'] === 'string') out.depositId = p['depositId'];
        break;
      case 'linked':
        status = 'received';
        if (typeof p['depositId'] === 'string') out.depositId = p['depositId'];
        break;
      case 'cancelled':
        status = 'cancelled';
        break;
      case 'failed':
        status = 'failed';
        if (typeof p['reason'] === 'string') out.failure = p['reason'];
        break;
      default:
        break;
    }
  }
  return { status, ...out };
}

const FINAL: readonly FundingStatus[] = ['received', 'returned', 'rejected', 'cancelled', 'failed'];

function asDomain(e: unknown): never {
  if (!(e instanceof InstitutionBankingError)) throw e;
  if (e.code === 'VALIDATION_FAILED' || e.code === 'NOT_APPROVED') throw new DomainError('VALIDATION_FAILED', e.message);
  throw new DomainError('PROVIDER_UNAVAILABLE', 'The banking provider is not available');
}

function parseAmount(body: unknown): Money {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const a = b['amount'];
  if (typeof a !== 'object' || a === null || typeof (a as { minor?: unknown }).minor !== 'string' || (a as { currency?: unknown }).currency !== 'USD') throw new DomainError('VALIDATION_FAILED', 'amount must be { minor, currency: "USD" }');
  let m: Money;
  try {
    m = fromWire(a as { minor: string; currency: string });
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'amount.minor must be a whole number of cents');
  }
  if (m.minor <= 0n) throw new DomainError('VALIDATION_FAILED', 'amount must be positive');
  return m;
}

export class InstitutionUsFunding {
  private readonly d: UsFundingDeps;
  constructor(deps: UsFundingDeps) {
    this.d = deps;
    // A deposit that posts may be the money a request sent.
    deps.deposits.afterPosted((dep, now) => this.linkDeposit(dep, now));
  }

  private async requireOn(): Promise<void> {
    if (!(await this.d.flags.isOn(US_BANKING_FLAG))) throw new DomainError('FEATURE_OFF', 'US banking is not available');
  }

  /** The approved US account, and KYB open for it; the port for its market. */
  private async open(institutionId: string) {
    const acct = await this.d.usBanking.account(institutionId);
    if (!acct || acct.status !== 'approved') throw new DomainError('VALIDATION_FAILED', 'The US account is not approved yet');
    await this.d.kyb.require(institutionId, 'us_banking');
    return { ...acct, port: this.d.registry.resolve<InstitutionBankingPort>('institution-banking', acct.market) };
  }

  /** The fee and date for funding this amount; valid for ten minutes and spent by the request that uses it. */
  async quote(institutionId: string, actorId: string, body: unknown, now: Date) {
    await this.requireOn();
    const amount = parseAmount(body);
    const acct = await this.open(institutionId);
    let fee = money(0n, 'USD');
    let arrivesOn: string | undefined;
    if (acct.holder === 'institution') {
      if (!acct.ref) throw new DomainError('VALIDATION_FAILED', 'The US account is not approved yet');
      const q = await acct.port.quoteAch({ entityRef: acct.ref, amount }).catch(asDomain);
      fee = q.fee;
      arrivesOn = q.arrivesOn;
    }
    const id = uuidv7(now);
    const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
    await this.d.db.query('insert into org.us_funding_quote (id, institution_id, amount_minor, fee_minor, currency, arrives_on, expires_at, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [id, institutionId, amount.minor.toString(), fee.minor.toString(), 'USD', arrivesOn ?? null, expiresAt, actorId, now]);
    return { quoteId: id, amount: toWire(amount), fee: toWire(fee), ...(arrivesOn ? { arrivesOn } : {}), expiresAt: expiresAt.toISOString(), holder: acct.holder };
  }

  /** Asks for the funding the quote priced. The same key and quote answer the same request. */
  async request(institutionId: string, actorId: string, body: unknown, key: string, now: Date): Promise<UsFundingView> {
    await this.requireOn();
    const quoteId = (body as { quoteId?: unknown } | null)?.quoteId;
    if (typeof quoteId !== 'string' || !UUID.test(quoteId)) throw new DomainError('VALIDATION_FAILED', 'quoteId is required');
    const acct = await this.open(institutionId);
    if (acct.holder === 'institution' && !this.d.collectionCounterpartyRef()) throw new DomainError('VALIDATION_FAILED', 'Kesher\'s US collection account is not set up yet');
    if (acct.holder === 'platform' && !acct.sharesPlatformAccount && !this.d.collectionAccountRef()) throw new DomainError('VALIDATION_FAILED', 'Kesher\'s US collection account is not set up yet');
    const id = await this.d.db.transaction(async (tx) => {
      await tx.query('select 1 from org.institution where id = $1 for update', [institutionId]);
      const prior = (await tx.query<RequestRow>('select * from org.us_funding_request where institution_id = $1 and idempotency_key = $2', [institutionId, key])).rows[0];
      if (prior) {
        if (prior.quote_id !== quoteId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'That key was used for a different request');
        return prior.id;
      }
      const q = (await tx.query<{ institution_id: string; amount_minor: string; expires_at: string | Date }>('select institution_id, amount_minor::text, expires_at from org.us_funding_quote where id = $1', [quoteId])).rows[0];
      if (!q || q.institution_id !== institutionId) throw new DomainError('NOT_FOUND', 'Quote not found');
      if (new Date(q.expires_at).getTime() <= now.getTime()) throw new DomainError('QUOTE_EXPIRED', 'The quote has expired; ask for a new one');
      if ((await tx.query('select 1 from org.us_funding_request where quote_id = $1', [quoteId])).rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'That quote already has a request');
      const rid = uuidv7(now);
      await tx.query('insert into org.us_funding_request (id, institution_id, idempotency_key, quote_id, holder, amount_minor, currency, reference, requested_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [rid, institutionId, key, quoteId, acct.holder, q.amount_minor, 'USD', paymentReference(institutionId), actorId, now]);
      await this.append(tx, rid, 'requested', actorId, {}, now);
      return rid;
    });
    await this.d.audit.record({ actorId, actorRole: 'org_finance', action: 'institution.us_funding.request', subject: institutionId, reason: 'US funding requested', payload: { requestId: id, institutionId } }, now);
    return this.view(id);
  }

  /** The second approver: never the person who asked. Sends the money, or leaves it approved for the sweep to send. */
  async approve(institutionId: string, requestId: string, actorId: string, now: Date): Promise<UsFundingView> {
    await this.requireOn();
    const req = await this.requireRequest(institutionId, requestId);
    if (req.requested_by === actorId) throw new DomainError('FORBIDDEN', 'The person who asked for the funding cannot approve it');
    await this.open(institutionId);
    const moved = await this.d.db.transaction(async (tx) => {
      await tx.query('select 1 from org.us_funding_request where id = $1 for update', [requestId]);
      if (fold(await this.events(requestId, tx)).status !== 'awaiting_approval') return false;
      await this.append(tx, requestId, 'approved', actorId, {}, now);
      return true;
    });
    if (moved) await this.d.audit.record({ actorId, actorRole: 'org_finance', action: 'institution.us_funding.approve', subject: institutionId, reason: 'US funding approved', payload: { requestId, institutionId } }, now);
    await this.execute(requestId, now);
    return this.view(requestId);
  }

  /** Sends an approved request's money. Safe to repeat: the provider hears the same key every time. */
  async execute(requestId: string, now: Date): Promise<void> {
    const req = (await this.d.db.query<RequestRow>('select * from org.us_funding_request where id = $1', [requestId])).rows[0];
    if (!req || fold(await this.events(requestId)).status !== 'approved') return;
    const acct = await this.d.usBanking.account(req.institution_id);
    if (!acct || !acct.ref) return;
    const port = this.d.registry.resolve<InstitutionBankingPort>('institution-banking', acct.market);
    const amount = money(BigInt(req.amount_minor), 'USD');
    const key = `us-fund:${req.institution_id}:${req.idempotency_key}`;
    try {
      if (acct.holder === 'institution') {
        const counterpartyRef = this.d.collectionCounterpartyRef();
        if (!counterpartyRef || !isAddenda(req.reference)) throw new InstitutionBankingError('VALIDATION_FAILED', 'The transfer cannot be described to the bank');
        const sent = await port.sendAch({ entityRef: acct.ref, counterpartyRef, amount, addenda: req.reference, idempotencyKey: key });
        await this.d.db.transaction(async (tx) => {
          await tx.query('insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ($1, $2, $3, $4) on conflict do nothing', [ENTITY_TYPE, requestId, acct.provider ?? 'simulator', sent.paymentRef]);
          await this.append(tx, requestId, 'sent', null, { paymentRef: sent.paymentRef, status: sent.status }, now);
        });
        return;
      }
      if (!acct.sharesPlatformAccount) {
        const to = this.d.collectionAccountRef();
        if (!to || !isAddenda(req.reference)) throw new InstitutionBankingError('VALIDATION_FAILED', 'The transfer cannot be described to the bank');
        await port.bookTransfer({ fromRef: acct.ref, toRef: to, amount, memo: req.reference, idempotencyKey: key });
        await this.append(this.d.db, requestId, 'book_transferred', null, {}, now);
      }
      // No bank credit comes for money that never left Kesher's accounts: the deposit is recorded for finance to approve.
      const dep = await this.d.deposits.recordSystem(req.institution_id, { amount, bankReference: `USFUND-${requestId.slice(-12).toUpperCase()}`, note: 'US funding' }, `us-fund-deposit:${requestId}`, now);
      await this.append(this.d.db, requestId, 'deposit_recorded', null, { depositId: dep.id }, now);
    } catch (e) {
      if (!(e instanceof InstitutionBankingError)) throw e;
      // Unavailable passes: the request stays approved and the sweep sends it again under the same key. Anything else is final.
      if (e.code === 'PROVIDER_UNAVAILABLE') return;
      await this.fail(req, e.code, now);
    }
  }

  /** The provider's word on an ACH this card sent (a T-0649 event or a poll): recorded when it changed; a return or rejection opens a case. */
  async onProviderAch(paymentRef: string, status: AchStatus, now: Date): Promise<void> {
    const r = (await this.d.db.query<{ entity_id: string }>('select entity_id from ops.external_ref where entity_type = $1 and external_id = $2', [ENTITY_TYPE, paymentRef])).rows[0];
    if (!r) return;
    const req = (await this.d.db.query<RequestRow>('select * from org.us_funding_request where id = $1', [r.entity_id])).rows[0];
    if (!req) return;
    const changed = await this.d.db.transaction(async (tx) => {
      await tx.query('select 1 from org.us_funding_request where id = $1 for update', [req.id]);
      const now_ = fold(await this.events(req.id, tx));
      if (FINAL.includes(now_.status) || now_.achStatus === status) return false;
      await this.append(tx, req.id, 'ach_status', null, { paymentRef, status }, now);
      return true;
    });
    if (changed && (status === 'returned' || status === 'rejected')) await this.openCase(req, status, now);
  }

  /** Cancels a request nobody has sent yet, or an ACH the bank still holds as pending. */
  async cancel(institutionId: string, requestId: string, actorId: string, now: Date): Promise<UsFundingView> {
    await this.requireOn();
    await this.requireRequest(institutionId, requestId);
    const s = fold(await this.events(requestId));
    if (s.status === 'awaiting_approval' || (s.status === 'approved' && !s.paymentRef)) {
      await this.append(this.d.db, requestId, 'cancelled', actorId, {}, now);
    } else if (s.status === 'in_transit' && s.paymentRef && s.achStatus === 'pending') {
      const acct = await this.d.usBanking.account(institutionId);
      if (!acct) throw new DomainError('VALIDATION_FAILED', 'The US account is not approved yet');
      const port = this.d.registry.resolve<InstitutionBankingPort>('institution-banking', acct.market);
      const status = await port.cancelAch(s.paymentRef).catch((e: unknown) => {
        if (e instanceof InstitutionBankingError && e.code === 'NOT_CANCELLABLE') throw new DomainError('IDEMPOTENCY_CONFLICT', 'The bank has already sent this transfer');
        return asDomain(e);
      });
      await this.onProviderAch(s.paymentRef, status, now);
    } else {
      throw new DomainError('IDEMPOTENCY_CONFLICT', `A funding that is ${s.status.replace(/_/g, ' ')} cannot be cancelled`);
    }
    await this.d.audit.record({ actorId, actorRole: 'org_finance', action: 'institution.us_funding.cancel', subject: institutionId, reason: 'US funding cancelled', payload: { requestId, institutionId } }, now);
    return this.view(requestId);
  }

  async list(institutionId: string): Promise<{ items: UsFundingView[] }> {
    await this.requireOn();
    const rows = await this.d.db.query<{ id: string }>('select id from org.us_funding_request where institution_id = $1 order by created_at desc, id desc limit 50', [institutionId]);
    return { items: await Promise.all(rows.rows.map((r) => this.view(r.id))) };
  }

  /** The worker's cycle for one market: approved requests not yet sent are sent; sent ones the bank has not finished are asked about. */
  async sweep(market: 'IL' | 'US', now: Date): Promise<{ sent: number; polled: number }> {
    const rows = await this.d.db.query<{ id: string }>(
      `select r.id from org.us_funding_request r join org.institution i on i.id = r.institution_id where i.market = $1
        and not exists (select 1 from org.us_funding_event e where e.request_id = r.id and e.kind in ('linked', 'failed', 'cancelled', 'deposit_recorded')) order by r.created_at`,
      [market],
    );
    let sent = 0;
    let polled = 0;
    for (const { id } of rows.rows) {
      const s = fold(await this.events(id));
      if (s.status === 'approved') {
        await this.execute(id, now);
        sent += 1;
      } else if (s.status === 'in_transit' && s.paymentRef) {
        const req = (await this.d.db.query<RequestRow>('select * from org.us_funding_request where id = $1', [id])).rows[0]!;
        const acct = await this.d.usBanking.account(req.institution_id);
        if (!acct) continue;
        try {
          await this.onProviderAch(s.paymentRef, await this.d.registry.resolve<InstitutionBankingPort>('institution-banking', acct.market).achStatus(s.paymentRef), now);
          polled += 1;
        } catch (e) {
          if (!(e instanceof InstitutionBankingError)) throw e; // the provider is unavailable: next cycle
        }
      }
    }
    return { sent, polled };
  }

  /** A deposit has posted: the request whose money it is becomes `received`. A recorded deposit is found by its id; an arrived ACH by its amount. */
  async linkDeposit(dep: { id: string; institutionId: string; amountMinor: bigint; currency: string }, now: Date): Promise<void> {
    if (dep.currency !== 'USD') return;
    const rows = await this.d.db.query<RequestRow>('select * from org.us_funding_request where institution_id = $1 order by created_at', [dep.institutionId]);
    let match: RequestRow | undefined;
    for (const r of rows.rows) {
      const s = fold(await this.events(r.id));
      if (s.depositId === dep.id && s.status === 'deposit_pending') {
        match = r;
        break;
      }
      if (!match && s.status === 'in_transit' && s.paymentRef && BigInt(r.amount_minor) === dep.amountMinor) match = r;
    }
    if (!match) return;
    await this.d.db.transaction(async (tx) => {
      await tx.query('select 1 from org.us_funding_request where id = $1 for update', [match.id]);
      if (FINAL.includes(fold(await this.events(match.id, tx)).status)) return;
      await this.append(tx, match.id, 'linked', null, { depositId: dep.id }, now);
    });
  }

  private async fail(req: RequestRow, reason: string, now: Date): Promise<void> {
    await this.append(this.d.db, req.id, 'failed', null, { reason }, now);
    await this.openCase(req, reason, now);
  }

  private async openCase(req: RequestRow, reason: string, now: Date): Promise<void> {
    await this.d.db.query(
      `insert into ops.case (id, kind, dedupe_key, severity, status, payload, opened_at) values ($1, 'us_funding_failed', $2, 'high', 'open', $3, $4) on conflict (dedupe_key) do nothing`,
      [uuidv7(now), `us-funding-failed:${req.id}`, { requestId: req.id, institutionId: req.institution_id, reason, amount: { minor: req.amount_minor, currency: req.currency }, reference: req.reference }, now],
    );
    await this.d.audit.record({ actorId: req.requested_by, actorRole: 'system', action: 'institution.us_funding.failed', subject: req.institution_id, reason: `US funding ${reason}`, payload: { requestId: req.id } }, now);
  }

  private async requireRequest(institutionId: string, requestId: string): Promise<RequestRow> {
    const r = UUID.test(requestId) ? (await this.d.db.query<RequestRow>('select * from org.us_funding_request where id = $1 and institution_id = $2', [requestId, institutionId])).rows[0] : undefined;
    if (!r) throw new DomainError('NOT_FOUND', 'Funding request not found');
    return r;
  }

  private async events(requestId: string, client: SqlClient = this.d.db): Promise<Event[]> {
    return (await client.query<Event>('select kind, by_party, payload, at from org.us_funding_event where request_id = $1 order by seq', [requestId])).rows;
  }

  private async append(tx: SqlClient, requestId: string, kind: EventKind, by: string | null, payload: Record<string, unknown>, now: Date): Promise<void> {
    await tx.query('insert into org.us_funding_event (id, request_id, kind, by_party, payload, at) values ($1, $2, $3, $4, $5, $6)', [uuidv7(now), requestId, kind, by, JSON.stringify(payload), now]);
  }

  private async view(requestId: string): Promise<UsFundingView> {
    const r = (await this.d.db.query<RequestRow>('select * from org.us_funding_request where id = $1', [requestId])).rows[0]!;
    const s = fold(await this.events(requestId));
    return {
      id: r.id,
      status: s.status,
      amount: toWire(money(BigInt(r.amount_minor), 'USD')),
      reference: r.reference,
      holder: r.holder,
      requestedBy: r.requested_by,
      createdAt: new Date(r.created_at).toISOString(),
      ...(s.approvedBy ? { approvedBy: s.approvedBy } : {}),
      ...(s.achStatus ? { achStatus: s.achStatus } : {}),
      ...(s.depositId ? { depositId: s.depositId } : {}),
      ...(s.failure ? { failure: s.failure } : {}),
    };
  }
}

type StaffOfFn = (partyId: string) => Promise<{ institutionId: string; role: 'staff' | 'finance' | 'admin' } | undefined>;

export function usFundingHandlers(svc: InstitutionUsFunding, stepUp: StepUpService, staffOf: StaffOfFn): Record<string, Handler> {
  /** Finance staff and admins of this institution. Another institution reads as not found. */
  const own = async (req: HttpRequest) => {
    const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
    const institutionId = req.params['id'] ?? '';
    const staff = await staffOf(p.partyId);
    if (!staff || staff.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
    if (staff.role !== 'finance' && staff.role !== 'admin') throw new DomainError('FORBIDDEN', 'Only finance staff and admins fund the master account');
    return { institutionId, partyId: p.partyId };
  };
  return {
    quoteInstitutionUsFunding: route(async (req) => {
      const { institutionId, partyId } = await own(req);
      return ok(await svc.quote(institutionId, partyId, req.body, req.now));
    }),
    createInstitutionUsFunding: route(async (req) => {
      const { institutionId, partyId } = await own(req);
      requireStepUp(stepUp, req);
      return created(await svc.request(institutionId, partyId, req.body, requireIdempotencyKey(req), req.now));
    }),
    listInstitutionUsFunding: route(async (req) => {
      const { institutionId } = await own(req);
      return ok(await svc.list(institutionId));
    }),
    approveInstitutionUsFunding: route(async (req) => {
      const { institutionId, partyId } = await own(req);
      requireStepUp(stepUp, req);
      return ok(await svc.approve(institutionId, req.params['requestId'] ?? '', partyId, req.now));
    }),
    cancelInstitutionUsFunding: route(async (req) => {
      const { institutionId, partyId } = await own(req);
      requireStepUp(stepUp, req);
      return ok(await svc.cancel(institutionId, req.params['requestId'] ?? '', partyId, req.now));
    }),
  };
}
