// /fx/* (T-0509, REQ-FX-001/002): a quote needs only the key; converting at it needs the fresh step-up
// too (REQ-AUTH-006) and respects the recovery hold (no FX for 24 h after a recovery sign-in).
import { assertNotRestricted } from '../auth/recovery.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import { created, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';
import type { FxService } from './service.ts';

export function fxHandlers(fx: FxService, stepUp: StepUpService): Record<string, Handler> {
  return {
    createFxQuote: route(async (req) => {
      const p = requirePrincipal(req);
      const key = requireIdempotencyKey(req);
      return created(await fx.quote(p.partyId, req.body, key, req.now));
    }),
    convert: route(async (req) => {
      const p = requirePrincipal(req);
      requireStepUp(stepUp, req);
      assertNotRestricted(p, 'fx_convert', req.now);
      const key = requireIdempotencyKey(req);
      return created(await fx.convert(p.partyId, req.body, key, req.now));
    }),
  };
}
