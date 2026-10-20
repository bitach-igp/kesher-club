// Narrow API surfaces per screen, bound to the typed SDK client in `sdkApi()`. View models depend
// on these interfaces only, so tests inject fakes and no screen touches `fetch` or vendor code.
import { createContext, useContext } from 'react';
import type { Client, Schemas } from '@kesher/sdk';
import type { EsimUsage } from '@kesher/ports';
import type { Locale } from './i18n.ts';
import type { Session } from './session.ts';

export type OtpStart = Schemas['OtpStart'];
export type OtpVerify = Schemas['OtpVerify'];
export type PasskeyRegisterResult = Schemas['PasskeyRegisterResult'];
export type PasskeyAuthenticateResult = Schemas['PasskeyAuthenticateResult'];
export type CatalogueItem = Schemas['CatalogueItem'];
export type AddonOrder = Schemas['AddonOrder'];
export type AgentGrant = Schemas['AgentGrant'];
export type Capabilities = Schemas['Capabilities'];
export type Card = Schemas['Card'];
export type CardControlsPatch = Schemas['CardControlsPatch'];
export type ShipTo = Schemas['ShipTo'];
export type ProvisioningPayload = Schemas['ProvisioningPayload'];
export type KycStatus = Schemas['KycStatus'];
export type KycSessionStarted = Schemas['KycSessionStarted'];
export type Account = Schemas['Account'];
export type Transfer = Schemas['Transfer'];
export type TransferPreview = Schemas['TransferPreview'];
export type Preferences = Schemas['Preferences'];
export type ServiceStatus = Schemas['ServiceStatus'];
export type CapabilityState = Schemas['CapabilityState'];
export type ReceiveCurrency = Preferences['receiveCurrency'];
export type PaymentRequest = Schemas['PaymentRequest'];
export type PaidPaymentRequest = Schemas['PaidPaymentRequest'];
export type Split = Schemas['Split'];
export type MoneyWire = Schemas['Money'];
export type Transaction = Schemas['Transaction'];
export type TransactionPage = Schemas['TransactionPage'];
export type FxQuote = Schemas['FxQuote'];
export type Load = Schemas['Load'];
export type AutoReloadRule = Schemas['AutoReloadRule'];
export type MemberIntent = Schemas['MemberIntent'];
export type ApprovedIntent = Schemas['ApprovedIntent'];
export type AutoReloadRuleRequest = Schemas['AutoReloadRuleRequest'];
export type FxConversion = Schemas['FxConversion'];
export type OtpPurpose = 'register' | 'recovery';

export interface AuthApi {
  startOtp(input: { phone: string; locale: Locale }): Promise<OtpStart>;
  verifyOtp(input: { otpId: string; code: string; purpose: OtpPurpose }): Promise<OtpVerify>;
  /** Two-step: no `response` returns options; with it, the credential and tokens. The binding adds this install's device id. */
  registerPasskey(input: { deviceName?: string; purpose: OtpPurpose; response?: unknown }): Promise<PasskeyRegisterResult>;
  authenticatePasskey(input: { response?: unknown }): Promise<PasskeyAuthenticateResult>;
}

export interface ClubApi {
  listCatalogue(): Promise<{ items: readonly CatalogueItem[] }>;
  createAddonOrder(input: { sku: string }, idempotencyKey: string): Promise<AddonOrder>;
  getCapabilities(): Promise<Capabilities>;
}

/** Usage has no public endpoint yet (T-0710 exposes it through the gateway); the port's shape is reused. */
export interface EsimUsageApi {
  getUsage(iccid: string): Promise<EsimUsage>;
}

export interface GrantsApi {
  listAgentGrants(): Promise<{ items: readonly AgentGrant[] }>;
  revokeAgentGrant(id: string): Promise<void>;
}

/** M06 identity verification (T-0408): start a T2 session and poll where it stands. */
export interface KycApi {
  status(): Promise<KycStatus>;
  start(tier: 'T1' | 'T2', idempotencyKey: string): Promise<KycSessionStarted>;
}

