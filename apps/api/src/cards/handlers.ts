// /cards/* (T-0402): a member reads their own card. Status, controls and wallet tokens only; the
// response never carries PAN, CVV or expiry, and the details token has its own path (contract pending).
import { DomainError } from '@kesher/domain';
import { ok, requirePrincipal, route, type Handler } from '../http.ts';
import type { CardService } from './service.ts';

export function cardHandlers(cards: CardService): Record<string, Handler> {
  return {
    getCard: route(async (req) => {
      const p = requirePrincipal(req);
      const card = await cards.getCard(p.partyId, req.params['id'] ?? '');
      if (!card) throw new DomainError('NOT_FOUND', 'Card not found');
      return ok(card);
    }),
  };
}
