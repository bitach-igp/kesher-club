// Composition root: builds every service against a Database and a ProviderRegistry (simulators
// in sim mode) and returns the handler table. The HTTP server (server.ts) and tests call this;
// nothing here knows about sockets. Secrets arrive through the config loader (T-0004).
import type { Database } from './db.ts';
import type { AuthPort, BillingPort, CardIssuingPort, EventsPort, FundingPort, FxPort, PayoutPort, KycPort, NotifyPort, ProviderRegistry, Market } from '@kesher/ports';
import { ok, requireIdempotencyKey, requirePrincipal, route, type Handler, type HttpRequest } from './http.ts';
import { authHandlers, bearerMiddleware } from './auth/handlers.ts';
import { adminHandlers } from './admin/handlers.ts';
import { fxAdminHandlers } from './fx/admin.ts';
import { PreferenceService, preferenceHandlers } from './me/preferences.ts';
import { RateService } from './fx/rates.ts';
import { cardHandlers } from './cards/handlers.ts';
import { CardService } from './cards/service.ts';
import { JitService } from './cards/jit.ts';
import { PhysicalCardService } from './cards/physical.ts';
import { detailsTokenProvisioning, ProvisioningService, TOKEN_EVENT_PROVIDER } from './cards/provisioning.ts';
import { fxHandlers } from './fx/handlers.ts';
import { FxService } from './fx/service.ts';
import { kycHandlers } from './kyc/handlers.ts';
import { p2pHandlers } from './p2p/handlers.ts';
import { P2pHoldService } from './p2p/holds.ts';
import { P2pLimitService } from './p2p/limits.ts';
import { payoutHandlers } from './payouts/handlers.ts';
import { PAYOUT_PROVIDER, PayoutService } from './payouts/service.ts';
import { PaymentRequestService } from './p2p/requests.ts';
import { P2pSendService } from './p2p/send.ts';
import { KycService } from './kyc/service.ts';
import { CustomerReadModel } from './admin/customers.ts';
import { ComplaintService } from './admin/complaints.ts';
import { AlertService } from './admin/alerts.ts';
import { StaffTokenVerifier, staffBearerMiddleware } from './admin/staff-token.ts';
import type { JWK } from 'jose';
import { OtpService } from './auth/otp.ts';
import { PasskeyService } from './auth/passkeys.ts';
import { RecoveryService } from './auth/recovery.ts';
import { InMemoryIdentityRepository, type IdentityRepository } from './auth/repository.ts';
import { StepUpService } from './auth/step-up.ts';
import { TokenService, type SigningKey } from './auth/tokens.ts';
import { AccountService } from './ledger/accounts.ts';
import { PostgresLedger } from './ledger/post.ts';
import { PlanService } from './billing/plans.ts';
import { EntitlementService } from './billing/entitlements.ts';
import { MembershipService } from './billing/memberships.ts';
import { capabilitiesHandler, type FeatureFlags } from './billing/capabilities.ts';
import { statusHandler } from './status/handler.ts';
import { TransferService } from './transfers/service.ts';
import { AutoReloadService } from './wallet/auto-reload.ts';
import { ClosureService } from './wallet/closure.ts';
import { walletHandlers } from './wallet/handlers.ts';
import { FUNDING_PROVIDER, LoadService } from './wallet/loads.ts';
import { AddonOrderService } from './addons/orders.ts';
import { CreditService } from './addons/credit.ts';
import { CollectionsService, collectionsHandlers } from './institutions/collections.ts';
import { allowanceRunHandlers } from './institutions/allowance-runs.ts';
import { PostgresAllowanceActivities } from './institutions/allowance/activities.ts';
import { exportHandler } from './institutions/export.ts';
import { RosterService, importRosterHandler } from './institutions/roster.ts';
import { ApprovalService } from './approvals/service.ts';
import { AuditService } from './audit/service.ts';
import { FlagService } from './flags/service.ts';
import { IntentService } from './intents/service.ts';
import { WebhookRouter } from './webhooks/handler.ts';
import { InboundEventStore } from './webhooks/store.ts';
import { simulatorVerifier } from './webhooks/verify.ts';
import { OutboundEventsService } from './events/outbound.ts';
import { ROUTES, type HandlerTable } from './routes.ts';
import { toWire, DomainError } from '@kesher/domain';

export interface AppOptions {
  db: Database;
  registry: ProviderRegistry;
  market: Market;
  signingKey: SigningKey;
  issuer: string;
  identity?: IdentityRepository;
  clock?: () => Date;
  /** Public JWKS of the admin console's staff-token key (ADR-013). Without it every /admin/* call is 401. */
  staffJwks?: readonly JWK[];
  /** Feature flags; defaults to the two-person-approved store (FlagService). Tests inject StaticFlags. */
  flags?: FeatureFlags;
}