/** M20–M24 card screens (T-0408). Status, controls and tokens only; the details token opens the processor's component. */
export interface CardsApi {
  listCards(): Promise<{ items: readonly Card[] }>;
  getCard(id: string): Promise<Card>;
  setStatus(id: string, status: 'frozen' | 'active' | 'closed', idempotencyKey: string, reason?: 'lost' | 'stolen' | 'damaged' | 'other'): Promise<Card>;
  updateControls(id: string, patch: CardControlsPatch, idempotencyKey: string): Promise<Card>;
  orderPhysical(shipTo: ShipTo, idempotencyKey: string): Promise<Card>;
  activate(id: string, last4: string, idempotencyKey: string): Promise<Card>;
  detailsToken(id: string): Promise<{ token: string; expiresAt: string }>;
  startProvisioning(id: string, wallet: 'apple' | 'google', deviceId: string, clientData: Record<string, string>, idempotencyKey: string): Promise<ProvisioningPayload>;
}

/** M12–M19 pay screens (T-0508): purses, sends, requests and splits over the P2P contract (T-0505..T-0507). */
export interface PayApi {
  listAccounts(): Promise<{ items: readonly Account[] }>;
  send(input: { toPartyId: string; amount: MoneyWire; note?: string }, idempotencyKey: string): Promise<Transfer>;
  /** What a send would land as in the recipient's purse, priced as the send prices it (T-0518). Moves nothing. */
  preview(input: { toPartyId: string; amount: MoneyWire }): Promise<TransferPreview>;
  cancelTransfer(id: string, idempotencyKey: string): Promise<Transfer>;
  listRequests(): Promise<{ items: readonly PaymentRequest[] }>;
  createRequest(input: { payerPartyId: string; amount: MoneyWire; note?: string }, idempotencyKey: string): Promise<PaymentRequest>;
  createSplit(input: { total: MoneyWire; participants: string[]; note?: string }, idempotencyKey: string): Promise<Split>;
  payRequest(id: string, idempotencyKey: string): Promise<PaidPaymentRequest>;
  declineRequest(id: string, idempotencyKey: string): Promise<PaymentRequest>;
}

/** The public status of each money capability and the incident while one is switched off (T-0911). */
export interface StatusApi {
  get(): Promise<ServiceStatus>;
}

/** M33 receiving currency (T-0514): which purse money sent to the member lands in. */
export interface PreferencesApi {
  get(): Promise<Preferences>;
  set(receiveCurrency: ReceiveCurrency): Promise<Preferences>;
}

/** M08–M10 home, balance and transaction detail (T-0511): purses, the transaction history per purse, identity and card status. */
export interface WalletApi {
  listAccounts(): Promise<{ items: readonly Account[] }>;
  listTransactions(accountId: string, cursor?: string): Promise<TransactionPage>;
}

/** M11 convert (T-0509): a 30 s quote and the conversion at it. */
export interface FxApi {
  quote(input: { from: MoneyWire; to: 'USD' | 'ILS' }, idempotencyKey: string): Promise<FxQuote>;
  convert(quoteId: string, idempotencyKey: string): Promise<FxConversion>;
}

/** Someone the signed-in person may load money for (T-0524). */
export interface FundMember {
  partyId: string;
  /** The signed-in member's own purses. */
  self: boolean;
  name?: string | undefined;
}

/** P07 add money (T-0524): a one-time load into a member's purse. */
export interface FundApi {
  members(): Promise<readonly FundMember[]>;
  createLoad(input: { memberPartyId: string; amount: MoneyWire; method: 'card' | 'apple_pay' | 'google_pay' | 'ach'; purseCurrency: 'USD' | 'ILS' }, idempotencyKey: string): Promise<Load>;
}

/** M35 (T-1012): what an assistant proposed, read, approved under a passkey, or declined (T-1011's API). */
export interface ProposalsApi {
  list(state?: MemberIntent['status']): Promise<{ items: readonly MemberIntent[] }>;
  get(id: string): Promise<MemberIntent>;
  /** A load proposal names no funding method, so its approval carries one. */
  approve(id: string, idempotencyKey: string, funding?: { method: 'card' | 'apple_pay' | 'google_pay' | 'ach' }): Promise<ApprovedIntent>;
  decline(id: string, idempotencyKey: string): Promise<MemberIntent>;
}

/** A payment method saved at the funding vendor; the app holds only its id and a label, never card data. */
export interface SavedPaymentMethod {
  id: string;
  label: string;
}

