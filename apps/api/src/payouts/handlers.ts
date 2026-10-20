// /payouts (T-0510, REQ-PO-001/002): the fresh step-up first (REQ-AUTH-006), then the recovery hold
// (no payouts, and no new payees, for 24 h after a recovery sign-in), then the flag inside the service,
// then the Idempotency-Key that names the PayoutWorkflow.
// Institution payouts (T-0527, REQ-INS-004): the institution's finance staff pay out of its own account
// (T-0613), list its payouts, and a second finance member approves or rejects one waiting for them.
// Another institution's payouts are not found; staff appear by display name only.
import { DomainError, toWire } from '@kesher/domain';
import { assertNotRestricted } from '../auth/recovery.ts';
import type { IdentityRepository } from '../auth/repository.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { Database } from '../db.ts';
import { created, ok, requireIdempotencyKey, requirePrincipal, requireRole, route, type Handler, type HttpRequest, type Principal } from '../http.ts';
import type { PayoutAccounts } from '../institutions/payout-account.ts';
import { staffNames } from '../institutions/staff-names.ts';
import type { InstitutionPayoutRow, PayoutService } from './service.ts';

export interface InstitutionPayoutDeps {
  db: Database;
  identity: Pick<IdentityRepository, 'findUser'>;
  /** The institution a member is active staff of, and their role there. */
  staffOf(partyId: string): Promise<{ institutionId: string; role: 'staff' | 'finance' | 'admin' } | undefined>;
  /** Institution payouts are withdrawals to the own verified account (T-0623, T-0625). */
  accounts: Pick<PayoutAccounts, 'active' | 'summary'>;
}

const PAGE = 20;

/** Finance staff of `institutionId` (else 404); their approver identity for the approval service. */
async function financeOf(d: InstitutionPayoutDeps, req: HttpRequest, institutionId: string | undefined): Promise<{ p: Principal; institutionId: string; approver: { partyId: string; role: 'finance' } }> {
  const p = requireRole(req, 'org_finance');
  const staff = await d.staffOf(p.partyId);
  if (!staff || staff.role !== 'finance' || (institutionId !== undefined && staff.institutionId !== institutionId)) throw new DomainError('NOT_FOUND', 'Institution not found');
  return { p, institutionId: staff.institutionId, approver: { partyId: p.partyId, role: 'finance' } };
}

const encodeCursor = (c: { at: string; id: string }): string => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string | undefined): { at: string; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof c.at === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.at)) && /^[0-9a-f-]{36}$/i.test(c.id)) return { at: c.at, id: c.id };
  } catch {
    // fall through
  }
  throw new DomainError('VALIDATION_FAILED', 'cursor is not one this API gave out');
}

async function bodies(d: InstitutionPayoutDeps, rows: readonly InstitutionPayoutRow[]) {
  const names = await staffNames(d.db, d.identity, rows.flatMap((r) => [...(r.requestedBy ? [r.requestedBy] : []), ...r.approvers]));
  return rows.map((r) => ({
    id: r.view.id,
    state: r.view.state,
    amount: r.view.amount,
    payee: r.payee,
    reference: r.transfer.note ?? '',
    createdAt: r.transfer.createdAt,
    ...(r.view.scheduledFor ? { coolOffEndsAt: r.view.scheduledFor } : {}),
    ...(r.requestedBy ? { requestedBy: names.get(r.requestedBy)! } : {}),
    approvedBy: r.approvers.map((a) => names.get(a)!),
    requiredApprovals: r.required,
    requestedByMe: r.requestedByViewer,
    ...(r.transfer.failureCode ? { failureCode: r.transfer.failureCode } : {}),
  }));
}

export function payoutHandlers(payouts: PayoutService, stepUp: StepUpService, d: InstitutionPayoutDeps): Record<string, Handler> {
  const one = async (institutionId: string, id: string, viewer: string) => (await bodies(d, [await payouts.institutionPayout(institutionId, id, viewer)]))[0]!;
  return {
    createPayout: route(async (req) => {
      const p = requirePrincipal(req);
      requireStepUp(stepUp, req);
      assertNotRestricted(p, 'payout', req.now);
      const key = requireIdempotencyKey(req);
      const { newPayee, ...view } = await payouts.request(p.partyId, req.body, key, req.now);
      if (newPayee) assertNotRestricted(p, 'new_payee', req.now);
      return created(view);
    }),

    listInstitutionPayouts: route(async (req) => {
      const { p, institutionId } = await financeOf(d, req, req.params['id']);
      const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? PAGE) || PAGE));
      const page = await payouts.listForInstitution(institutionId, p.partyId, decodeCursor(req.query['cursor']), limit);
      return ok({ items: await bodies(d, page.items), ...(page.next ? { nextCursor: encodeCursor(page.next) } : {}), available: toWire(page.available) });
    }),

    getInstitutionPayoutAccount: route(async (req) => {
      const { institutionId } = await financeOf(d, req, req.params['id']);
      return ok(await d.accounts.summary(institutionId));
    }),

    createInstitutionPayout: route(async (req) => {
      const { p, institutionId } = await financeOf(d, req, req.params['id']);
      requireStepUp(stepUp, req);
      assertNotRestricted(p, 'payout', req.now);
      const key = requireIdempotencyKey(req);
      // A withdrawal to the institution's own verified account (T-0625): the payee is never the client's to name.
      const b = (req.body ?? {}) as { payee?: unknown; amount?: unknown; reference?: unknown };
      if (b.payee !== undefined) throw new DomainError('VALIDATION_FAILED', 'Institution payouts go to the institution\'s own verified account; send no payee', { reason: 'payee_not_accepted' });
      const own = await d.accounts.active(institutionId);
      if (!own) throw new DomainError('VALIDATION_FAILED', 'The institution has no verified payout account yet', { reason: 'no_verified_account' });
      const body = { payee: { iban: own.iban, name: own.holderName }, amount: b.amount, reference: b.reference };
      const { newPayee, id } = await payouts.request(institutionId, body, key, req.now, { kind: 'institution', requestedBy: p.partyId, requesterRole: 'finance' });
      if (newPayee) assertNotRestricted(p, 'new_payee', req.now);
      return created(await one(institutionId, id, p.partyId));
    }),

    approvePayout: route(async (req) => {
      const { p, institutionId, approver } = await financeOf(d, req, undefined);
      requireStepUp(stepUp, req);
      requireIdempotencyKey(req);
      const id = req.params['id'] ?? '';
      await payouts.decide(id, institutionId, approver, 'approve', req.now);
      return ok(await one(institutionId, id, p.partyId));
    }),

    rejectPayout: route(async (req) => {
      const { p, institutionId, approver } = await financeOf(d, req, undefined);
      requireStepUp(stepUp, req);
      requireIdempotencyKey(req);
      const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === 'string' ? (req.body as { reason: string }).reason.trim() : '';
      if (!reason || reason.length > 500) throw new DomainError('VALIDATION_FAILED', 'A reason of 1 to 500 characters is required');
      const id = req.params['id'] ?? '';
      await payouts.decide(id, institutionId, approver, 'reject', req.now, reason);
      return ok(await one(institutionId, id, p.partyId));
    }),
  };
}