export interface App {
  handlers: HandlerTable;
  authenticate: (req: HttpRequest) => Promise<HttpRequest>;
  services: ReturnType<typeof buildServices>;
}

function buildServices(o: AppOptions) {
  const clock = { now: o.clock ?? (() => new Date()) };
  const identity = o.identity ?? new InMemoryIdentityRepository();
  const authPort = o.registry.resolve<AuthPort>('auth', o.market);
  const billingPort = o.registry.resolve<BillingPort>('billing', o.market);
  const notifyPort = o.registry.resolve<NotifyPort>('notify', o.market);
  const eventsPort = o.registry.resolve<EventsPort>('events', o.market);

  const tokens = new TokenService(identity, o.signingKey, { issuer: o.issuer, audience: o.issuer, clock });
  const otp = new OtpService(authPort, identity, clock);
  const passkeys = new PasskeyService(authPort, identity, tokens, clock, otp);
  const stepUp = new StepUpService(authPort, identity, clock);
  const recovery = new RecoveryService(identity, otp, passkeys, tokens, notifyPort, clock);
  const ledger = new PostgresLedger(o.db);
  const accounts = new AccountService(o.db, ledger);
  const plans = new PlanService(o.db);
  const entitlements = new EntitlementService(o.db, plans);
  const memberships = new MembershipService(o.db, plans, billingPort);
  const transfers = new TransferService(o.db, o.market);
  const approvals = new ApprovalService(o.db);
  const audit = new AuditService(o.db);
  const flags: FeatureFlags = o.flags ?? new FlagService(o.db, approvals, audit);
  const orders = new AddonOrderService(o.db, ledger, accounts, new CreditService(entitlements), o.market);
  const roster = new RosterService(o.db);
  const inbound = new InboundEventStore(o.db, o.market);
  const webhooks = new WebhookRouter(inbound);
  const kyc = new KycService(o.db, o.registry.resolve<KycPort>('kyc', o.market), o.market, o.registry.bindingFor('kyc', o.market)?.provider ?? 'issuer-kyc');
  const cardIssuing = o.registry.resolve<CardIssuingPort>('card-issuing', o.market);
  const cards = new CardService(o.db, cardIssuing, kyc, flags, o.registry.bindingFor('card-issuing', o.market)?.provider ?? 'simulator');
  // Club rates (REQ-FX-003) price every conversion: a card purchase the other purse pays (T-0409), a load into
  // the other purse (REQ-WAL-006), a converted send (REQ-PAY-006) and the convert screen.
  const rates = new RateService(o.db, approvals, audit);
  const fx = new FxService({ db: o.db, port: o.registry.resolve<FxPort>('fx', o.market), rates, ledger, accounts, transfers, memberships, plans, flags });
  const provisioning = new ProvisioningService(o.db, cards, detailsTokenProvisioning(cardIssuing), flags);
  const physical = new PhysicalCardService(o.db, cardIssuing, kyc, cards, flags, o.registry.bindingFor('card-issuing', o.market)?.provider ?? 'simulator');
  // The processor's token lifecycle events land on /hooks/card-issuing and are applied at receipt; the
  // worker's token-events job sweeps anything left pending within its cycle (REQ-CRD-007).
  webhooks.bind(TOKEN_EVENT_PROVIDER, { verifier: ProvisioningService.verifier(o.registry.bindingFor('card-issuing', o.market)?.mode), process: (e) => provisioning.applyTokenEvent(e, clock.now()).then(() => undefined) });
  // The KYC provider's decisions arrive on /hooks/kyc; the port verifies and parses, the service applies,
  // and a T2 approval issues the virtual card while card.virtual is on (REQ-CRD-001). A processor failure
  // leaves the event unprocessed so replay retries it; both steps are idempotent.
  webhooks.bind('kyc', {
    verifier: kyc.webhookVerifier(),
    process: async (e) => {
      await kyc.applyDecision(e);
      await cards.onKycDecision(e, clock.now());
    },
  });
  // Loads (REQ-WAL-002): the vendor's payment events land on /hooks/funding; the port verifies and parses,
  // the service settles or fails the transfer once, whatever the webhook count (SEQ-02).
  const loads = new LoadService({ db: o.db, port: o.registry.resolve<FundingPort>('funding', o.market), ledger, accounts, transfers, memberships, flags, provider: o.registry.bindingFor('funding', o.market)?.provider ?? 'simulator', rates, markups: fx });
  webhooks.bind(FUNDING_PROVIDER, { verifier: loads.webhookVerifier(), process: (e) => loads.applyWebhook(e, clock.now()).then(() => undefined) });
  const autoReload = new AutoReloadService(o.db, accounts, loads, flags, o.market);
  const p2pLimits = new P2pLimitService(o.db, memberships, entitlements, plans);
  const p2pHolds = new P2pHoldService(o.db, ledger, accounts, transfers);
  const preferences = new PreferenceService(o.db);
  // A send to a member who receives in the other currency prices at the club rate with their plan's markup (REQ-PAY-006).
  const p2p = new P2pSendService({ db: o.db, ledger, accounts, transfers, limits: p2pLimits, holds: p2pHolds, kyc, identity, notify: notifyPort, preferences, rates, markups: fx });
  // An approved agent intent runs the member's own send or load (T-1008, T-1009), so the intents come after them, and the JIT after the intents.
  const intents = new IntentService(o.db, transfers, stepUp, { p2p, loads }, flags);
  const jit = new JitService({ db: o.db, port: cardIssuing, ledger, accounts, memberships, entitlements, plans, flags, intents, fx: { rates, markups: fx } });
  const requests = new PaymentRequestService(o.db, p2p, identity);
  // Payouts (REQ-PO-001/002): the rail's status webhooks land on /hooks/payout; settled and failed are applied once (SEQ-09).
  const collections = new CollectionsService(o.db, ledger, accounts, transfers, flags);
  const payouts = new PayoutService({ db: o.db, port: o.registry.resolve<PayoutPort>('payout', o.market), ledger, accounts, transfers, approvals, identity, notify: notifyPort, flags, provider: o.registry.bindingFor('payout', o.market)?.provider ?? 'simulator' });
  webhooks.bind(PAYOUT_PROVIDER, { verifier: payouts.webhookVerifier(), process: (e) => payouts.applyWebhook(e, clock.now()).then(() => undefined) });
  const closure = new ClosureService({ db: o.db, port: o.registry.resolve<FundingPort>('funding', o.market), ledger, accounts, transfers, identity, audit, provider: o.registry.bindingFor('funding', o.market)?.provider ?? 'simulator' });
  const outbound = new OutboundEventsService(o.db, eventsPort);
  if (o.registry.bindingFor('billing', o.market)?.mode === 'sim') webhooks.bind('simulator', { verifier: simulatorVerifier, process: async () => undefined });
  return { clock, identity, tokens, otp, passkeys, stepUp, recovery, ledger, accounts, plans, entitlements, memberships, transfers, approvals, audit, flags, orders, roster, intents, inbound, webhooks, outbound, kyc, cards, jit, provisioning, physical, loads, autoReload, closure, p2pLimits, p2p, requests, fx, payouts, collections, rates, preferences };
}

