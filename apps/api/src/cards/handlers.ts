// /cards/* (T-0402) and the processor's JIT call (T-0403). A member reads their own card: status,
// controls and wallet tokens only, never PAN, CVV or expiry. The authorisation path is public to the
// bearer middleware and authenticated by the processor's signature inside the port.
import { DomainError } from '@kesher/domain';
import { ok, requirePrincipal, route, type Handler, type HttpRequest } from '../http.ts';
import type { JitService } from './jit.ts';
import type { CardService } from './service.ts';

export function cardHandlers(cards: CardService, jit: JitService): Record<string, Handler> {
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
  };
}
