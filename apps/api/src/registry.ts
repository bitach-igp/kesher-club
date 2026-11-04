// The provider registry a process runs on (T-0021). `sim` binds every port to the in-process
// simulators (previews and staging until ADR-006 names a processor); the config refuses any other
// global mode until a vendor adapter is chosen for it. A port can be overridden on its own (T-0659):
// `institution-banking` binds to the Crowded adapter and every other port stays on the simulators.
// Tests keep their own SimulatorHost on a fixed clock; a running process gets the wall clock, which
// the simulators' control panel may still nudge forward.
import {
  CROWDED_SIGNATURE_HEADER,
  CrowdedClient,
  CrowdedInstitutionBankingAdapter,
  crowdedHeaderValue,
  verifyCrowdedSignature,
  type KeyLedger,
} from '@kesher/adapters';
import type { Secret } from '@kesher/domain';
import type { AdvanceableClock, ProviderRegistry } from '@kesher/ports';
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

export interface RegistryOverrides {
  institutionBanking?: CrowdedBankingOverride;
}

/** The provider each overridable port runs on, for the start-up log. Never a credential. */
export type ProviderSummary = Record<'institution-banking', 'sim' | 'crowded'>;

export function createRegistry(
  mode: string,
  clock: AdvanceableClock = systemClock(),
  overrides: RegistryOverrides = {},
): { registry: ProviderRegistry; simulators: SimulatorHost; providers: ProviderSummary } {
  // The config already refuses anything but `sim` (T-0020); this guards a caller that skipped it.
  if (mode !== 'sim') throw new Error(`No vendor adapters are wired for provider mode "${mode}" yet (ADR-006)`);
  const simulators = new SimulatorHost(clock);
  const providers: ProviderSummary = { 'institution-banking': 'sim' };
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
}

/**
 * The registry's overrides for a process's config, with the Crowded key ledger in Postgres so a restart loses no key. The config
 * has already refused a `crowded` choice without all three Crowded keys; the check here only narrows the types and fails closed.
 */
export function overridesFromConfig(config: ProviderConfig, db: SqlClient, warn?: (message: string) => void): RegistryOverrides {
  if (config.PROVIDER_INSTITUTION_BANKING !== 'crowded') {
    // A stray live binds nothing while the port is on the simulator; say so rather than accept it silently.
    if (config.CROWDED_BINDING === 'live') warn?.(IGNORED_LIVE_BINDING_WARNING);
    return {};
  }
  const { CROWDED_BASE_URL: baseUrl, CROWDED_API_TOKEN: token, CROWDED_WEBHOOK_SECRETS: webhookSecrets } = config;
  if (!baseUrl || !token || !webhookSecrets) throw new Error('PROVIDER_INSTITUTION_BANKING=crowded needs CROWDED_BASE_URL, CROWDED_API_TOKEN and CROWDED_WEBHOOK_SECRETS');
  return { institutionBanking: { provider: 'crowded', baseUrl, token, webhookSecrets, binding: config.CROWDED_BINDING === 'live' ? 'live' : 'sandbox', ...(warn ? { warn } : {}), keys: (now) => new PostgresVendorKeyLedger(db, CROWDED_PROVIDER, now) } };
}

/** The Crowded webhook secrets the receiver verifies with: the configured ones on `crowded`, none otherwise (every delivery is refused, as before). */
export function crowdedWebhookSecrets(config: ProviderConfig): string[] {
  return config.PROVIDER_INSTITUTION_BANKING === 'crowded' ? (config.CROWDED_WEBHOOK_SECRETS ?? []).map((s) => s.reveal()) : [];
}