/** P07 auto-reload (T-0525): the rule on one purse. */
export interface AutoReloadApi {
  /** NOT_FOUND when the member has set none. */
  get(accountId: string): Promise<AutoReloadRule>;
  set(accountId: string, rule: AutoReloadRuleRequest, idempotencyKey: string): Promise<AutoReloadRule>;
  /** Saved methods the rule may charge. Listing them is P08's; until then the shell supplies them. */
  paymentMethods(): Promise<readonly SavedPaymentMethod[]>;
}

export interface EmergencyCase {
  caseId: string;
  callbackSlaMinutes: number;
}

/** Bridge to the concierge case system (T-0730 adapter, wired by the API). The mobile app only sees this. */
export interface ConciergeApi {
  openEmergencyCase(
    input: { locale: Locale; note?: string; location?: { lat: number; lng: number; accuracyM: number }; notifyFunder: boolean },
    idempotencyKey: string,
  ): Promise<EmergencyCase>;
}

export type InviteStatus = 'open' | 'expired' | 'accepted';
export interface InvitePreview {
  funderName: string;
  institutionName?: string;
  planCode: string;
  planName: string;
  status: InviteStatus;
}

/** Invite links (M04). The contract has no public invite path yet (T-0603 keeps it institution-side), so it is an extra. */
export interface InvitesApi {
  preview(token: string): Promise<InvitePreview>;
  accept(token: string, idempotencyKey: string): Promise<{ membershipId: string }>;
}

export interface Api {
  auth: AuthApi;
  club: ClubApi;
  kyc: KycApi;
  cards: CardsApi;
  pay: PayApi;
  preferences: PreferencesApi;
  status: StatusApi;
  wallet: WalletApi;
  fx: FxApi;
  fund: FundApi;
  reload: AutoReloadApi;
  proposals: ProposalsApi;
  esim: EsimUsageApi;
  grants: GrantsApi;
  concierge: ConciergeApi;
  invites: InvitesApi;
}

export const ApiContext = createContext<Api | undefined>(undefined);
export const ApiProvider = ApiContext.Provider;
export function useApi(): Api {
  const a = useContext(ApiContext);
  if (!a) throw new Error('ApiProvider is missing');
  return a;
}

