// The provider registry a process runs on (T-0021). `sim` binds every port to the in-process
// simulators (previews and staging until ADR-006 names a processor); `sandbox` is the same registry under the staging label
// (T-0040): the config refuses any other global mode, and a vendor adapter is chosen per port. A port can be overridden on its own (T-0659):
// `institution-banking` binds to the Crowded adapter and every other port stays on the simulators.
// Tests keep their own SimulatorHost on a fixed clock; a running process gets the wall clock, which
// the simulators' control panel may still nudge forward.
import {
  AiraloEsimAdapter,
  AppleFederatedIdPAdapter,
  FederatedIdPRouter,
  CoverGeniusInsuranceAdapter,
  type CoverGeniusProduct,
  GoogleFederatedIdPAdapter,
  WorkOsOrgIdPAdapter,
  type WorkOsOrganisation,
  CROWDED_SIGNATURE_HEADER,
  CrowdedClient,
  CrowdedInstitutionBankingAdapter,
  crowdedHeaderValue,
  verifyCrowdedSignature,
  ExpoPushNotifyAdapter,
  PostmarkNotifyAdapter,
  STRIPE_SIGNATURE_HEADER,
  signStripePayload,
  StripeBillingAdapter,
  StripeFundingAdapter,
  TwilioNotifyAdapter,
  verifyStripeSignature,
  type ExpoPushOptions,
  type KeyLedger,
} from '@kesher/adapters';
import { guarded, type Metrics, type Secret } from '@kesher/domain';
import {
  type AdvanceableClock,
  type BillingPort,
  type Channel,
  type Clock,
  type Delivery,
  type EsimPort,
  type FundingPort,
  type InsurancePort,
  NotifyError,
  type Notification,
  type NotifyPort,
  type OrgIdPPort,
  type Market,
  type ProviderRegistry,
} from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import type { SqlClient } from './db.ts';
import { PostgresVendorKeyLedger } from './institutions/crowded-keys.ts';
import { CROWDED_PROVIDER } from './webhooks/crowded.ts';

