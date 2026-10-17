// /admin/* handlers (T-0906, ADR-013): flags with the two-person flip, provider bindings, audit.
// Every handler needs a staff principal; the services do the real work and the auditing.
import { PORTS, type Market, type ProviderRegistry } from '@kesher/ports';
import { DomainError } from '@kesher/domain';
import type { ApprovalRequest, ApprovalService } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { FlagService } from '../flags/service.ts';
import { ok, route, type Handler } from '../http.ts';
import { requireStaff, staffActor } from './staff-token.ts';

export interface AdminDeps {
  flags: FlagService;
  approvals: ApprovalService;
  audit: AuditService;
  registry: ProviderRegistry;
  market: Market;
}

const approvalBody = (a: ApprovalRequest) => ({ id: a.id, kind: a.kind, subject: a.subject, status: a.status, approvals: a.approvals, requestedBy: a.requestedBy, expiresAt: new Date(a.expiresAt).toISOString(), payload: a.payload });

export function adminHandlers(d: AdminDeps): Record<string, Handler> {
  return {
    listAdminFlags: route(async (req) => {
      requireStaff(req);
      const items = await d.flags.list();
      const pending = await Promise.all(items.map(async (f) => {
        // A pending flip is an approval request on this flag whose subject carries today's date.
        const open = await d.approvals.find('flag_flip', `${f.key}:${!f.value}:${req.now.toISOString().slice(0, 10)}`);
        return open && (open.status === 'pending' || open.status === 'awaiting_second_approval') ? approvalBody(open) : undefined;
      }));
      return ok({ items: items.map((f, i) => ({ ...f, ...(pending[i] ? { pendingFlip: pending[i] } : {}) })) });
    }),

    proposeFlagFlip: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const b = req.body as { to?: unknown; reason?: unknown };
      if (typeof b.to !== 'boolean') throw new DomainError('VALIDATION_FAILED', 'to must be a boolean');
      const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
      if (!reason) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
      const r = await d.flags.propose(req.params['key'] ?? '', b.to, staffActor(p), reason, req.now);
      return { status: 201, body: approvalBody(r) };
    }),

    approveFlagFlip: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const r = await d.flags.approve(req.params['id'] ?? '', staffActor(p), req.now);
      return ok(approvalBody(r));
    }),

    listAdminBindings: route(async (req) => {
      requireStaff(req);
      return ok({
        items: PORTS.map((port) => {
          const b = d.registry.bindingFor(port.capability, d.market);
          return { capability: port.capability, port: port.port, direction: port.direction, vendors: port.vendors, flags: port.flags, market: d.market, ...(b ? { provider: b.provider, mode: b.mode } : {}) };
        }),
      });
    }),

    listAdminAudit: route(async (req) => {
      requireStaff(req);
      const subject = (req.query['subject'] ?? '').trim();
      if (!subject) throw new DomainError('VALIDATION_FAILED', 'subject is required');
      const limit = Math.min(200, Math.max(1, Number(req.query['limit'] ?? 50) || 50));
      const items = await d.audit.list(subject, limit);
      return ok({ items: items.map((e) => ({ seq: e.seq, id: e.id, at: e.at, actorId: e.actorId, actorRole: e.actorRole, action: e.action, subject: e.subject, reason: e.reason, payload: e.payload, hash: e.hash, prevHash: e.prevHash })) });
    }),

    verifyAdminAudit: route(async (req) => {
      requireStaff(req);
      return ok(await d.audit.verify());
    }),
  };
}
