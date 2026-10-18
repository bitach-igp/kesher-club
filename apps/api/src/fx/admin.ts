// /admin/fx/rates (T-0512, REQ-ADM-003, ADR-013): finance reads the rate history, proposes a manual rate
// and gives the second approval, all through the API with a staff token whose SSO roles include
// finance. The rate travels as a decimal string with up to six places; the service keeps the integer.
import { DomainError } from '@kesher/domain';
import { requireStaff } from '../admin/staff-token.ts';
import type { ApprovalRequest } from '../approvals/service.ts';
import { created, ok, route, type Handler } from '../http.ts';
import { formatRate, PAIRS, parseRate, type ClubRate, type RatePair, type RateService } from './rates.ts';

const approvalBody = (a: ApprovalRequest) => ({ id: a.id, kind: a.kind, subject: a.subject, status: a.status, approvals: a.approvals, requestedBy: a.requestedBy, expiresAt: new Date(a.expiresAt).toISOString(), payload: a.payload });

/** The OpenAPI `FxRate`. */
export const rateBody = (r: ClubRate, approval?: ApprovalRequest) => ({
  id: r.id,
  pair: r.pair,
  version: r.version,
  mid: formatRate(r.midScaled),
  source: r.source,
  status: r.status,
  ...(r.validFrom ? { validFrom: r.validFrom } : {}),
  ...(r.validUntil ? { validUntil: r.validUntil } : {}),
  proposedBy: r.proposedBy,
  ...(r.reason ? { reason: r.reason } : {}),
  createdAt: r.createdAt,
  ...(approval ? { approval: approvalBody(approval) } : {}),
});

/** A finance approver: the staff principal's party, with the finance role the approvals service checks. */
const financeActor = (req: Parameters<typeof requireStaff>[0]) => {
  const p = requireStaff(req, 'finance');
  return { partyId: p.partyId, role: 'finance', subject: p.subject ?? p.partyId };
};

const pairParam = (v: unknown): RatePair => {
  if (typeof v !== 'string' || !(PAIRS as readonly string[]).includes(v)) throw new DomainError('VALIDATION_FAILED', `pair must be one of ${PAIRS.join(', ')}`);
  return v as RatePair;
};

export function fxAdminHandlers(rates: RateService): Record<string, Handler> {
  return {
    listAdminFxRates: route(async (req) => {
      requireStaff(req);
      const pair = pairParam(req.query['pair'] ?? 'USD/ILS');
      const [current, items] = await Promise.all([rates.current(pair, req.now), rates.history(pair)]);
      return ok({ pair, ...(current ? { current: rateBody(current) } : {}), items: items.map((r) => rateBody(r)) });
    }),
    proposeAdminFxRate: route(async (req) => {
      const by = financeActor(req);
      const b = (req.body ?? {}) as { pair?: unknown; mid?: unknown; reason?: unknown };
      const pair = pairParam(b.pair ?? 'USD/ILS');
      if (typeof b.mid !== 'string') throw new DomainError('VALIDATION_FAILED', 'mid must be a decimal string, e.g. 3.7000');
      const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
      if (!reason) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
      const r = await rates.propose(pair, parseRate(b.mid), by, reason, req.now);
      return created(rateBody(r.rate, r.approval));
    }),
    approveAdminFxRate: route(async (req) => {
      const by = financeActor(req);
      const r = await rates.approve(req.params['id'] ?? '', by, req.now);
      return ok(rateBody(r.rate, r.approval));
    }),
    rejectAdminFxRate: route(async (req) => {
      const by = financeActor(req);
      const b = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
      if (!reason) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
      const r = await rates.reject(req.params['id'] ?? '', by, reason, req.now);
      return ok(rateBody(r.rate, r.approval));
    }),
  };
}