/** Wall-clock time plus whatever the simulators' control panel has advanced it by. */
export function systemClock(): AdvanceableClock {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

/** Binds `institution-banking` to the Crowded adapter. Everything here is the config's; nothing has a default. */
export interface CrowdedBankingOverride {
  provider: 'crowded';
  /** https; there is no production default. */
  baseUrl: string;
  token: Secret;
  /** The endpoint secret and, during a rotation, the previous one: a webhook batch verifies against either. */
  webhookSecrets: readonly Secret[];
  /**
   * The adapter's idempotency ledger, built on the registry's clock (the adapter takes none of its own). Production passes the
   * Postgres one; left out, the adapter keeps keys in memory, which a restart loses.
   */
  keys?: (now: () => Date) => KeyLedger;
  /**
   * The binding mode recorded for the port: `sandbox` unless the config says `live` explicitly (CROWDED_BINDING=live). The base
   * URL is never used to guess it. Going live is a provider_binding approval in ops.approval_request; an env switch does not apply it.
   */
  binding?: 'sandbox' | 'live';
  /** Where the live-binding warning goes (the process log); the registry has no logger of its own. */
  warn?: (message: string) => void;
  /** The HTTP transport; tests inject a fake Crowded. */
  fetch?: typeof globalThis.fetch;
  /**
   * Adapter options the config has no key for yet (T-0659 "Not done"): the sub-account contact, Kesher's collection
   * counterparty and the payer's consent. A caller such as the T-0660 e2e supplies them; production config keys come later.
   */
  subAccountEmail?: string;
  collectionCounterpartyRef?: string;
  payer?: { ip: string; consented: true };
}

/** Said when CROWDED_BINDING=live is set: the env switch changes the label here, not the approval record. */
export const LIVE_BINDING_WARNING =
  'CROWDED_BINDING=live is set: the provider_binding approval in ops.approval_request is not applied by an env switch; check that the approval exists';

/** Said when CROWDED_BINDING=live is set but the banking port is not on Crowded: the key does nothing. */
export const IGNORED_LIVE_BINDING_WARNING = 'CROWDED_BINDING=live is ignored: PROVIDER_INSTITUTION_BANKING is not crowded, so nothing is bound to Crowded';

/** Binds `esim` to Airalo (T-0042). Every value is the config's; nothing has a default. */
export interface AiraloEsimOverride {
  provider: 'airalo';
  /** https; the sandbox and production hosts differ and neither is assumed. */
  baseUrl: string;
  clientId: Secret;
  clientSecret: Secret;
  /** The HTTP transport; tests inject a fake Airalo. */
  fetch?: typeof globalThis.fetch;
}

/** Binds `insurance` to Cover Genius (XCover). The product map and the compliance wording are the config's. */
export interface CoverGeniusInsuranceOverride {
  provider: 'cover-genius';
  baseUrl: string;
  partnerCode: Secret;
  apiKey: Secret;
  apiSecret: Secret;
  products: Record<string, CoverGeniusProduct>;
  disclosures: { licensedEntity: string; commissionDisclosure: string };
  fetch?: typeof globalThis.fetch;
}

/** Binds `org-idp` to WorkOS. */
export interface WorkOsOrgIdpOverride {
  provider: 'workos';
  clientId: Secret;
  apiKey: Secret;
  webhookSecret: Secret;
  /**
   * Our institution id to its WorkOS ids. The config has no key for this yet, so it starts empty and the adapter refuses every
   * organisation as unknown until a later card supplies the mapping (T-0042 "Not done").
   */
  orgs?: Readonly<Record<string, WorkOsOrganisation>>;
  fetch?: typeof globalThis.fetch;
}

/** Binds `federated-idp` to the Apple and Google OIDC adapters, which come together or not at all (auth.social.enabled). */
export interface OidcFederatedIdpOverride {
  provider: 'oidc';
  apple: { clientId: Secret; teamId: Secret; keyId: Secret; privateKey: Secret };
  google: { clientId: Secret; clientSecret: Secret };
  fetch?: typeof globalThis.fetch;
}

/** Binds `funding` and `billing` together to the Stripe adapters (T-0041). Every value is the config's; nothing has a default. */
export interface StripeOverride {
  provider: 'stripe';
  /** A restricted or secret key; the config accepts only a test-mode one. */
  secretKey: Secret;
  /** The endpoint signing secret and, during a rotation, the previous one: a webhook verifies against either. */
  webhookSecrets: readonly Secret[];
  /** Our plan codes to Stripe product ids. */
  planProducts: Readonly<Record<string, string>>;
  /** The HTTP transport; tests inject a fake Stripe. */
  fetch?: typeof globalThis.fetch;
}

/** Binds the `sms` channel of `notify` to Twilio; the other channels stay on the simulator. */
export interface TwilioSmsOverride {
  provider: 'twilio';
  accountSid: Secret;
  authToken: Secret;
  /** The sending number, E.164. */
  from: string;
  templates: Readonly<Record<string, Record<'en' | 'he', string>>>;
  fetch?: typeof globalThis.fetch;
}

/** Binds the `email` channel of `notify` to Postmark. */
export interface PostmarkEmailOverride {
  provider: 'postmark';
  serverToken: Secret;
  from: string;
  templates: Readonly<Record<string, Record<'en' | 'he', string>>>;
  fetch?: typeof globalThis.fetch;
}

/** Binds the `push` channel of `notify` to the Expo push service. */
export interface ExpoPushOverride {
  provider: 'expo';
  accessToken: Secret;
  templates: ExpoPushOptions['templates'];
  fetch?: typeof globalThis.fetch;
}

export interface RegistryOverrides {
  funding?: StripeOverride;
  notifySms?: TwilioSmsOverride;
  notifyEmail?: PostmarkEmailOverride;
  notifyPush?: ExpoPushOverride;
  institutionBanking?: CrowdedBankingOverride;
  esim?: AiraloEsimOverride;
  insurance?: CoverGeniusInsuranceOverride;
  orgIdp?: WorkOsOrgIdpOverride;
  federatedIdp?: OidcFederatedIdpOverride;
}

/** The provider each overridable port runs on, for the start-up log. Never a credential. */
export type ProviderSummary = {
  'institution-banking': 'sim' | 'crowded';
  esim: 'sim' | 'airalo';
  insurance: 'sim' | 'cover-genius';
  'org-idp': 'sim' | 'workos';
  'federated-idp': 'sim' | 'oidc';
  /** `stripe` backs both `funding` and `billing`. */
  funding: 'sim' | 'stripe';
  'notify-sms': 'sim' | 'twilio';
  'notify-email': 'sim' | 'postmark';
  'notify-push': 'sim' | 'expo';
};

const requireHttps = (what: string, url: string): string => {
  if (!/^https:\/\/[^/\s?#]+/.test(url) || !URL.canParse(url)) throw new Error(`${what} needs an https baseUrl`);
  return url;
};

/**
 * The notify port when a channel has its own vendor (T-0041): each notification goes to the adapter its channel is routed to, and a
 * channel with none (WhatsApp, or any channel left on `sim`) goes to the simulator. A message id is only known to the adapter that
 * sent it, so a delivery lookup asks them in turn and takes the first that knows it; it keeps no state of its own.
 */
export class NotifyChannelRouter implements NotifyPort {
  private readonly routes: Partial<Record<Channel, NotifyPort>>;
  private readonly fallback: NotifyPort;

  constructor(routes: Partial<Record<Channel, NotifyPort>>, fallback: NotifyPort) {
    this.routes = routes;
    this.fallback = fallback;
  }

  send(notification: Notification, idempotencyKey: string): Promise<Delivery> {
    return (this.routes[notification.channel] ?? this.fallback).send(notification, idempotencyKey);
  }

  async getDelivery(messageId: string): Promise<Delivery> {
    for (const port of new Set([...Object.values(this.routes), this.fallback])) {
      try {
        return await port.getDelivery(messageId);
      } catch (e) {
        if (!(e instanceof NotifyError) || e.code !== 'UNKNOWN_MESSAGE') throw e;
      }
    }
    throw new NotifyError('UNKNOWN_MESSAGE', 'Unknown message id');
  }
}

/**
 * Lets a Stripe adapter, which takes one signing secret, verify a webhook signed with the previous one too during a rotation. A
 * delivery that verifies against an older secret is re-signed with the current one and handed on, so the adapter keeps its own
 * checks (freshness, event de-duplication, the amount cross-check) and its own state. Nothing else about the adapter changes.
 */
function acceptPreviousSecrets<R>(adapter: { parseWebhook: (headers: Record<string, string>, rawBody: string) => Promise<R> }, secrets: readonly string[], clock: Clock): void {
  const [current, ...previous] = secrets;
  if (current === undefined || previous.length === 0) return;
  const parse = adapter.parseWebhook.bind(adapter);
  adapter.parseWebhook = (headers, rawBody) => {
    const now = Math.floor(clock.now().getTime() / 1000);
    const name = Object.keys(headers).find((k) => k.toLowerCase() === STRIPE_SIGNATURE_HEADER);
    const header = name === undefined ? undefined : headers[name];
    if (name === undefined || verifyStripeSignature({ header, rawBody, secret: current, nowSeconds: now }) === undefined) return parse(headers, rawBody);
    if (!previous.some((secret) => verifyStripeSignature({ header, rawBody, secret, nowSeconds: now }) === undefined)) return parse(headers, rawBody);
    return parse({ ...headers, [name]: signStripePayload(current, rawBody, now) }, rawBody);
  };
}

/** Port methods whose failures their caller already counts as `provider.error`, so the wrapper stays out (no double count). */
const COUNTED_BY_CALLER: Readonly<Record<string, readonly string[]>> = {
  // JitService.handle emits provider.error{port: card-issuing} when parseAuthorization cannot read a request (T-0053).
  'card-issuing': ['parseAuthorization'],
};

/**
 * Whether a thrown value is a provider failure rather than an answer. A port error with a code other than PROVIDER_UNAVAILABLE
 * (BAD_SIGNATURE, DECLINED, UNKNOWN_*, VALIDATION_FAILED, ...) is the vendor working and saying no; PROVIDER_UNAVAILABLE, and anything
 * that is not a coded port error at all (a transport failure, a TypeError from an adapter), is the provider not working.
 */
export function isProviderFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code !== 'string' || code === 'PROVIDER_UNAVAILABLE';
}

/**
 * Makes `registry.resolve` hand out ports whose methods count a provider failure once as `provider.error{port,provider}` and rethrow
 * the very same error. The one place this happens: no adapter has metrics code. The labels are the capability name and the bound
 * provider's registry name, never an id, a payload or a message. Emitting is guarded and cannot change what the caller sees.
 */
function meterResolve(registry: ProviderRegistry, metrics: Metrics): void {
  const sink = guarded(metrics);
  const resolve = registry.resolve.bind(registry);
  registry.resolve = <P>(capability: string, market: Market): P => {
    const port = resolve<P>(capability, market);
    if (port === null || typeof port !== 'object') return port;
    const provider = registry.bindingFor(capability, market)?.provider;
    const skip = COUNTED_BY_CALLER[capability] ?? [];
    const count = (error: unknown): void => {
      if (isProviderFailure(error)) sink.providerError(capability, provider);
    };
    return new Proxy(port, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function' || typeof key !== 'string' || skip.includes(key)) return value;
        return (...args: unknown[]): unknown => {
          let result: unknown;
          try {
            result = Reflect.apply(value, target, args);
          } catch (e) {
            count(e);
            throw e;
          }
          if (typeof (result as { then?: unknown } | null)?.then !== 'function') return result;
          return (result as Promise<unknown>).then(undefined, (e: unknown) => {
            count(e);
            throw e;
          });
        };
      },
    });
  };
}

