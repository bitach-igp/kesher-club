// /loads (T-0501, REQ-WAL-002). The flag answers first (FEATURE_OFF, never 500), then the fresh
// step-up (REQ-AUTH-006), then the Idempotency-Key that names the LoadWorkflow. A load stays open
// during a recovery hold: money coming in is never restricted (REQ-AUTH-008).
import { DomainError } from '@kesher/domain';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { created, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';
import { WALLET_FLAG, type LoadService } from './loads.ts';

export function walletHandlers(loads: LoadService, stepUp: StepUpService, flags: FeatureFlags): Record<string, Handler> {
  return {
    createLoad: route(async (req) => {
      const p = requirePrincipal(req);
      if (!(await flags.isOn(WALLET_FLAG))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
      requireStepUp(stepUp, req);
      const key = requireIdempotencyKey(req);
      return created(await loads.request(p.partyId, req.body, key, req.now));
    }),
  };
}
