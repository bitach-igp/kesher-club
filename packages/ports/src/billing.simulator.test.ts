import { billingContract } from './billing.contract.ts';
import { BillingSimulator } from './billing.simulator.ts';

billingContract('simulator', () => new BillingSimulator(), {
  failedInvoiceWebhook: async (port, id) => (port as BillingSimulator).webhookFor(id, 'invoice.payment_failed'),
  declinedEmail: 'nope@declined.example',
  outageEmail: 'x@outage.example',
});