/**
 * `metrics` turns on provider-failure counting for every resolved port (T-0689). Left out, `resolve` returns the bare port, as tests
 * that compare it to a simulator expect.
 */
export function createRegistry(
  mode: string,
  clock: AdvanceableClock = systemClock(),
  overrides: RegistryOverrides = {},
  metrics?: Metrics,
): { registry: ProviderRegistry; simulators: SimulatorHost; providers: ProviderSummary } {
  // The config already refuses anything but `sim` and `sandbox` (T-0040); this guards a caller that skipped it. The mode only
  // labels the environment: a port runs a vendor adapter only through an override below.
  if (mode !== 'sim' && mode !== 'sandbox') throw new Error(`Provider mode "${mode}" is not accepted: use sim or sandbox, and choose vendors per port`);
  const simulators = new SimulatorHost(clock);
  const providers: ProviderSummary = { 'institution-banking': 'sim', esim: 'sim', insurance: 'sim', 'org-idp': 'sim', 'federated-idp': 'sim', funding: 'sim', 'notify-sms': 'sim', 'notify-email': 'sim', 'notify-push': 'sim' };
  const banking = overrides.institutionBanking;
  if (banking) {
    const secrets = banking.webhookSecrets.map((s) => s.reveal());
    const ledger = banking.keys?.(() => clock.now());
    // One instance for both markets: its key ledger and client are shared, and a boot with a bad URL fails here, not on a request.
    const adapter = new CrowdedInstitutionBankingAdapter({
      client: new CrowdedClient({ baseUrl: banking.baseUrl, token: banking.token.reveal(), ...(banking.fetch ? { fetch: banking.fetch } : {}) }),
      ...(ledger ? { ledger } : {}),
      ...(banking.subAccountEmail ? { subAccountEmail: banking.subAccountEmail } : {}),
      ...(banking.collectionCounterpartyRef ? { collectionCounterpartyRef: banking.collectionCounterpartyRef } : {}),
      ...(banking.payer ? { payer: banking.payer } : {}),
      // Without a verifier the adapter refuses every webhook; this is the same HMAC the /webhooks/crowded receiver checks.
      verifyWebhookSignature: (headers, rawBody) => verifyCrowdedSignature({ header: crowdedHeaderValue(headers, CROWDED_SIGNATURE_HEADER), rawBody, secrets }) === undefined,
    });
    simulators.registry.register('institution-banking', CROWDED_PROVIDER, () => adapter);
    const bindingMode = banking.binding ?? 'sandbox';
    if (bindingMode === 'live') banking.warn?.(LIVE_BINDING_WARNING);
    for (const market of ['US', 'IL'] as const) simulators.registry.bind({ capability: 'institution-banking', market, provider: CROWDED_PROVIDER, mode: bindingMode });
    providers['institution-banking'] = 'crowded';
  }
  // The marketplace and identity ports (T-0042). Each is bound in sandbox mode, whatever the base URL: going live is a
  // provider_binding approval (T-0043), not an env switch. Both markets share one adapter instance.
  const bindBoth = <P>(capability: string, provider: string, adapter: P): void => {
    simulators.registry.register(capability, provider, () => adapter);
    for (const market of ['US', 'IL'] as const) simulators.registry.bind({ capability, market, provider, mode: 'sandbox' });
  };
  const esim = overrides.esim;
  if (esim) {
    const adapter: EsimPort = new AiraloEsimAdapter({
      clientId: esim.clientId.reveal(),
      clientSecret: esim.clientSecret.reveal(),
      baseUrl: requireHttps('Airalo', esim.baseUrl),
      clock,
      ...(esim.fetch ? { fetch: esim.fetch } : {}),
    });
    bindBoth('esim', 'airalo', adapter);
    providers.esim = 'airalo';
  }
  const insurance = overrides.insurance;
  if (insurance) {
    const adapter: InsurancePort = new CoverGeniusInsuranceAdapter({
      partnerCode: insurance.partnerCode.reveal(),
      apiKey: insurance.apiKey.reveal(),
      apiSecret: insurance.apiSecret.reveal(),
      products: insurance.products,
      disclosures: insurance.disclosures,
      baseUrl: requireHttps('Cover Genius', insurance.baseUrl),
      clock,
      ...(insurance.fetch ? { fetch: insurance.fetch } : {}),
    });
    bindBoth('insurance', 'cover-genius', adapter);
    providers.insurance = 'cover-genius';
  }
  const orgIdp = overrides.orgIdp;
  if (orgIdp) {
    const adapter: OrgIdPPort = new WorkOsOrgIdPAdapter({
      clientId: orgIdp.clientId.reveal(),
      apiKey: orgIdp.apiKey.reveal(),
      webhookSecret: orgIdp.webhookSecret.reveal(),
      orgs: orgIdp.orgs ?? {},
      clock,
      ...(orgIdp.fetch ? { fetch: orgIdp.fetch } : {}),
    });
    bindBoth('org-idp', 'workos', adapter);
    providers['org-idp'] = 'workos';
  }
  const federated = overrides.federatedIdp;
  if (federated) {
    // Apple and Google together or not at all: a half-built pair fails closed here as well as in the config.
    if (!federated.apple || !federated.google) throw new Error('federated-idp needs both Apple and Google credentials (auth.social.enabled is both or neither)');
    const transport = federated.fetch ? { fetch: federated.fetch } : {};
    const apple = new AppleFederatedIdPAdapter({
      clientId: federated.apple.clientId.reveal(),
      teamId: federated.apple.teamId.reveal(),
      keyId: federated.apple.keyId.reveal(),
      privateKeyPem: federated.apple.privateKey.reveal(),
      clock,
      ...transport,
    });
    const google = new GoogleFederatedIdPAdapter({ clientId: federated.google.clientId.reveal(), clientSecret: federated.google.clientSecret.reveal(), clock, ...transport });
    bindBoth('federated-idp', 'oidc', new FederatedIdPRouter({ apple, google }));
    providers['federated-idp'] = 'oidc';
  }
  // Stripe backs funding and billing together (T-0041), in sandbox mode like the rest.
  const stripe = overrides.funding;
  if (stripe) {
    const secrets = stripe.webhookSecrets.map((s) => s.reveal());
    const [webhookSecret] = secrets;
    if (webhookSecret === undefined) throw new Error('Stripe needs a webhook secret');
    const transport = stripe.fetch ? { fetch: stripe.fetch } : {};
    const shared = { secretKey: stripe.secretKey.reveal(), webhookSecret, clock, ...transport };
    const funding: FundingPort = new StripeFundingAdapter(shared);
    const billing: BillingPort = new StripeBillingAdapter({ ...shared, planProducts: { ...stripe.planProducts } });
    acceptPreviousSecrets(funding, secrets, clock);
    acceptPreviousSecrets(billing, secrets, clock);
    bindBoth('funding', 'stripe', funding);
    bindBoth('billing', 'stripe', billing);
    providers.funding = 'stripe';
  }
  // Notification channels (T-0041): one router over the vendors chosen, the simulator for every other channel.
  const routes: Partial<Record<Channel, NotifyPort>> = {};
  const sms = overrides.notifySms;
  if (sms) {
    routes.sms = new TwilioNotifyAdapter({
      accountSid: sms.accountSid.reveal(),
      authToken: sms.authToken.reveal(),
      from: { sms: sms.from },
      templates: { ...sms.templates },
      ...(sms.fetch ? { fetch: sms.fetch } : {}),
    });
    providers['notify-sms'] = 'twilio';
  }
  const email = overrides.notifyEmail;
  if (email) {
    routes.email = new PostmarkNotifyAdapter({
      serverToken: email.serverToken.reveal(),
      from: email.from,
      templates: { ...email.templates },
      ...(email.fetch ? { fetch: email.fetch } : {}),
    });
    providers['notify-email'] = 'postmark';
  }
  const push = overrides.notifyPush;
  if (push) {
    routes.push = new ExpoPushNotifyAdapter({ accessToken: push.accessToken.reveal(), templates: { ...push.templates }, ...(push.fetch ? { fetch: push.fetch } : {}) });
    providers['notify-push'] = 'expo';
  }
  if (Object.keys(routes).length > 0) bindBoth('notify', 'notify-router', new NotifyChannelRouter(routes, simulators.simulators.notify));
  if (metrics) meterResolve(simulators.registry, metrics);
  return { registry: simulators.registry, simulators, providers };
}

