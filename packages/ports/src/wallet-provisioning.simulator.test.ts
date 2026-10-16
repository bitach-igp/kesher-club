import { walletProvisioningContract } from './wallet-provisioning.contract.ts';
import { WalletProvisioningSimulator } from './wallet-provisioning.simulator.ts';

walletProvisioningContract('simulator', () => new WalletProvisioningSimulator(), {
  cardId: 'card_000001',
  appleClientData: { certificates: 'MIIB...', nonce: 'bm9uY2U=', nonceSignature: 'c2ln' },
  deletedTokenWebhook: async (port, tokenId) => (port as WalletProvisioningSimulator).tokenEvent(tokenId, 'deleted'),
  outageDeviceId: 'dev_outage',
});
