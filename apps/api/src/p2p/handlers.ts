// /transfers (T-0505, REQ-PAY-001/002/005): the fresh step-up first (REQ-AUTH-006), then the recovery
// hold (a recovered account cannot send for 24 h), then the flag, then the Idempotency-Key that names
// the SendWorkflow. Cancelling (T-0506, REQ-PAY-003) takes back a send still in its new-pair hold.
import { DomainError } from '@kesher/domain';
import { assertNotRestricted } from '../auth/recovery.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { created, ok, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';
import type { P2pSendService } from './send.ts';

export const P2P_FLAG = 'p2p.enabled';

export function p2pHandlers(send: P2pSendService, stepUp: StepUpService, flags: FeatureFlags): Record<string, Handler> {
  return {
    createTransfer: route(async (req) => {
      const p = requirePrincipal(req);
      requireStepUp(stepUp, req);
      assertNotRestricted(p, 'p2p_send', req.now);
      if (!(await flags.isOn(P2P_FLAG))) throw new DomainError('FEATURE_OFF', 'Member transfers are not enabled yet');
      const key = requireIdempotencyKey(req);
      return created(await send.send(p.partyId, req.body, key, req.now));
    }),
    cancelTransfer: route(async (req) => {
      const p = requirePrincipal(req);
      requireIdempotencyKey(req);
      return ok(await send.cancel(p.partyId, req.params['id'] ?? '', req.now));
    }),
  };
}