/** The slice of the API and worker config that picks the providers. */
export interface ProviderConfig {
  PROVIDER_INSTITUTION_BANKING: 'sim' | 'crowded';
  CROWDED_BASE_URL?: string | undefined;
  CROWDED_API_TOKEN?: Secret | undefined;
  CROWDED_WEBHOOK_SECRETS?: readonly Secret[] | undefined;
  /** `live` only when set explicitly; anything else, or nothing, is `sandbox`. */
  CROWDED_BINDING?: 'sandbox' | 'live' | undefined;
  /** T-0042: each defaults to `sim`; the config has refused a named adapter without its whole credential set. */
  PROVIDER_ESIM?: 'sim' | 'airalo' | undefined;
  AIRALO_BASE_URL?: string | undefined;
  AIRALO_CLIENT_ID?: Secret | undefined;
  AIRALO_CLIENT_SECRET?: Secret | undefined;
  PROVIDER_INSURANCE?: 'sim' | 'cover-genius' | undefined;
  COVER_GENIUS_BASE_URL?: string | undefined;
  COVER_GENIUS_PARTNER_CODE?: Secret | undefined;
  COVER_GENIUS_API_KEY?: Secret | undefined;
  COVER_GENIUS_API_SECRET?: Secret | undefined;
  COVER_GENIUS_PRODUCTS?: Record<string, CoverGeniusProduct> | undefined;
  COVER_GENIUS_LICENSED_ENTITY?: string | undefined;
  COVER_GENIUS_COMMISSION_DISCLOSURE?: string | undefined;
  PROVIDER_ORG_IDP?: 'sim' | 'workos' | undefined;
  WORKOS_CLIENT_ID?: Secret | undefined;
  WORKOS_API_KEY?: Secret | undefined;
  WORKOS_WEBHOOK_SECRET?: Secret | undefined;
  PROVIDER_FEDERATED_IDP?: 'sim' | 'oidc' | undefined;
  /** T-0041: each defaults to `sim`; the config has refused a named adapter without its whole credential set. */
  PROVIDER_FUNDING?: 'sim' | 'stripe' | undefined;
  STRIPE_API_KEY?: Secret | undefined;
  STRIPE_WEBHOOK_SECRET?: readonly Secret[] | undefined;
  STRIPE_PLAN_PRODUCTS?: Record<string, string> | undefined;
  PROVIDER_NOTIFY_SMS?: 'sim' | 'twilio' | undefined;
  TWILIO_ACCOUNT_SID?: Secret | undefined;
  TWILIO_AUTH_TOKEN?: Secret | undefined;
  TWILIO_FROM_SMS?: string | undefined;
  TWILIO_TEMPLATES?: Record<string, Record<'en' | 'he', string>> | undefined;
  PROVIDER_NOTIFY_EMAIL?: 'sim' | 'postmark' | undefined;
  POSTMARK_SERVER_TOKEN?: Secret | undefined;
  POSTMARK_FROM?: string | undefined;
  POSTMARK_TEMPLATES?: Record<string, Record<'en' | 'he', string>> | undefined;
  PROVIDER_NOTIFY_PUSH?: 'sim' | 'expo' | undefined;
  EXPO_ACCESS_TOKEN?: Secret | undefined;
  EXPO_TEMPLATES?: ExpoPushOptions['templates'] | undefined;
  APPLE_CLIENT_ID?: Secret | undefined;
  APPLE_TEAM_ID?: Secret | undefined;
  APPLE_KEY_ID?: Secret | undefined;
  APPLE_PRIVATE_KEY?: Secret | undefined;
  GOOGLE_CLIENT_ID?: Secret | undefined;
  GOOGLE_CLIENT_SECRET?: Secret | undefined;
}

