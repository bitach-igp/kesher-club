// Composition root: builds every service against a Database and a ProviderRegistry (simulators
// in sim mode) and returns the handler table. The HTTP server (server.ts) and tests call this;
// nothing here knows about sockets. Secrets arrive through the config loader (T-0004).
import type { Database } from './db.ts';
import type { AuthPort, BankPort, BillingPort, CardIssuingPort, EventsPort, FundingPort, FxPort, PayoutPort, KycPort, KybPort, NotifyPort, ProviderRegistry, Market } from '@kesher/ports';
import { ok, requireIdempotencyKey, requirePrincipal, requireRole, route, type Handler, type HttpRequest } from './http.ts';
import { authHandlers, bearerMiddleware } from './auth/handlers.ts';
import { adminHandlers } from './admin/handlers.ts';
import { fxAdminHandlers } from './fx/admin.ts';
import { PriceRules, priceRuleHandlers } from './addons/price-rules.ts';
import { DisplayNameService, displayNameHandlers } from './me/display-name.ts';
import { RecipientLookup } from './p2p/recipients.ts';
import { CimdRegistry, type Fetcher, type Resolver } from './mcp/cimd.ts';
import { AuthorizeService, oauthHandlers, type OAuthConfig } from './oauth/authorize.ts';
import { ConsentService, consentHandlers } from './oauth/consent.ts';
import { TokenEndpoint, tokenHandler } from './oauth/token.ts';
import { McpTokenValidator } from './mcp/auth.ts';
import { McpGateway } from './mcp/gateway.ts';
import { McpHttp, toolContext } from './mcp/http.ts';
import { lookup } from 'node:dns/promises';
import { PreferenceService, preferenceHandlers } from './me/preferences.ts';
import { RateService } from './fx/rates.ts';
import { cardHandlers } from './cards/handlers.ts';
import { CardService } from './cards/service.ts';
import { JitService } from './cards/jit.ts';
import { PhysicalCardService } from './cards/physical.ts';
import { detailsTokenProvisioning, ProvisioningService, TOKEN_EVENT_PROVIDER } from './cards/provisioning.ts';
import { CardSettlementService, cardIssuingProcessor } from './cards/settlement.ts';
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
import { caseHandlers, OpsCases } from './admin/cases.ts';
import { InstitutionAdmin, institutionAdminHandlers } from './admin/institutions.ts';
import { InstitutionApplications, applicationHandlers } from './institutions/application.ts';
import { dashboardHandlers, InstitutionDashboard } from './institutions/dashboard.ts';
import { cohortHandlers, Cohorts } from './institutions/cohorts.ts';
import { RosterList, rosterListHandlers } from './institutions/roster-list.ts';
import { StudentDetail, studentHandlers } from './institutions/student.ts';
import { statementHandlers } from './institutions/statement.ts';
import { InstitutionTeam, teamHandlers } from './institutions/team.ts';
import { BANK_PROVIDER, bankCreditVerifier, depositHandlers, InstitutionDeposits, paymentReference } from './institutions/deposits.ts';
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
import { PlanCatalogue, planCatalogueHandlers } from './billing/plan-catalogue.ts';
import { FunderInvites, funderInviteHandlers } from './billing/funder-invites.ts';
import { HouseholdService, householdHandlers } from './wallet/household.ts';
import { TransactionService, transactionHandlers } from './wallet/transactions.ts';
import { EntitlementService } from './billing/entitlements.ts';
import { MembershipService, type Membership } from './billing/memberships.ts';
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
import { FeeBilling, feeBillingHandlers } from './institutions/fee-billing.ts';
import { achPullHandlers, InstitutionAch, type StaffOf } from './institutions/ach.ts';
import { allowanceRunHandlers } from './institutions/allowance-runs.ts';
import { PostgresAllowanceActivities } from './institutions/allowance/activities.ts';
import { creditHandlers, InstitutionCredit } from './institutions/credit.ts';
import { kybHandlers } from './institutions/kyb-handlers.ts';
import { InstitutionKyb } from './institutions/kyb.ts';
import { KybGate } from './institutions/kyb-gate.ts';
import { KybChecks } from './institutions/kyb-checks.ts';
import { PayoutAccounts, payoutAccountHandlers } from './institutions/payout-account.ts';
import { exportHandler } from './institutions/export.ts';
import { InviteService, inviteHandlers } from './institutions/invites.ts';
import { RosterService, importRosterHandler } from './institutions/roster.ts';
import { ApprovalService } from './approvals/service.ts';
import { AuditService } from './audit/service.ts';
import { FlagService } from './flags/service.ts';
import { INTENT_STATES, IntentService, type IntentStatus } from './intents/service.ts';
import { WebhookRouter } from './webhooks/handler.ts';
import { InboundEventStore } from './webhooks/store.ts';
import { simulatorVerifier } from './webhooks/verify.ts';
import { OutboundEventsService } from './events/outbound.ts';
import { ROUTES, type HandlerTable } from './routes.ts';
import { randomBytes } from 'node:crypto';
import { toWire, DomainError, Secret } from '@kesher/domain';
import { createPiiCipher, type PiiCipher } from './crypto/pii.ts';

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
  /**
   * The process's PII cipher (T-0024): main.ts and the demo pass theirs, so what one process seals another opens.
   * Defaults to one with throwaway keys, which suits a test: nothing it seals outlives the process.
   */
  pii?: PiiCipher;
  /** The MCP authorization server (T-1014, ADR-009). The resource defaults to {issuer}/mcp, consent to the app's kesher://connect link. */
  oauth?: { resource?: string; consentUrl?: string };
  /** The client-metadata fetch (T-1003): DNS and fetch. Tests inject both; the defaults are the network's. */
  cimd?: { resolve: Resolver; fetch: Fetcher };
}

