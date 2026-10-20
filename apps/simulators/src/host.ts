// Simulator host (T-0009): one instance of every simulator, sharing one advanceable clock, bound in a
// ProviderRegistry for both markets in `sim` mode. Control hooks let the panel (and tests) drive
// webhooks, decisions and outages without touching simulator internals from the outside.
import {
  AuthSimulator,
  BillingSimulator,
  CardIssuingSimulator,
  ConciergeSimulator,
  EsimSimulator,
  EventsSimulator,
  FederatedIdPSimulator,
  FundingSimulator,
  FxSimulator,
  IlPayInitSimulator,
  InsuranceSimulator,
  KybSimulator,
  KycSimulator,
  NotifySimulator,
  OrgIdPSimulator,
  PassSimulator,
  PayoutSimulator,
  PORTS,
  ProviderRegistry,
  WalletProvisioningSimulator,
  fixedClock,
  type AdvanceableClock,
  type Market,
  type PortDescriptor,
} from '@kesher/ports';

export const SIM_PROVIDER = 'simulator';

export interface Hook {
  /** Short description for the panel. */
  describe: string;
  /** Argument names in order; the panel renders one input per name. */
  args: readonly string[];
  run(...args: string[]): Promise<unknown> | unknown;
}

export interface Fixture {
  trigger: string;
  effect: string;
}

export interface Simulators {
  auth: AuthSimulator;
  'federated-idp': FederatedIdPSimulator;
  'org-idp': OrgIdPSimulator;
  kyc: KycSimulator;
  kyb: KybSimulator;
  billing: BillingSimulator;
  funding: FundingSimulator;
  'card-issuing': CardIssuingSimulator;
  'wallet-provisioning': WalletProvisioningSimulator;
  fx: FxSimulator;
  payout: PayoutSimulator;
  esim: EsimSimulator;
  insurance: InsuranceSimulator;
  concierge: ConciergeSimulator;
  notify: NotifySimulator;
  pass: PassSimulator;
  events: EventsSimulator;
  'il-payinit': IlPayInitSimulator;
}

export class SimulatorHost {
  readonly clock: AdvanceableClock;
  readonly registry = new ProviderRegistry();
  readonly simulators: Simulators;
  readonly startedAt: string;

  constructor(clock: AdvanceableClock = fixedClock() as AdvanceableClock) {
    this.clock = clock;
    this.startedAt = clock.now().toISOString();
    const c = clock;
    this.simulators = {
      auth: new AuthSimulator(c),
      'federated-idp': new FederatedIdPSimulator(),
      'org-idp': new OrgIdPSimulator(c),
      kyc: new KycSimulator(c),
      kyb: new KybSimulator(c),
      billing: new BillingSimulator(c),
      funding: new FundingSimulator(c),
      'card-issuing': new CardIssuingSimulator(c),
      'wallet-provisioning': new WalletProvisioningSimulator(c),
      fx: new FxSimulator(c),
      payout: new PayoutSimulator(c),
      esim: new EsimSimulator(() => c.now()),
      insurance: new InsuranceSimulator(c),
      concierge: new ConciergeSimulator(c),
      notify: new NotifySimulator(),
      pass: new PassSimulator(),
      events: new EventsSimulator(c),
      'il-payinit': new IlPayInitSimulator(c),
    };
    for (const capability of Object.keys(this.simulators) as (keyof Simulators)[]) {
      this.registry.register(capability, SIM_PROVIDER, () => this.simulators[capability]);
      for (const market of ['US', 'IL'] as Market[]) this.registry.bind({ capability, market, provider: SIM_PROVIDER, mode: 'sim' });
    }
  }

  /** Every port of the catalogue, with whether this host runs a simulator for it. */
  ports(): (PortDescriptor & { running: boolean })[] {
    return PORTS.map((p) => ({ ...p, running: p.capability in this.simulators }));
  }

  /** Deterministic fixtures documented in each simulator's header, surfaced for the panel. */
  fixtures(capability: keyof Simulators): Fixture[] {
    return FIXTURES[capability] ?? [];
  }

