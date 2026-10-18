// /transfers (T-0505, REQ-PAY-001/002/005): the fresh step-up first (REQ-AUTH-006), then the recovery
// hold (a recovered account cannot send for 24 h), then the flag, then the Idempotency-Key that names
// the SendWorkflow. Cancelling (T-0506, REQ-PAY-003) takes back a send still in its new-pair hold. Requests
// and splits (T-0507, REQ-PAY-004) need only the key; paying one is a send and needs the step-up too.
// The preview (T-0518, REQ-PAY-006) moves nothing, so it needs the bearer and the flag only.
import { DomainError } from '@kesher/domain';
import { assertNotRestricted } from '../auth/recovery.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { created, ok, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';
import type { PaymentRequestService } from './requests.ts';
import type { P2pSendService } from './send.ts';

export const P2P_FLAG = 'p2p.enabled';

export function p2pHandlers(send: P2pSendService, stepUp: StepUpService, flags: FeatureFlags, requests: PaymentRequestService): Record<string, Handler> {
  const gate = async () => {
    if (!(await flags.isOn(P2P_FLAG))) throw new DomainError('FEATURE_OFF', 'Member transfers are not enabled yet');
  };
  return {
    listPaymentRequests: route(async (req) => {
      const p = requirePrincipal(req);
      await gate();
      return ok(await requests.inbox(p.partyId, req.now));
    }),
    createPaymentRequest: route(async (req) => {
      const p = requirePrincipal(req);
      await gate();
      return created(await requests.create(p.partyId, req.body, requireIdempotencyKey(req), req.now));
    }),
    createSplit: route(async (req) => {
      const p = requirePrincipal(req);
      await gate();
      return created(await requests.split(p.partyId, req.body, requireIdempotencyKey(req), req.now));
    }),
    payPaymentRequest: route(async (req) => {
      const p = requirePrincipal(req);
      requireStepUp(stepUp, req);
      assertNotRestricted(p, 'p2p_send', req.now);
      await gate();
      requireIdempotencyKey(req);
      return ok(await requests.pay(p.partyId, req.params['id'] ?? '', req.now));
    }),
    declinePaymentRequest: route(async (req) => {
      const p = requirePrincipal(req);
      await gate();
      requireIdempotencyKey(req);
      return ok(await requests.decline(p.partyId, req.params['id'] ?? '', req.now));
    }),
    cancelPaymentRequest: route(async (req) => {
      const p = requirePrincipal(req);
      await gate();
      requireIdempotencyKey(req);
      return ok(await requests.cancel(p.partyId, req.params['id'] ?? '', req.now));
    }),
    createTransfer: route(async (req) => {
      const p = requirePrincipal(req);
      requireStepUp(stepUp, req);
      assertNotRestricted(p, 'p2p_send', req.now);
      if (!(await flags.isOn(P2P_FLAG))) throw new DomainError('FEATURE_OFF', 'Member transfers are not enabled yet');
      const key = requireIdempotencyKey(req);
      return created(await send.send(p.partyId, req.body, key, req.now));
    }),
    previewTransfer: route(async (req) => {
      const p = requirePrincipal(req);
      assertNotRestricted(p, 'p2p_send', req.now);
      await gate();
      return ok(await send.preview(p.partyId, req.body, req.now));
    }),
    cancelTransfer: route(async (req) => {
      const p = requirePrincipal(req);
      requireIdempotencyKey(req);
      return ok(await send.cancel(p.partyId, req.params['id'] ?? '', req.now));
    }),
  };
}
