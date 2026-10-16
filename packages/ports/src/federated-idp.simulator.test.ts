import { describe, expect, it } from 'vitest';
import { federatedIdPContract } from './federated-idp.contract.ts';
import { FederatedIdPSimulator } from './federated-idp.simulator.ts';

federatedIdPContract('simulator', () => new FederatedIdPSimulator(), {
  goodCode: 'ok:noa',
  relayCode: 'ok:noa:relay',
  badCode: 'nope',
  outageCode: 'outage',
});

describe('FederatedIdPSimulator specifics', () => {
  it('rejects a token whose nonce differs from the one issued', async () => {
    const sim = new FederatedIdPSimulator();
    await expect(sim.exchangeCode('google', { code: 'ok:noa:nonce=other', nonce: 'n1', redirectUri: 'https://x' })).rejects.toMatchObject({ code: 'NONCE_MISMATCH' });
  });
});