export function createApp(o: AppOptions): App {
  const s = buildServices(o);
  const staffInstitution = async (partyId: string) => (await o.db.query<{ institution_id: string }>('select institution_id from org.staff where party_id = $1 and active', [partyId])).rows[0]?.institution_id;
  const handlers: HandlerTable = {
    ...authHandlers({ otp: s.otp, passkeys: s.passkeys, recovery: s.recovery, tokens: s.tokens, stepUp: s.stepUp }),
    getCapabilities: capabilitiesHandler({ flags: s.flags, memberships: s.memberships, entitlements: s.entitlements }),
    getStatus: statusHandler({ flags: s.flags, registry: o.registry, market: o.market }),
    ...kycHandlers(s.kyc),
    ...cardHandlers(s.cards, s.jit, s.provisioning, s.stepUp, s.physical),
    ...walletHandlers(s.loads, s.stepUp, s.flags, s.autoReload, s.closure),
    ...p2pHandlers(s.p2p, s.stepUp, s.flags, s.requests),
    ...fxHandlers(s.fx, s.stepUp),
    ...payoutHandlers(s.payouts, s.stepUp),
    listAccounts: route(async (req) => ok(await s.accounts.listAccountsBody(requirePrincipal(req).partyId))),
    createMembership: route(async (req) => {
      const p = requirePrincipal(req);
      const b = req.body as { memberPartyId: string; planCode: string; termMonths?: number; funderEmail?: string };
      const m = await s.memberships.create({ idempotencyKey: requireIdempotencyKey(req), memberPartyId: b.memberPartyId, funderPartyId: p.partyId, funderEmail: b.funderEmail ?? `party:${p.partyId}@members.kesher.example`, planCode: b.planCode, ...(b.termMonths ? { termMonths: b.termMonths } : {}) }, req.now);
      return { status: 201, body: { id: m.id, planCode: m.planCode, planVersion: m.planVersion, status: m.status, price: toWire(m.price), ...(m.currentPeriodEnd ? { currentPeriodEnd: m.currentPeriodEnd } : {}) } };
    }),
    listCatalogue: route(async (req) => {
      requirePrincipal(req);
      const r = await o.db.query<{ sku: string; kind: string; title: string; price_minor: string; currency: 'USD' | 'ILS'; attributes: Record<string, unknown> }>(`select sku, kind, title, price_minor::text as price_minor, currency, attributes from addons.catalogue_item where active order by kind, sku limit 100`);
      return ok({ items: r.rows.map((x) => ({ sku: x.sku, kind: x.kind, title: x.title, price: { minor: x.price_minor, currency: x.currency }, ...(x.attributes['disclosures'] ? { disclosures: x.attributes['disclosures'] } : {}) })) });
    }),
    createAddonOrder: route(async (req) => {
      const p = requirePrincipal(req);
      const b = req.body as { sku: string; quantity?: number; disclosuresAcknowledged?: boolean };
      const membership = await s.memberships.forMember(p.partyId);
      const order = await s.orders.create({ idempotencyKey: requireIdempotencyKey(req), memberPartyId: p.partyId, membership, sku: b.sku, ...(b.quantity ? { quantity: b.quantity } : {}), ...(b.disclosuresAcknowledged !== undefined ? { disclosuresAcknowledged: b.disclosuresAcknowledged } : {}) }, req.now);
      return { status: 201, body: { id: order.id, sku: order.sku, state: order.state, price: toWire(order.price), creditApplied: toWire(order.credit), ...(order.fulfilment ? { fulfilment: order.fulfilment } : {}) } };
    }),
    importRoster: importRosterHandler({ roster: s.roster, staffInstitution }),
    ...collectionsHandlers(s.collections, s.stepUp, staffInstitution),
    ...allowanceRunHandlers({ activities: new PostgresAllowanceActivities(o.db, s.ledger, s.accounts, s.approvals, s.transfers, s.clock.now), flags: s.flags, staffInstitution }),
    ...fxAdminHandlers(s.rates),
    ...preferenceHandlers(s.preferences),
    exportCollections: exportHandler(o.db, staffInstitution),
    approveIntent: route(async (req) => {
      const key = requireIdempotencyKey(req);
      const r = await s.intents.approve(req, req.params['id'] ?? '', key);
      return ok({ id: r.intent.id, kind: r.intent.kind, status: r.intent.status, expiresAt: r.intent.expiresAt, summary: r.intent.summary, ...(r.load ? { load: r.load } : {}) });
    }),
    listAgentGrants: route(async (req) => {
      const p = requirePrincipal(req);
      const r = await o.db.query<{ id: string; client_id: string; name: string; scopes: string[]; created_at: string | Date; last_used_at: string | Date | null }>(`select g.id, g.client_id, c.name, g.scopes, g.created_at, g.last_used_at from agent.grant g join agent.client c on c.client_id = g.client_id where g.party_id = $1 and g.status = 'active' order by g.created_at desc`, [p.partyId]);
      return ok({ items: r.rows.map((g) => ({ id: g.id, clientName: g.name, clientId: g.client_id, scopes: g.scopes, createdAt: new Date(g.created_at).toISOString(), ...(g.last_used_at ? { lastUsedAt: new Date(g.last_used_at).toISOString() } : {}) })) });
    }),
    revokeAgentGrant: route(async (req) => {
      const p = requirePrincipal(req);
      const r = await o.db.query(`update agent.grant set status = 'revoked', revoked_at = $3 where id = $1 and party_id = $2 and status = 'active'`, [req.params['id'], p.partyId, req.now]);
      if (r.rowCount === 0) throw new DomainError('NOT_FOUND', 'Grant not found');
      return { status: 204 };
    }),
    providerWebhook: s.webhooks.handler() as Handler,
    ...adminHandlers({ flags: s.flags as FlagService, approvals: s.approvals, audit: s.audit, registry: o.registry, market: o.market, customers: new CustomerReadModel({ db: o.db, identity: s.identity, ledger: s.ledger, audit: s.audit }), complaints: new ComplaintService(o.db, s.audit), alerts: new AlertService(o.db, s.audit) }),
  };
  for (const r of ROUTES) if (!handlers[r.operationId]) handlers[r.operationId] = notYet(r.operationId);
  const staff = staffBearerMiddleware(o.staffJwks && o.staffJwks.length ? new StaffTokenVerifier({ jwks: o.staffJwks, clock: s.clock }) : undefined);
  const member = bearerMiddleware(s.tokens);
  // Staff tokens are recognised by audience and verified against the console's key; everything else is a member token.
  const authenticate = async (req: HttpRequest) => {
    const r = await staff(req);
    return r.principal ? r : member(r);
  };
  return { handlers, authenticate, services: s };
}

/** Operations whose cards wait on ADR-006 (cards, loads, fx, payouts, households) answer FEATURE_OFF, never 500. */
const notYet = (operationId: string): Handler => route(async () => {
  throw new DomainError('FEATURE_OFF', `${operationId} is behind a flag that is off (pending ADR-006)`);
});
