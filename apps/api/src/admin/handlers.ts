// /admin/* handlers (T-0906, T-0907, T-0908, ADR-013): flags with the two-person flip, provider
// bindings, audit, customer search and the Customer 360 read model, complaints and alerts.
// Every handler needs a staff principal; the services do the real work and the auditing.
import { PORTS, type Market, type ProviderRegistry } from '@kesher/ports';
import { DomainError } from '@kesher/domain';
import type { ApprovalRequest, ApprovalService } from '../approvals/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { FlagService } from '../flags/service.ts';
import { ok, route, type Handler } from '../http.ts';
import type { AlertService, Disposition } from './alerts.ts';
import type { ComplaintChannel, ComplaintService } from './complaints.ts';
import type { CustomerReadModel } from './customers.ts';
import { requireStaff, staffActor } from './staff-token.ts';

export interface AdminDeps {
  flags: FlagService;
  approvals: ApprovalService;
  audit: AuditService;
  registry: ProviderRegistry;
  market: Market;
  customers: CustomerReadModel;
  complaints: ComplaintService;
  alerts: AlertService;
}

/** Staff identity for the complaint and alert services: SSO subject for stamps, party id and role for the audit chain. */
const staffSubject = (p: ReturnType<typeof requireStaff>) => ({ subject: p.subject ?? p.partyId, partyId: p.partyId, role: 'admin' });

const approvalBody = (a: ApprovalRequest) => ({ id: a.id, kind: a.kind, subject: a.subject, status: a.status, approvals: a.approvals, requestedBy: a.requestedBy, expiresAt: new Date(a.expiresAt).toISOString(), payload: a.payload });

export function adminHandlers(d: AdminDeps): Record<string, Handler> {
  return {
    listAdminFlags: route(async (req) => {
      requireStaff(req);
      const items = await d.flags.list();
      const pending = await Promise.all(items.map(async (f) => {
        const open = await d.flags.pendingFlip(f.key, !f.value, req.now);
        return open ? approvalBody(open) : undefined;
      }));
      return ok({ items: items.map((f, i) => ({ ...f, ...(pending[i] ? { pendingFlip: pending[i] } : {}) })) });
    }),

    proposeFlagFlip: route(async (req) => {
      const p = requireStaff(req, 'admin');
      const b = req.body as { to?: unknown; reason?: unknown; incident?: unknown };
      if (typeof b.to !== 'boolean') throw new DomainError('VALIDATION_FAILED', 'to must be a boolean');
      const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
      if (!reason) throw new DomainError('VALIDATION_FAILED', 'A reason is required');
      const r = await d.flags.propose(req.params['key'] ?? '', b.to, staffActor(p), reason, req.now, b.incident);
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

    listAdminCustomers: route(async (req) => {
      requireStaff(req);
      const q = (req.query['q'] ?? '').trim();
      if (!q || q.length > 200) throw new DomainError('VALIDATION_FAILED', 'q must be 1 to 200 characters');
      return ok({ items: await d.customers.search(q) });
    }),

    getAdminCustomer: route(async (req) => {
      requireStaff(req);
      const c = await d.customers.get(req.params['id'] ?? '');
      if (!c) throw new DomainError('NOT_FOUND', 'Customer not found');
      return ok(c);
    }),

    listAdminComplaints: route(async (req) => {
      requireStaff(req);
      return ok({ items: await d.complaints.list() });
    }),

    openAdminComplaint: route(async (req) => {
      const p = requireStaff(req);
      const b = req.body as { partyId?: unknown; channel?: unknown; category?: unknown; summary?: unknown; escalatedToBank?: unknown; openedAt?: unknown };
      if (typeof b.partyId !== 'string' || typeof b.channel !== 'string' || typeof b.category !== 'string' || typeof b.summary !== 'string') throw new DomainError('VALIDATION_FAILED', 'partyId, channel, category and summary are required');
      if (b.escalatedToBank !== undefined && typeof b.escalatedToBank !== 'boolean') throw new DomainError('VALIDATION_FAILED', 'escalatedToBank must be a boolean');
      const openedAt = b.openedAt === undefined ? undefined : new Date(String(b.openedAt));
      if (openedAt && Number.isNaN(openedAt.getTime())) throw new DomainError('VALIDATION_FAILED', 'openedAt must be a date-time');
      const c = await d.complaints.open({ partyId: b.partyId, channel: b.channel as ComplaintChannel, category: b.category, summary: b.summary, ...(b.escalatedToBank !== undefined ? { escalatedToBank: b.escalatedToBank } : {}), ...(openedAt ? { openedAt } : {}) }, staffSubject(p), req.now);
      return { status: 201, body: c };
    }),

    acknowledgeAdminComplaint: route(async (req) => {
      const p = requireStaff(req);
      return ok(await d.complaints.acknowledge(req.params['id'] ?? '', staffSubject(p), req.now));
    }),

    resolveAdminComplaint: route(async (req) => {
      const p = requireStaff(req);
      return ok(await d.complaints.resolve(req.params['id'] ?? '', staffSubject(p), req.now));
    }),

    listAdminAlerts: route(async (req) => {
      requireStaff(req);
      return ok({ items: await d.alerts.list() });
    }),

    decideAdminAlert: route(async (req) => {
      const p = requireStaff(req);
      const b = req.body as { decision?: unknown; note?: unknown };
      if (typeof b.decision !== 'string' || typeof b.note !== 'string') throw new DomainError('VALIDATION_FAILED', 'decision and note are required');
      return ok(await d.alerts.decide(req.params['id'] ?? '', b.decision as Disposition, b.note, staffSubject(p), req.now));
    }),
  };
}
