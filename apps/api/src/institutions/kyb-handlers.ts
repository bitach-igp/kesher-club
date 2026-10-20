// KYB over HTTP (T-0620, REQ-INS-011): /admin/institutions/{id}/kyb* and /admin/kyb/*, staff tokens only. Anyone on
// staff reads a record; writes take the `compliance` role. `admin` would not do: every staff token carries it.
// The service (T-0619) holds the rules; this file maps requests onto it.
import { DomainError } from '@kesher/domain';
import type { Approver } from '../approvals/service.ts';
import { approvalBody } from '../admin/handlers.ts';
import { requireStaff, staffActor } from '../admin/staff-token.ts';
import { created, ok, requireIdempotencyKey, route, type Handler, type HttpRequest } from '../http.ts';
import type { CheckKind, CheckResult, InstitutionKyb } from './kyb.ts';

const KINDS: readonly CheckKind[] = ['registry', 'identifier', 'exempt_status', 'sanctions', 'pep'];
const RESULTS: readonly CheckResult[] = ['clear', 'hit', 'missing', 'excepted'];

const compliance = (req: HttpRequest): Approver => ({ ...staffActor(requireStaff(req, 'compliance')), role: 'compliance' });

export function kybHandlers(kyb: InstitutionKyb): Record<'getAdminInstitutionKyb' | 'addAdminKybPerson' | 'recordAdminKybCheck' | 'disposeAdminKybCheck' | 'decideAdminKyb' | 'approveAdminKybDecision', Handler> {
  return {
    getAdminInstitutionKyb: route(async (req) => {
      requireStaff(req);
      const r = await kyb.record(req.params['id'] ?? '');
      return ok({ ...r, ...(r.pendingApproval ? { pendingApproval: approvalBody(r.pendingApproval) } : {}) });
    }),

    addAdminKybPerson: route(async (req) => {
      const by = compliance(req);
      const b = (req.body ?? {}) as { fullName?: unknown; roles?: unknown; partyId?: unknown };
      return created(await kyb.addPerson(req.params['id'] ?? '', { fullName: b.fullName, roles: b.roles, ...(b.partyId !== undefined ? { partyId: b.partyId } : {}) }, requireIdempotencyKey(req), by, req.now));
    }),

    recordAdminKybCheck: route(async (req) => {
      const by = compliance(req);
      const b = (req.body ?? {}) as { kind?: unknown; personId?: unknown; result?: unknown; evidenceRef?: unknown; reason?: unknown };
      if (!KINDS.includes(b.kind as CheckKind)) throw new DomainError('VALIDATION_FAILED', 'kind must be registry, identifier, exempt_status, sanctions or pep');
      if (!RESULTS.includes(b.result as CheckResult)) throw new DomainError('VALIDATION_FAILED', 'result must be clear, hit, missing or excepted');
      const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 1000) : undefined;
      const evidenceRef = typeof b.evidenceRef === 'string' && b.evidenceRef.trim() ? b.evidenceRef.trim().slice(0, 500) : undefined;
      const check = await kyb.recordCheck(
        req.params['id'] ?? '',
        { kind: b.kind as CheckKind, result: b.result as CheckResult, provider: 'compliance', ...(typeof b.personId === 'string' ? { personId: b.personId } : {}), ...(evidenceRef ? { evidenceRef } : {}), ...(reason ? { detail: { reason } } : {}) },
        by.partyId,
        req.now,
      );
      return created(check);
    }),

    disposeAdminKybCheck: route(async (req) => {
      const b = (req.body ?? {}) as { outcome?: unknown; note?: unknown };
      return ok(await kyb.dispose(req.params['id'] ?? '', { outcome: b.outcome, note: b.note }, compliance(req), req.now));
    }),

    decideAdminKyb: route(async (req) => {
      const by = compliance(req);
      const b = (req.body ?? {}) as { status?: unknown; risk?: unknown; reasons?: unknown };
      const r = await kyb.decide(req.params['id'] ?? '', { status: b.status, ...(b.risk !== undefined ? { risk: b.risk } : {}), ...(b.reasons !== undefined ? { reasons: b.reasons } : {}) }, requireIdempotencyKey(req), by, req.now);
      return created({ ...(r.decision ? { decision: r.decision } : {}), ...(r.approval ? { approval: approvalBody(r.approval) } : {}) });
    }),

    approveAdminKybDecision: route(async (req) => {
      const r = await kyb.approveDecision(req.params['id'] ?? '', compliance(req), req.now);
      return ok({ approval: approvalBody(r.approval), ...(r.decision ? { decision: r.decision } : {}) });
    }),
  };
}
