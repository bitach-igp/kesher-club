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
export type OtpPurpose = 'register' | 'recovery';

export interface AuthApi {
  startOtp(input: { phone: string; locale: Locale }): Promise<OtpStart>;
  verifyOtp(input: { otpId: string; code: string; purpose: OtpPurpose }): Promise<OtpVerify>;
  /** Two-step: no `response` returns options; with it, the credential and tokens. */
  registerPasskey(input: { deviceName?: string; response?: unknown }): Promise<PasskeyRegisterResult>;
  authenticatePasskey(input: { deviceId?: string; response?: unknown }): Promise<PasskeyAuthenticateResult>;
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

/** Binds the generated SDK client. `extras` cover operations the contract does not expose yet. */
export function sdkApi(client: Client, _session: Session, extras: { esim: EsimUsageApi; concierge: ConciergeApi; invites: InvitesApi }): Api {
  return {
    auth: {
      startOtp: ({ phone, locale }) => client.post('/auth/otp', { body: { phone, locale } }),
      verifyOtp: ({ otpId, code, purpose }) => client.post('/auth/otp/verify', { body: { otpId, code, purpose } }),
      registerPasskey: ({ deviceName, response }) =>
        client.post('/auth/passkeys/register', { body: { ...(deviceName !== undefined ? { deviceName } : {}), ...(response !== undefined ? { response: response as Record<string, never> } : {}) } }),
      authenticatePasskey: ({ deviceId, response }) =>
        client.post('/auth/passkeys/authenticate', { body: { ...(deviceId !== undefined ? { deviceId } : {}), ...(response !== undefined ? { response: response as Record<string, never> } : {}) } }),
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