  /** Control hooks per simulator. The panel calls these by name. */
  hooks(capability: keyof Simulators): Record<string, Hook> {
    const s = this.simulators;
    const hooks: Partial<Record<keyof Simulators, Record<string, Hook>>> = {
      billing: {
        failInvoice: { describe: 'Signed invoice.payment_failed webhook for a subscription (drives dunning)', args: ['subscriptionId', 'attempt'], run: (id, attempt) => s.billing.webhookFor(id, 'invoice.payment_failed', Number(attempt || 1)) },
        payInvoice: { describe: 'Signed invoice.paid webhook', args: ['subscriptionId'], run: (id) => s.billing.webhookFor(id, 'invoice.paid') },
      },
      kyc: {
        decide: { describe: 'Settle a KYC session (status: approved | rejected | review)', args: ['sessionId', 'status'], run: (id, status) => s.kyc.decide(id, (status || undefined) as 'approved' | 'rejected' | 'review' | undefined) },
      },
      funding: {
        settle: { describe: 'Signed webhook that settles or fails a load', args: ['loadId', 'status'], run: (id, status) => s.funding.webhookFor(id, (status || 'succeeded') as 'succeeded' | 'failed') },
      },
      'card-issuing': {
        authorize: { describe: 'Signed JIT authorisation for a card (amount in minor USD)', args: ['cardId', 'amountMinor', 'mcc'], run: (cardId, amountMinor, mcc) => s['card-issuing'].authorize(cardId, { amount: { minor: BigInt(amountMinor || '0'), currency: 'USD' }, merchant: { name: 'Cofix', mcc: mcc || '5814', country: 'IL' }, channel: 'pos' }) },
      },
      'wallet-provisioning': {
        tokenEvent: { describe: 'Token lifecycle webhook (status: active | suspended | deleted)', args: ['tokenId', 'status'], run: (id, status) => s['wallet-provisioning'].tokenEvent(id, (status || 'deleted') as 'active' | 'suspended' | 'deleted') },
      },
      payout: {
        nextWebhook: { describe: 'Next status webhook for a payout (FAIL payees fail)', args: ['payoutId'], run: (id) => s.payout.nextWebhook(id) },
      },
      esim: {
        setUsage: { describe: 'Push usage (MB) on an ICCID to trigger low-data alerts', args: ['iccid', 'usedMb'], run: (iccid, used) => s.esim.setUsage(iccid, Number(used)) },
      },
      concierge: {
        resolve: { describe: 'Partner replies and resolves a case', args: ['caseId', 'reply'], run: (id, reply) => s.concierge.resolve(id, reply) },
      },
      events: {
        runRetries: { describe: 'Run every due webhook retry', args: [], run: () => s.events.runRetries() },
      },
      'il-payinit': {
        bankCallback: { describe: "The bank's callback after the payer acts", args: ['paymentId'], run: (id) => s['il-payinit'].bankCallback(id) },
      },
    };
    return hooks[capability] ?? {};
  }

  advanceClock(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance takes a non-negative number of milliseconds');
    this.clock.advance(ms);
    return this.clock.now().toISOString();
  }
}

const FIXTURES: Partial<Record<keyof Simulators, Fixture[]>> = {
  auth: [
    { trigger: 'phone +15550000001', effect: 'PROVIDER_UNAVAILABLE on startOtp' },
    { trigger: 'any other phone', effect: 'OTP code 246810' },
  ],
  'federated-idp': [
    { trigger: 'code ok:<subject>', effect: 'verified identity' },
    { trigger: 'code ok:<subject>:relay', effect: 'Apple private-relay email' },
    { trigger: 'code outage', effect: 'PROVIDER_UNAVAILABLE' },
  ],
  'org-idp': [
    { trigger: 'org org_outage', effect: 'PROVIDER_UNAVAILABLE' },
    { trigger: 'SCIM bearer scim_<orgId>', effect: 'accepted' },
  ],
  kyc: [
    { trigger: 'partyId ending -reject / -review / -outage', effect: 'rejected / review / PROVIDER_UNAVAILABLE' },
  ],
  kyb: [
    { trigger: 'identifier ending 000 / 111 / 222 / 444 / 999', effect: 'struck off / another registered name / no exempt record / revoked / PROVIDER_UNAVAILABLE' },
    { trigger: 'name containing Sanctioned / Exposed', effect: 'OFAC SDN match / PEP match' },
  ],
  billing: [
    { trigger: 'email @declined.example', effect: 'CARD_DECLINED on subscribe' },
    { trigger: 'email @outage.example', effect: 'PROVIDER_UNAVAILABLE' },
  ],
  funding: [
    { trigger: 'paymentMethodId pm_declined / pm_outage', effect: 'DECLINED / PROVIDER_UNAVAILABLE' },
    { trigger: 'method ach', effect: 'on_hold for 3 business days' },
  ],
  'card-issuing': [{ trigger: 'kycSessionId kyc_outage', effect: 'PROVIDER_UNAVAILABLE' }],
  'wallet-provisioning': [{ trigger: 'deviceId dev_outage', effect: 'PROVIDER_UNAVAILABLE' }],
  fx: [
    { trigger: 'from.minor 999999', effect: 'PROVIDER_UNAVAILABLE at convert' },
    { trigger: 'quote older than 30 s', effect: 'QUOTE_EXPIRED' },
  ],
  payout: [{ trigger: 'payee name FAIL / OUTAGE / WRONG NAME', effect: 'failed webhook / PROVIDER_UNAVAILABLE / NAME_MISMATCH' }],
  esim: [{ trigger: 'sku IL-FAIL', effect: 'PROVIDER_UNAVAILABLE' }],
  insurance: [{ trigger: 'product outage', effect: 'PROVIDER_UNAVAILABLE' }],
  concierge: [{ trigger: 'summary starting OUTAGE', effect: 'PROVIDER_UNAVAILABLE' }],
  notify: [
    { trigger: 'to +15550000001 or outage@example.com', effect: 'PROVIDER_UNAVAILABLE' },
    { trigger: 'to bounce@example.com', effect: 'failed INVALID_RECIPIENT' },
  ],
  pass: [{ trigger: 'memberId m_outage', effect: 'PROVIDER_UNAVAILABLE' }],
  events: [
    { trigger: 'endpoint url containing /fail', effect: '500 on every delivery (retry ladder)' },
    { trigger: 'endpoint url containing /outage', effect: 'PROVIDER_UNAVAILABLE' },
  ],
  'il-payinit': [{ trigger: 'bankCode 000 / reference REJECT…', effect: 'PROVIDER_UNAVAILABLE / rejected' }],
};