/** The access token's subject: the signed-in party. Read for display and routing only; the API verifies it. */
export function subjectOf(accessToken: string | undefined): string | undefined {
  const payload = accessToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const sub = (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** Binds the generated SDK client. `extras` cover operations the contract does not expose yet. */
export function sdkApi(client: Client, session: Session, extras: { esim: EsimUsageApi; concierge: ConciergeApi; invites: InvitesApi; paymentMethods?: () => Promise<readonly SavedPaymentMethod[]> }): Api {
  return {
    auth: {
      startOtp: ({ phone, locale }) => client.post('/auth/otp', { body: { phone, locale } }),
      verifyOtp: ({ otpId, code, purpose }) => client.post('/auth/otp/verify', { body: { otpId, code, purpose } }),
      registerPasskey: ({ deviceName, purpose, response }) =>
        client.post('/auth/passkeys/register', { body: { deviceId: session.deviceId(), purpose, ...(deviceName !== undefined ? { deviceName } : {}), ...(response !== undefined ? { response: response as Record<string, never> } : {}) } }),
      authenticatePasskey: ({ response }) =>
        client.post('/auth/passkeys/authenticate', { body: { deviceId: session.deviceId(), ...(response !== undefined ? { response: response as Record<string, never> } : {}) } }),
    },
    club: {
      listCatalogue: () => client.get('/catalogue'),
      createAddonOrder: ({ sku }, idempotencyKey) => client.post('/addon-orders', { body: { sku, quantity: 1 }, idempotencyKey }),
      getCapabilities: () => client.get('/me/capabilities'),
    },
    kyc: {
      status: () => client.get('/kyc/status'),
      start: (tier, idempotencyKey) => client.post('/kyc/sessions', { body: { tier }, idempotencyKey }),
    },
    cards: {
      listCards: () => client.get('/cards'),
      getCard: (id) => client.get('/cards/{id}', { path: { id } }),
      setStatus: (id, status, idempotencyKey, reason) => client.post('/cards/{id}/status', { path: { id }, body: { status, ...(reason ? { reason } : {}) }, idempotencyKey }),
      updateControls: (id, patch, idempotencyKey) => client.patch('/cards/{id}/controls', { path: { id }, body: patch, idempotencyKey }),
      orderPhysical: (shipTo, idempotencyKey) => client.post('/cards/physical', { body: { shipTo }, idempotencyKey }),
      activate: (id, last4, idempotencyKey) => client.post('/cards/{id}/activate', { path: { id }, body: { last4 }, idempotencyKey }),
      detailsToken: (id) => client.post('/cards/{id}/details-token', { path: { id } }),
      startProvisioning: (id, wallet, deviceId, clientData, idempotencyKey) => client.post('/cards/{id}/provisioning/{wallet}', { path: { id, wallet }, body: { deviceId, clientData }, idempotencyKey }),
    },
    pay: {
      listAccounts: () => client.get('/accounts'),
      send: (input, idempotencyKey) => client.post('/transfers', { body: input, idempotencyKey }),
      preview: (input) => client.post('/transfers/preview', { body: input }),
      cancelTransfer: (id, idempotencyKey) => client.post('/transfers/{id}/cancel', { path: { id }, idempotencyKey }),
      listRequests: () => client.get('/requests'),
      createRequest: (input, idempotencyKey) => client.post('/requests', { body: input, idempotencyKey }),
      createSplit: (input, idempotencyKey) => client.post('/splits', { body: input, idempotencyKey }),
      payRequest: (id, idempotencyKey) => client.post('/requests/{id}/pay', { path: { id }, idempotencyKey }),
      declineRequest: (id, idempotencyKey) => client.post('/requests/{id}/decline', { path: { id }, idempotencyKey }),
    },
    status: {
      get: () => client.get('/status'),
    },
    preferences: {
      get: () => client.get('/me/preferences'),
      set: (receiveCurrency) => client.patch('/me/preferences', { body: { receiveCurrency } }),
    },
    wallet: {
      listAccounts: () => client.get('/accounts'),
      listTransactions: (id, cursor) => client.get('/accounts/{id}/transactions', { path: { id }, ...(cursor ? { query: { cursor } } : {}) }),
    },
    fx: {
      quote: (input, idempotencyKey) => client.post('/fx/quotes', { body: input, idempotencyKey }),
      convert: (quoteId, idempotencyKey) => client.post('/fx/conversions', { body: { quoteId }, idempotencyKey }),
    },
    fund: {
      // A funder's members would come from GET /households, which answers FEATURE_OFF until it is built,
      // so for now the signed-in member loads their own purses (T-0524).
      members: async () => {
        const self = subjectOf(session.accessToken());
        return self ? [{ partyId: self, self: true }] : [];
      },
      createLoad: (input, idempotencyKey) => client.post('/loads', { body: input, idempotencyKey }),
    },
    reload: {
      get: (id) => client.get('/accounts/{id}/auto-reload', { path: { id } }),
      set: (id, rule, idempotencyKey) => client.post('/accounts/{id}/auto-reload', { path: { id }, body: rule, idempotencyKey }),
      paymentMethods: extras.paymentMethods ?? (async () => []),
    },
    proposals: {
      list: (state) => client.get('/intents', state ? { query: { state } } : {}),
      get: (id) => client.get('/intents/{id}', { path: { id } }),
      approve: (id, idempotencyKey, funding) => client.post('/intents/{id}/approve', { path: { id }, idempotencyKey, ...(funding ? { body: funding } : {}) }),
      decline: (id, idempotencyKey) => client.post('/intents/{id}/decline', { path: { id }, idempotencyKey }),
    },
    esim: extras.esim,
    grants: {
      listAgentGrants: () => client.get('/agent-grants'),
      revokeAgentGrant: (id) => client.delete('/agent-grants/{id}', { path: { id } }),
    },
    concierge: extras.concierge,
    invites: extras.invites,
  };
}

/** True for an `ApiError` (or any problem-shaped error) with the given code or status. */
export function errorIs(e: unknown, match: { code?: string; status?: number }): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; status?: unknown };
  if (match.code !== undefined && err.code === match.code) return true;
  if (match.status !== undefined && err.status === match.status) return true;
  return false;
}
