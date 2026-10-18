// /payouts (T-0510, REQ-PO-001/002): the fresh step-up first (REQ-AUTH-006), then the recovery hold
// (no payouts, and no new payees, for 24 h after a recovery sign-in), then the flag inside the service,
// then the Idempotency-Key that names the PayoutWorkflow.
import { assertNotRestricted } from '../auth/recovery.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import { created, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';
import type { PayoutService } from './service.ts';

export function payoutHandlers(payouts: PayoutService, stepUp: StepUpService): Record<string, Handler> {
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
  };
}