export interface App {
  handlers: HandlerTable;
  /** /mcp and its metadata (T-1013): JSON-RPC, outside the REST route table. */
  mcp: McpHttp;
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
  const institutionKyb = new InstitutionKyb(o.db, approvals, audit);
  // Every institution money capability waits on its KYB decision (T-0621, ADR-017).
  const kybGate = new KybGate(institutionKyb);
  const applications = new InstitutionApplications({ db: o.db, identity, flags, audit, kyb: institutionKyb });
  const team = new InstitutionTeam({ db: o.db, identity, approvals, audit, notify: notifyPort });
  const institutionCredit = new InstitutionCredit(o.db, approvals, audit, kybGate);
  const payoutAccounts = new PayoutAccounts(o.db, audit);
  const fx = new FxService({ db: o.db, port: o.registry.resolve<FxPort>('fx', o.market), rates, ledger, accounts, transfers, memberships, plans, flags });
  const provisioning = new ProvisioningService(o.db, cards, detailsTokenProvisioning(cardIssuing), flags);
  const physical = new PhysicalCardService(o.db, cardIssuing, kyc, cards, flags, o.registry.bindingFor('card-issuing', o.market)?.provider ?? 'simulator');
  // The processor's token lifecycle events and clearings land on /hooks/card-issuing and are applied at
  // receipt; the worker's token-events job sweeps anything left pending within its cycle (REQ-CRD-007).
  // A clearing settles its authorisation's hold (T-0410).
  const settlement = new CardSettlementService(o.db, ledger, accounts);
  const cardEvents = cardIssuingProcessor({ provisioning, settlement });
  webhooks.bind(TOKEN_EVENT_PROVIDER, { verifier: ProvisioningService.verifier(o.registry.bindingFor('card-issuing', o.market)?.mode), process: (e) => cardEvents(e, clock.now()).then(() => undefined) });
  // The KYC provider's decisions arrive on /hooks/kyc; the port verifies and parses, the service applies,
  // and a T2 approval issues the virtual card while card.virtual is on (REQ-CRD-001). A processor failure
  // leaves the event unprocessed so replay retries it; both steps are idempotent.
  // A roster member who accepted their invite before passing KYC becomes active on that approval (T-0626).
  const invites = new InviteService(o.db, notifyPort, kyc);
  webhooks.bind('kyc', {
    verifier: kyc.webhookVerifier(),
    process: async (e) => {
      const decision = await kyc.applyDecision(e);
      await cards.onKycDecision(e, clock.now());
      if (decision.status === 'approved') await invites.onIdentityApproved(decision.partyId, clock.now());
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
  const displayNames = new DisplayNameService(o.db, o.pii ?? createPiiCipher({ dataKey: new Secret(randomBytes(32).toString('base64')), indexKey: new Secret(randomBytes(32).toString('base64')) }));
  const recipients = new RecipientLookup({ identity, kyc, names: displayNames });
  const oauthConfig: OAuthConfig = { issuer: o.issuer, resource: o.oauth?.resource ?? `${o.issuer.replace(/\/$/, '')}/mcp`, consentUrl: o.oauth?.consentUrl ?? 'kesher://connect' };
  const cimd = new CimdRegistry(o.db, o.cimd?.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address)), o.cimd?.fetch ?? ((url, init) => fetch(url, init)), clock.now);
  const authorize = new AuthorizeService(o.db, cimd, oauthConfig);
  const consent = new ConsentService(o.db, audit, oauthConfig);
  const tokenEndpoint = new TokenEndpoint(o.db, o.signingKey, oauthConfig);
  // A send to a member who receives in the other currency prices at the club rate with their plan's markup (REQ-PAY-006).
  const p2p = new P2pSendService({ db: o.db, ledger, accounts, transfers, limits: p2pLimits, holds: p2pHolds, kyc, identity, notify: notifyPort, preferences, rates, markups: fx });
  // An approved agent intent runs the member's own send or load (T-1008, T-1009), so the intents come after them, and the JIT after the intents.
  const intents = new IntentService(o.db, transfers, stepUp, { p2p, loads }, flags, undefined, identity);
  const jit = new JitService({ db: o.db, port: cardIssuing, ledger, accounts, memberships, entitlements, plans, flags, intents, fx: { rates, markups: fx } });
  const requests = new PaymentRequestService(o.db, p2p, identity);
  // Payouts (REQ-PO-001/002): the rail's status webhooks land on /hooks/payout; settled and failed are applied once (SEQ-09).
  const collections = new CollectionsService(o.db, ledger, accounts, transfers, flags);
  const payouts = new PayoutService({ db: o.db, port: o.registry.resolve<PayoutPort>('payout', o.market), ledger, accounts, transfers, approvals, identity, notify: notifyPort, flags, provider: o.registry.bindingFor('payout', o.market)?.provider ?? 'simulator', kyb: kybGate, payoutAccounts });
  webhooks.bind(PAYOUT_PROVIDER, { verifier: payouts.webhookVerifier(), process: (e) => payouts.applyWebhook(e, clock.now()).then(() => undefined) });
  // The bank feed (T-0618): bound only where a bank is (ADR-006 decides which); the manual record stays the fallback.
  const planCatalogue = new PlanCatalogue(o.db, plans, approvals, audit);
  const funderInvites = new FunderInvites({ db: o.db, plans, memberships, billing: billingPort, kyc, notify: notifyPort, flags, displayNames });
  const transactions = new TransactionService(o.db, flags);
  const households = new HouseholdService({ db: o.db, accounts, displayNames, invites: funderInvites, flags, transactions, cards });
  const deposits = new InstitutionDeposits({ db: o.db, ledger, accounts, transfers, approvals, audit, flags, kyb: kybGate });
  if (o.registry.bindingFor('bank', o.market)) webhooks.bind(BANK_PROVIDER, { verifier: bankCreditVerifier(o.registry.resolve<BankPort>('bank', o.market)), process: (e) => deposits.applyBankEvent(e, clock.now()).then(() => undefined) });
  const closure = new ClosureService({ db: o.db, port: o.registry.resolve<FundingPort>('funding', o.market), ledger, accounts, transfers, identity, audit, provider: o.registry.bindingFor('funding', o.market)?.provider ?? 'simulator' });
  const outbound = new OutboundEventsService(o.db, eventsPort);
  if (o.registry.bindingFor('billing', o.market)?.mode === 'sim') webhooks.bind('simulator', { verifier: simulatorVerifier, process: async () => undefined });
  return { clock, identity, tokens, otp, passkeys, stepUp, recovery, ledger, accounts, plans, entitlements, memberships, transfers, approvals, audit, flags, orders, roster, invites, intents, inbound, webhooks, outbound, kyc, cards, jit, provisioning, settlement, physical, loads, autoReload, closure, p2pLimits, p2p, requests, fx, payouts, collections, rates, preferences, displayNames, recipients, oauthConfig, cimd, authorize, consent, tokenEndpoint, institutionCredit, institutionKyb, kybGate, applications, team, payoutAccounts, deposits, planCatalogue, funderInvites, households, transactions };
}

export function createApp(o: AppOptions): App {
  const s = buildServices(o);
  // The console lists and flips the stored flags (two-person approved) even when a test or the demo
  // process injects in-memory evaluation flags; those decide what members see, not what the console shows.
  const flagStore = s.flags instanceof FlagService ? s.flags : new FlagService(o.db, s.approvals, s.audit);
  const staffInstitution = async (partyId: string) => (await o.db.query<{ institution_id: string }>('select institution_id from org.staff where party_id = $1 and active', [partyId])).rows[0]?.institution_id;
  const staffOf: StaffOf = async (partyId) => (await o.db.query<{ institution_id: string; role: 'staff' | 'finance' | 'admin' }>('select institution_id, role from org.staff where party_id = $1 and active', [partyId])).rows.map((x) => ({ institutionId: x.institution_id, role: x.role }))[0];
  const handlers: HandlerTable = {
    ...authHandlers({ otp: s.otp, passkeys: s.passkeys, recovery: s.recovery, tokens: s.tokens, stepUp: s.stepUp }),
    getCapabilities: capabilitiesHandler({ flags: s.flags, memberships: s.memberships, entitlements: s.entitlements }),
    getStatus: statusHandler({ flags: s.flags, registry: o.registry, market: o.market }),
    ...kycHandlers(s.kyc),
    ...cardHandlers(s.cards, s.jit, s.provisioning, s.stepUp, s.physical),
    ...walletHandlers(s.loads, s.stepUp, s.flags, s.autoReload, s.closure),
    ...p2pHandlers(s.p2p, s.stepUp, s.flags, s.requests, s.recipients),
    ...fxHandlers(s.fx, s.stepUp),
    ...payoutHandlers(s.payouts, s.stepUp, {
      db: o.db,
      identity: s.identity,
      staffOf,
      accounts: s.payoutAccounts,
    }),
    listAccounts: route(async (req) => ok(await s.accounts.listAccountsBody(requirePrincipal(req).partyId))),
    // The institution console's landing (T-0608): the same active staff row every institution handler checks.
    getMyInstitution: route(async (req) => {
      const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
      const r = await o.db.query<{ id: string; name: string; market: 'US' | 'IL'; role: 'staff' | 'finance' | 'admin' }>('select i.id, i.name, i.market, s.role from org.staff s join org.institution i on i.id = s.institution_id where s.party_id = $1 and s.active', [p.partyId]);
      const x = r.rows[0];
      if (!x) throw new DomainError('FORBIDDEN', 'Not staff of an institution');
      return ok({ institution: { id: x.id, name: x.name, market: x.market }, role: x.role, paymentReference: paymentReference(x.id) });
    }),
    createMembership: route(async (req) => {
      const p = requirePrincipal(req);
      const b = req.body as { memberPartyId: string; planCode: string; termMonths?: number; funderEmail?: string };
      const m = await s.memberships.create({ idempotencyKey: requireIdempotencyKey(req), memberPartyId: b.memberPartyId, funderPartyId: p.partyId, funderEmail: b.funderEmail ?? `party:${p.partyId}@members.kesher.example`, planCode: b.planCode, ...(b.termMonths ? { termMonths: b.termMonths } : {}) }, req.now);
      return { status: 201, body: membershipBody(m) };
    }),
    listMemberships: route(async (req) => {
      const p = requirePrincipal(req);
      const items = await s.memberships.forParty(p.partyId);
      return ok({
        items: await Promise.all(
          items.map(async (m) => ({
            ...membershipBody(m),
            role: m.role,
            memberPartyId: m.memberPartyId,
            ...(m.role === 'funder' ? { memberName: (await s.displayNames.get(m.memberPartyId)).displayName ?? 'Member' } : {}),
          })),
        ),
      });
    }),
    cancelMembership: route(async (req) => {
      const p = requirePrincipal(req);
      return ok(membershipBody(await s.memberships.cancel(req.params['id'] ?? '', p.partyId, requireIdempotencyKey(req))));
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
    importRoster: importRosterHandler({ roster: s.roster, staffInstitution, onCommitted: (importId, now) => s.invites.fanOut(importId, now) }),
    ...inviteHandlers(s.invites),
    ...collectionsHandlers(s.collections, s.stepUp, staffInstitution),
    ...achPullHandlers(new InstitutionAch({ db: o.db, loads: s.loads, transfers: s.transfers, accounts: s.accounts, flags: s.flags, kyb: s.kybGate, audit: s.audit }), s.stepUp, staffOf),
    ...feeBillingHandlers({ billing: new FeeBilling(o.db), flags: s.flags, staffInstitution }),
    ...allowanceRunHandlers({ activities: new PostgresAllowanceActivities(o.db, s.ledger, s.accounts, s.approvals, s.transfers, s.institutionCredit, s.clock.now), credit: s.institutionCredit, flags: s.flags, staffInstitution, db: o.db, identity: s.identity, stepUp: s.stepUp }),
    ...creditHandlers(s.institutionCredit),
    ...payoutAccountHandlers(s.payoutAccounts),
    ...kybHandlers(s.institutionKyb, new KybChecks({ db: o.db, kyb: s.institutionKyb, flags: s.flags, port: (m) => o.registry.resolve<KybPort>('kyb', m), provider: (m) => o.registry.bindingFor('kyb', m)?.provider ?? 'simulator' })),
    ...fxAdminHandlers(s.rates),
    ...priceRuleHandlers(new PriceRules(o.db, s.approvals, s.audit)),
    ...planCatalogueHandlers(s.planCatalogue),
    ...funderInviteHandlers(s.funderInvites),
    ...householdHandlers(s.households),
    ...transactionHandlers(s.transactions),
    ...institutionAdminHandlers(new InstitutionAdmin(o.db, s.identity, s.approvals, s.audit)),
    ...applicationHandlers(s.applications),
    ...dashboardHandlers(new InstitutionDashboard({ db: o.db, accounts: s.accounts, staffOf })),
    ...cohortHandlers(new Cohorts(o.db), staffOf),
    ...rosterListHandlers(new RosterList(o.db), staffOf),
    ...studentHandlers(new StudentDetail(o.db, new RosterList(o.db)), staffOf),
    ...statementHandlers(o.db, s.accounts, staffOf),
    ...teamHandlers(s.team, s.stepUp, staffOf),
    ...depositHandlers(s.deposits),
    ...caseHandlers(new OpsCases(o.db, s.audit)),
    ...preferenceHandlers(s.preferences),
    ...displayNameHandlers(s.displayNames),
    ...oauthHandlers({ authorize: s.authorize, cfg: s.oauthConfig, jwks: () => s.tokens.jwks(), flags: s.flags }),
    ...consentHandlers({ consent: s.consent, stepUp: s.stepUp, flags: s.flags }),
    ...tokenHandler({ endpoint: s.tokenEndpoint, flags: s.flags }),
    exportCollections: exportHandler(o.db, staffInstitution),
    // The member's own view of what their assistants proposed (T-1011): member tokens only; never an MCP tool.
    listIntents: route(async (req) => {
      const p = requirePrincipal(req);
      const state = req.query['state'];
      if (state !== undefined && !INTENT_STATES.includes(state as IntentStatus)) throw new DomainError('VALIDATION_FAILED', `state must be one of ${INTENT_STATES.join(', ')}`);
      return ok({ items: await s.intents.listForMember(p.partyId, state as IntentStatus | undefined, req.now) });
    }),
    getIntent: route(async (req) => ok(await s.intents.getForMember(requirePrincipal(req).partyId, req.params['id'] ?? '', req.now))),
    declineIntent: route(async (req) => {
      const p = requirePrincipal(req);
      requireIdempotencyKey(req);
      await s.intents.reject(p, req.params['id'] ?? '', req.now);
      return ok(await s.intents.getForMember(p.partyId, req.params['id'] ?? '', req.now));
    }),
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
    ...adminHandlers({ flags: flagStore, approvals: s.approvals, audit: s.audit, registry: o.registry, market: o.market, customers: new CustomerReadModel({ db: o.db, identity: s.identity, ledger: s.ledger, audit: s.audit }), complaints: new ComplaintService(o.db, s.audit), alerts: new AlertService(o.db, s.audit) }),
  };
  for (const r of ROUTES) if (!handlers[r.operationId]) handlers[r.operationId] = notYet(r.operationId);
  const staff = staffBearerMiddleware(o.staffJwks && o.staffJwks.length ? new StaffTokenVerifier({ jwks: o.staffJwks, clock: s.clock }) : undefined);
  const member = bearerMiddleware(s.tokens);
  // Staff tokens are recognised by audience and verified against the console's key; everything else is a member token.
  const authenticate = async (req: HttpRequest) => {
    const r = await staff(req);
    return r.principal ? r : member(r);
  };
  // The MCP resource server (T-1013): the gateway checks tokens this API's authorization server issued (ADR-009).
  const mcpConfig = { resource: s.oauthConfig.resource, authorizationServers: [s.oauthConfig.issuer.replace(/\/$/, '')] };
  const mcpValidator = new McpTokenValidator(o.db, { key: o.signingKey.publicKey, issuer: mcpConfig.authorizationServers[0]! }, mcpConfig.resource);
  const gateway = new McpGateway(mcpConfig, o.db, mcpValidator, (now) => toolContext({ accounts: s.accounts, cards: s.cards, intents: s.intents }, now));
  const mcp = new McpHttp(mcpConfig, gateway, mcpValidator, s.flags);
  return { handlers, authenticate, services: s, mcp };
}

/** A membership as the contract's `Membership`: money on the wire, the end dates when there are any. */
const membershipBody = (m: Membership) => ({ id: m.id, planCode: m.planCode, planVersion: m.planVersion, status: m.status, price: toWire(m.price), ...(m.currentPeriodEnd ? { currentPeriodEnd: m.currentPeriodEnd } : {}), ...(m.cancelAt ? { cancelAt: m.cancelAt } : {}) });

/** Operations whose cards wait on ADR-006 (cards, loads, fx, payouts, households) answer FEATURE_OFF, never 500. */
const notYet = (operationId: string): Handler => route(async () => {
  throw new DomainError('FEATURE_OFF', `${operationId} is behind a flag that is off (pending ADR-006)`);
});
