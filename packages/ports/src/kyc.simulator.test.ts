import { kycContract } from './kyc.contract.ts';
import { KycSimulator } from './kyc.simulator.ts';

kycContract('simulator', () => new KycSimulator(), {
  settle: async (port, sessionId, status) => void (port as KycSimulator).decide(sessionId, status),
  webhook: (sessionId, status, eventId) => ({ headers: { 'x-sim-signature': 'sim' }, body: { eventId, sessionId, status } }),
  outagePartyId: 'party-outage',
});