/** Names of the keys a chosen adapter is missing; the config refuses this earlier, so reaching it is a caller that skipped the config. */
const needs = (choice: string, have: Record<string, unknown>): string => {
  const missing = Object.keys(have).filter((k) => have[k] === undefined);
  return `${choice} needs ${missing.join(', ')}`;
};

/** The overrides for the marketplace and identity ports a config chooses. Fails closed, naming keys and never a value. */
function marketplaceOverrides(config: ProviderConfig, fetch?: typeof globalThis.fetch): RegistryOverrides {
  const out: RegistryOverrides = {};
  const transport = fetch ? { fetch } : {};
  if (config.PROVIDER_ESIM === 'airalo') {
    const { AIRALO_BASE_URL: baseUrl, AIRALO_CLIENT_ID: clientId, AIRALO_CLIENT_SECRET: clientSecret } = config;
    if (!baseUrl || !clientId || !clientSecret) throw new Error(needs('PROVIDER_ESIM=airalo', { AIRALO_BASE_URL: baseUrl, AIRALO_CLIENT_ID: clientId, AIRALO_CLIENT_SECRET: clientSecret }));
    out.esim = { provider: 'airalo', baseUrl, clientId, clientSecret, ...transport };
  }
  if (config.PROVIDER_INSURANCE === 'cover-genius') {
    const { COVER_GENIUS_BASE_URL: baseUrl, COVER_GENIUS_PARTNER_CODE: partnerCode, COVER_GENIUS_API_KEY: apiKey, COVER_GENIUS_API_SECRET: apiSecret } = config;
    const { COVER_GENIUS_PRODUCTS: products, COVER_GENIUS_LICENSED_ENTITY: licensedEntity, COVER_GENIUS_COMMISSION_DISCLOSURE: commissionDisclosure } = config;
    if (!baseUrl || !partnerCode || !apiKey || !apiSecret || !products || !licensedEntity || !commissionDisclosure) {
      throw new Error(
        needs('PROVIDER_INSURANCE=cover-genius', {
          COVER_GENIUS_BASE_URL: baseUrl,
          COVER_GENIUS_PARTNER_CODE: partnerCode,
          COVER_GENIUS_API_KEY: apiKey,
          COVER_GENIUS_API_SECRET: apiSecret,
          COVER_GENIUS_PRODUCTS: products,
          COVER_GENIUS_LICENSED_ENTITY: licensedEntity,
          COVER_GENIUS_COMMISSION_DISCLOSURE: commissionDisclosure,
        }),
      );
    }
    out.insurance = { provider: 'cover-genius', baseUrl, partnerCode, apiKey, apiSecret, products, disclosures: { licensedEntity, commissionDisclosure }, ...transport };
  }
  if (config.PROVIDER_ORG_IDP === 'workos') {
    const { WORKOS_CLIENT_ID: clientId, WORKOS_API_KEY: apiKey, WORKOS_WEBHOOK_SECRET: webhookSecret } = config;
    if (!clientId || !apiKey || !webhookSecret) throw new Error(needs('PROVIDER_ORG_IDP=workos', { WORKOS_CLIENT_ID: clientId, WORKOS_API_KEY: apiKey, WORKOS_WEBHOOK_SECRET: webhookSecret }));
    out.orgIdp = { provider: 'workos', clientId, apiKey, webhookSecret, ...transport };
  }
  if (config.PROVIDER_FEDERATED_IDP === 'oidc') {
    const { APPLE_CLIENT_ID: appleClient, APPLE_TEAM_ID: teamId, APPLE_KEY_ID: keyId, APPLE_PRIVATE_KEY: privateKey, GOOGLE_CLIENT_ID: googleClient, GOOGLE_CLIENT_SECRET: googleSecret } = config;
    if (!appleClient || !teamId || !keyId || !privateKey || !googleClient || !googleSecret) {
      throw new Error(
        needs('PROVIDER_FEDERATED_IDP=oidc (Apple and Google come together)', {
          APPLE_CLIENT_ID: appleClient,
          APPLE_TEAM_ID: teamId,
          APPLE_KEY_ID: keyId,
          APPLE_PRIVATE_KEY: privateKey,
          GOOGLE_CLIENT_ID: googleClient,
          GOOGLE_CLIENT_SECRET: googleSecret,
        }),
      );
    }
    out.federatedIdp = { provider: 'oidc', apple: { clientId: appleClient, teamId, keyId, privateKey }, google: { clientId: googleClient, clientSecret: googleSecret }, ...transport };
  }
  if (config.PROVIDER_FUNDING === 'stripe') {
    const { STRIPE_API_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecrets, STRIPE_PLAN_PRODUCTS: planProducts } = config;
    if (!secretKey || !webhookSecrets || !planProducts) throw new Error(needs('PROVIDER_FUNDING=stripe', { STRIPE_API_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecrets, STRIPE_PLAN_PRODUCTS: planProducts }));
    out.funding = { provider: 'stripe', secretKey, webhookSecrets, planProducts, ...transport };
  }
  if (config.PROVIDER_NOTIFY_SMS === 'twilio') {
    const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_FROM_SMS: from, TWILIO_TEMPLATES: templates } = config;
    if (!accountSid || !authToken || !from || !templates) throw new Error(needs('PROVIDER_NOTIFY_SMS=twilio', { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_FROM_SMS: from, TWILIO_TEMPLATES: templates }));
    out.notifySms = { provider: 'twilio', accountSid, authToken, from, templates, ...transport };
  }
  if (config.PROVIDER_NOTIFY_EMAIL === 'postmark') {
    const { POSTMARK_SERVER_TOKEN: serverToken, POSTMARK_FROM: from, POSTMARK_TEMPLATES: templates } = config;
    if (!serverToken || !from || !templates) throw new Error(needs('PROVIDER_NOTIFY_EMAIL=postmark', { POSTMARK_SERVER_TOKEN: serverToken, POSTMARK_FROM: from, POSTMARK_TEMPLATES: templates }));
    out.notifyEmail = { provider: 'postmark', serverToken, from, templates, ...transport };
  }
  if (config.PROVIDER_NOTIFY_PUSH === 'expo') {
    const { EXPO_ACCESS_TOKEN: accessToken, EXPO_TEMPLATES: templates } = config;
    if (!accessToken || !templates) throw new Error(needs('PROVIDER_NOTIFY_PUSH=expo', { EXPO_ACCESS_TOKEN: accessToken, EXPO_TEMPLATES: templates }));
    out.notifyPush = { provider: 'expo', accessToken, templates, ...transport };
  }
  return out;
}

