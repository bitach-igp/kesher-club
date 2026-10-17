// /cards/* (T-0402, T-0404, T-0405) and the processor's JIT call (T-0403). A member reads their own card:
// status, controls and wallet tokens only, never PAN, CVV or expiry. Controls are patched by the
// member or the funder; a funder-set key is locked for the member (REQ-CRD-005). The authorisation path is public to the
// bearer middleware and authenticated by the processor's signature inside the port.
import { DomainError } from '@kesher/domain';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import { ok, requireIdempotencyKey, requirePrincipal, route, type Handler, type HttpRequest } from '../http.ts';
import type { ControlsPatch } from './controls.ts';
import type { ProvisioningService, Wallet } from './provisioning.ts';
import type { JitService } from './jit.ts';
import type { CardService } from './service.ts';

export function cardHandlers(cards: CardService, jit: JitService, provisioning: ProvisioningService, stepUp: StepUpService): Record<string, Handler> {
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
      return ok(card);
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
