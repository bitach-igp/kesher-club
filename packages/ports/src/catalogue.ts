// The authoritative list of ports (Tab 3 §4): name, direction, contract suite and gating flags.
// The admin Providers & Flags screen, the simulator host and the registry all read this table.

export type PortDirection = 'out' | 'in' | 'out+in';

export interface PortDescriptor {
  readonly capability: string;
  readonly port: string;
  readonly direction: PortDirection;
  readonly simulator: boolean;
  readonly contract: string;
  readonly flags: readonly string[];
  readonly vendors: readonly string[];
}

export const PORTS: readonly PortDescriptor[] = [
  { capability: 'auth', port: 'AuthPort', direction: 'out', simulator: true, contract: 'auth.contract.ts', flags: ['auth.passkey.primary'], vendors: ['simplewebauthn', 'twilio-verify'] },
  { capability: 'federated-idp', port: 'FederatedIdPPort', direction: 'out', simulator: true, contract: 'federated-idp.contract.ts', flags: ['auth.social.enabled'], vendors: ['apple', 'google'] },
  { capability: 'org-idp', port: 'OrgIdPPort', direction: 'out', simulator: true, contract: 'org-idp.contract.ts', flags: ['auth.orgSso'], vendors: ['workos', 'clerk'] },
  { capability: 'kyc', port: 'KycPort', direction: 'out', simulator: true, contract: 'kyc.contract.ts', flags: ['kyc.mdl'], vendors: ['issuer-kyc'] },
  { capability: 'billing', port: 'BillingPort', direction: 'out', simulator: true, contract: 'billing.contract.ts', flags: ['billing.stripe', 'billing.applePay', 'billing.googlePay'], vendors: ['stripe'] },
  { capability: 'funding', port: 'FundingPort', direction: 'out', simulator: true, contract: 'funding.contract.ts', flags: ['wallet.enabled', 'funding.ach', 'funding.rtp'], vendors: ['stripe', 'plaid'] },
  { capability: 'card-issuing', port: 'CardIssuingPort', direction: 'out+in', simulator: true, contract: 'card-issuing.contract.ts', flags: ['card.virtual', 'card.physical', 'card.agentic', 'card.paymentPasskey'], vendors: ['marqeta', 'galileo', 'i2c'] },
  { capability: 'wallet-provisioning', port: 'WalletProvisioningPort', direction: 'out', simulator: true, contract: 'wallet-provisioning.contract.ts', flags: ['card.pushProvisioning', 'card.webPushProvisioning'], vendors: ['processor'] },
  { capability: 'fx', port: 'FxPort', direction: 'out', simulator: true, contract: 'fx.contract.ts', flags: ['fx.enabled'], vendors: ['processor', 'nium'] },
  { capability: 'payout', port: 'PayoutPort', direction: 'out', simulator: true, contract: 'payout.contract.ts', flags: ['payouts.nium'], vendors: ['nium'] },
  { capability: 'esim', port: 'EsimPort', direction: 'out', simulator: true, contract: 'esim.contract.ts', flags: ['esim.airalo', 'esim.holafly'], vendors: ['airalo', 'holafly'] },
  { capability: 'insurance', port: 'InsurancePort', direction: 'out', simulator: true, contract: 'insurance.contract.ts', flags: ['insurance.coverGenius'], vendors: ['cover-genius'] },
  { capability: 'concierge', port: 'ConciergePort', direction: 'out', simulator: true, contract: 'concierge.contract.ts', flags: ['concierge.partner'], vendors: ['partner-api', 'email-bridge'] },
  { capability: 'notify', port: 'NotifyPort', direction: 'out', simulator: true, contract: 'notify.contract.ts', flags: ['notify.whatsapp'], vendors: ['expo-push', 'postmark', 'twilio', 'whatsapp'] },
  { capability: 'pass', port: 'PassPort', direction: 'out', simulator: true, contract: 'pass.contract.ts', flags: ['wallet.pass'], vendors: ['apple-passkit', 'google-wallet'] },
  { capability: 'events', port: 'EventsPort', direction: 'out', simulator: true, contract: 'events.contract.ts', flags: ['webhooks.outbound'], vendors: ['svix', 'in-house'] },
  { capability: 'agent-gateway', port: 'AgentGateway', direction: 'in', simulator: false, contract: 'agent-gateway.contract.ts', flags: ['mcp.enabled', 'mcp.write.enabled', 'mcp.money.propose'], vendors: ['in-house'] },
  { capability: 'il-payinit', port: 'IlPayInitPort', direction: 'out', simulator: true, contract: 'il-payinit.contract.ts', flags: ['il.payinit'], vendors: ['licensed-pisp'] },
];

export const portByCapability = (capability: string): PortDescriptor | undefined => PORTS.find((p) => p.capability === capability);
