import { cardIssuingContract } from './card-issuing.contract.ts';
import { CardIssuingSimulator } from './card-issuing.simulator.ts';

cardIssuingContract('simulator', () => new CardIssuingSimulator(), {
  kycSessionId: 'kyc_000001',
  outageKycSessionId: 'kyc_outage',
  jitRequest: async (port, cardId, amountMinor, extra) =>
    (port as CardIssuingSimulator).authorize(cardId, {
      amount: { minor: amountMinor, currency: 'USD' },
      merchant: { name: 'Cofix', mcc: '5814', country: 'IL' },
      channel: 'pos',
      ...extra,
    }),
});