/**
 * The registry's overrides for a process's config, with the Crowded key ledger in Postgres so a restart loses no key. The config
 * has already refused a `crowded` choice without all three Crowded keys; the check here only narrows the types and fails closed.
 */
export function overridesFromConfig(config: ProviderConfig, db: SqlClient, warn?: (message: string) => void, fetch?: typeof globalThis.fetch): RegistryOverrides {
  // `fetch` is the transport for the marketplace and identity adapters (T-0042); tests inject a fake vendor, a process passes none.
  const marketplace = marketplaceOverrides(config, fetch);
  if (config.PROVIDER_INSTITUTION_BANKING !== 'crowded') {
    // A stray live binds nothing while the port is on the simulator; say so rather than accept it silently.
    if (config.CROWDED_BINDING === 'live') warn?.(IGNORED_LIVE_BINDING_WARNING);
    return marketplace;
  }
  const { CROWDED_BASE_URL: baseUrl, CROWDED_API_TOKEN: token, CROWDED_WEBHOOK_SECRETS: webhookSecrets } = config;
  if (!baseUrl || !token || !webhookSecrets) throw new Error('PROVIDER_INSTITUTION_BANKING=crowded needs CROWDED_BASE_URL, CROWDED_API_TOKEN and CROWDED_WEBHOOK_SECRETS');
  return { ...marketplace, institutionBanking: { provider: 'crowded', baseUrl, token, webhookSecrets, binding: config.CROWDED_BINDING === 'live' ? 'live' : 'sandbox', ...(warn ? { warn } : {}), keys: (now) => new PostgresVendorKeyLedger(db, CROWDED_PROVIDER, now) } };
}

/** The Crowded webhook secrets the receiver verifies with: the configured ones on `crowded`, none otherwise (every delivery is refused, as before). */
export function crowdedWebhookSecrets(config: ProviderConfig): string[] {
  return config.PROVIDER_INSTITUTION_BANKING === 'crowded' ? (config.CROWDED_WEBHOOK_SECRETS ?? []).map((s) => s.reveal()) : [];
}
