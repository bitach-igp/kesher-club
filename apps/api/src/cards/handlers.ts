// /cards/* (T-0402, T-0404, T-0405, T-0407) and the processor's JIT call (T-0403). A member reads their own card:
// status, controls and wallet tokens only, never PAN, CVV or expiry. Controls are patched by the
// member or the funder; a funder-set key is locked for the member (REQ-CRD-005). The authorisation path is public to the
// bearer middleware and authenticated by the processor's signature inside the port.
import { DomainError } from '@kesher/domain';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import { ok, requireIdempotencyKey, requirePrincipal, route, type Handler, type HttpRequest } from '../http.ts';
import type { ControlsPatch } from './controls.ts';
import { parseShipTo, type CloseReason, type PhysicalCardService } from './physical.ts';
import type { ProvisioningService, Wallet } from './provisioning.ts';
import type { JitService } from './jit.ts';
import type { CardService } from './service.ts';

export function cardHandlers(cards: CardService, jit: JitService, provisioning: ProvisioningService, stepUp: StepUpService, physical: PhysicalCardService): Record<string, Handler> {
  const viewFor = (card: { id: string; type: string }, partyId: string) => (card.type === 'physical' ? physical.view(card.id, partyId) : Promise.resolve(card));
  return {
    cardAuthorization: route(async (req: HttpRequest) => {
      const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null));
      const r = await jit.handle(req.headers, rawBody, req.now);
      return { status: r.status, body: r.body };
    }),
    getCard: route(async (req) => {
      const p = requirePrincipal(req);
      const card = await cards.getCard(p.partyId, req.params['id'] ?? '');
      if (!card) throw new DomainError('NOT_FOUND', 'Card not found');
      return ok(card.type === 'physical' ? await physical.view(card.id, p.partyId) : card);
    }),
    listCards: route(async (req) => {
      const p = requirePrincipal(req);
      const items = await cards.forParty(p.partyId);
      return ok({ items: await Promise.all(items.map((c) => (c.type === 'physical' ? physical.view(c.id, p.partyId) : Promise.resolve(c)))) });
    }),
    orderPhysicalCard: route(async (req) => {
      const p = requirePrincipal(req);
      const key = requireIdempotencyKey(req);
      const b = (req.body ?? {}) as { shipTo?: unknown };
      return { status: 201, body: await physical.order(p.partyId, parseShipTo(b.shipTo), key, req.now) };
    }),
    activateCard: route(async (req) => {
      const p = requirePrincipal(req);
      const key = requireIdempotencyKey(req);
      requireStepUp(stepUp, req);
      const b = (req.body ?? {}) as { last4?: unknown };
      if (typeof b.last4 !== 'string') throw new DomainError('VALIDATION_FAILED', 'last4 is required');
      return ok(await physical.activate(p.partyId, req.params['id'] ?? '', b.last4, key, req.now));
    }),
    setCardStatus: route(async (req) => {
      const p = requirePrincipal(req);
      const key = requireIdempotencyKey(req);
      const b = (req.body ?? {}) as { status?: unknown; reason?: unknown };
      const id = req.params['id'] ?? '';
      if (b.status === 'frozen') return ok(await viewFor(await cards.setStatus(p.partyId, id, 'frozen', key, req.now), p.partyId));
      // Unfreezing and closing move money's exposure the other way: both need a fresh step-up.
      requireStepUp(stepUp, req);
      if (b.status === 'active') return ok(await viewFor(await cards.setStatus(p.partyId, id, 'active', key, req.now), p.partyId));
      if (b.status === 'closed') {
        const reasons: readonly string[] = ['lost', 'stolen', 'damaged', 'other'];
        const reason = typeof b.reason === 'string' && reasons.includes(b.reason) ? (b.reason as CloseReason) : 'other';
        return ok(await physical.close(p.partyId, id, reason, key, req.now));
      }
      throw new DomainError('VALIDATION_FAILED', 'status must be frozen, active or closed');
    }),
    cardDetailsToken: route(async (req) => {
      const p = requirePrincipal(req);
      requireStepUp(stepUp, req);
      return ok(await cards.detailsToken(p.partyId, req.params['id'] ?? ''));
    }),
    startPushProvisioning: route(async (req) => {
      const p = requirePrincipal(req);
      requireIdempotencyKey(req);
      requireStepUp(stepUp, req);
      const b = (req.body ?? {}) as { deviceId?: unknown; clientData?: unknown };
      if (typeof b.deviceId !== 'string') throw new DomainError('VALIDATION_FAILED', 'deviceId is required');
      const clientData = b.clientData && typeof b.clientData === 'object' && !Array.isArray(b.clientData) ? Object.fromEntries(Object.entries(b.clientData as Record<string, unknown>).filter(([, v]) => typeof v === 'string') as [string, string][]) : undefined;
      if (!clientData) throw new DomainError('VALIDATION_FAILED', 'clientData must be an object of strings');
      return ok(await provisioning.start(p.partyId, req.params['id'] ?? '', req.params['wallet'] as Wallet, b.deviceId, clientData));
    }),
    updateCardControls: route(async (req) => {
      const p = requirePrincipal(req);
      const key = requireIdempotencyKey(req);
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new DomainError('VALIDATION_FAILED', 'A controls patch is required');
      return ok(await cards.updateControls(p.partyId, req.params['id'] ?? '', req.body as ControlsPatch, key, req.now));
    }),
  };
}
