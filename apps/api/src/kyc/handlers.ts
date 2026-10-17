// /kyc/* (T-0401): start a verification session for the signed-in member and read where it stands.
// The client token leaves in the start response and nowhere else (never in status, never logged).
import { DomainError } from '@kesher/domain';
import type { KycTier } from '@kesher/ports';
import { created, ok, requireIdempotencyKey, requirePrincipal, route, type Handler } from '../http.ts';
import type { KycService } from './service.ts';

export function kycHandlers(kyc: KycService): Record<string, Handler> {
  return {
    startKycSession: route(async (req) => {
      const p = requirePrincipal(req);
      const key = requireIdempotencyKey(req);
      const b = (req.body ?? {}) as { tier?: unknown };
      if (b.tier !== 'T1' && b.tier !== 'T2') throw new DomainError('VALIDATION_FAILED', 'tier must be T1 or T2');
      return created(await kyc.start(p.partyId, b.tier as KycTier, key, req.now));
    }),
    getKycStatus: route(async (req) => {
      const p = requirePrincipal(req);
      return ok(await kyc.status(p.partyId));
    }),
  };
}
