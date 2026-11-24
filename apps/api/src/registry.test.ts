// T-0659 (REQ-INS-022, REQ-INS-025): the provider registry a process runs on. `sim` binds every port to the
// simulators; a per-port override binds `institution-banking` to the Crowded adapter and nothing else.
import { AiraloEsimAdapter, FakeStripe, StripeBillingAdapter, StripeFundingAdapter, FederatedIdPRouter, AppleFederatedIdPAdapter, CoverGeniusInsuranceAdapter, GoogleFederatedIdPAdapter, WorkOsOrgIdPAdapter, computeCrowdedSignature, CrowdedInstitutionBankingAdapter, FakeCrowded, InMemoryKeyLedger, SANDBOX_BASE_URL, type KeyLedger } from '@kesher/adapters';
import { generateKeyPairSync } from 'node:crypto';
import { createMetrics, Secret } from '@kesher/domain';
import { fixedClock, NotifyError, type AdvanceableClock, type BillingPort, type EsimPort, type FederatedIdPPort, type FundingPort, type InstitutionBankingPort, type InsurancePort, type NotifyPort, type OrgIdPPort } from '@kesher/ports';
import { PORTS } from '@kesher/ports';
import { describe, expect, it } from 'vitest';
import { handle } from '@kesher/simulators';
import { simulatorFlagViolations } from './config.ts';
import type { SqlClient } from './db.ts';
import { createRegistry, crowdedWebhookSecrets, IGNORED_LIVE_BINDING_WARNING, LIVE_BINDING_WARNING, overridesFromConfig, systemClock, type CrowdedBankingOverride } from './registry.ts';

const BASE = 'https://crowded.test/api/v1';
const TOKEN = 'crowded-token-do-not-print';
const CURRENT = 'whsec-current-0123456789';
const PREVIOUS = 'whsec-previous-0123456789';
const MARKETS = ['IL', 'US'] as const;
const ALL_SIM = { 'institution-banking': 'sim', esim: 'sim', insurance: 'sim', 'org-idp': 'sim', 'federated-idp': 'sim', funding: 'sim', 'notify-sms': 'sim', 'notify-email': 'sim', 'notify-push': 'sim' };

const override = (extra: Partial<CrowdedBankingOverride> = {}): CrowdedBankingOverride => ({
  provider: 'crowded',
  baseUrl: BASE,
  token: new Secret(TOKEN),
  webhookSecrets: [new Secret(CURRENT)],
  ...extra,
});
const crowded = (extra: Partial<CrowdedBankingOverride> = {}) => createRegistry('sim', systemClock(), { institutionBanking: override(extra) });

describe('createRegistry (T-0021, T-0659)', () => {
  it('sim: every port is the simulator, as before, and the banking port says so', () => {
    const { registry, simulators, providers } = createRegistry('sim');
    for (const market of MARKETS) {
      expect(registry.resolve('institution-banking', market)).toBe(simulators.simulators['institution-banking']);
      expect(registry.bindingFor('institution-banking', market)).toMatchObject({ provider: 'simulator', mode: 'sim' });
    }
    expect(providers).toEqual(ALL_SIM);
  });

  it('sandbox is the same registry under the staging label; live and anything else are refused (T-0040)', () => {
    const { registry, simulators, providers } = createRegistry('sandbox');
    expect(registry.resolve('institution-banking', 'US')).toBe(simulators.simulators['institution-banking']);
    expect(providers).toEqual(ALL_SIM);
    expect(() => createRegistry('live')).toThrow(/not accepted/);
  });

  it('sim with an empty override list is the same registry', () => {
    const { registry, simulators } = createRegistry('sim', systemClock(), {});
    expect(registry.resolve('institution-banking', 'US')).toBe(simulators.simulators['institution-banking']);
  });

  it('the override is per port: sandbox labels the environment and the override still binds only its port; live is refused', () => {
    const { registry, simulators } = createRegistry('sandbox', systemClock(), { institutionBanking: override() });
    expect(registry.bindingFor('institution-banking', 'US')).toMatchObject({ provider: 'crowded' });
    expect(registry.resolve('esim', 'US')).toBe(simulators.simulators['esim']);
    expect(() => createRegistry('live')).toThrow(/Provider mode "live"/);
  });

  it('crowded binds institution-banking, in both markets, to the Crowded adapter', () => {
    const { registry, providers } = crowded();
    for (const market of MARKETS) {
      expect(registry.resolve<InstitutionBankingPort>('institution-banking', market)).toBeInstanceOf(CrowdedInstitutionBankingAdapter);
      expect(registry.bindingFor('institution-banking', market)).toMatchObject({ provider: 'crowded' });
    }
    expect(providers).toEqual({ ...ALL_SIM, 'institution-banking': 'crowded' });
  });

  it('binds in sandbox mode for any base URL, the sandbox one or not, and says nothing', () => {
    const warnings: string[] = [];
    for (const baseUrl of [BASE, SANDBOX_BASE_URL, 'https://api.crowdedfinance.com/api/v1']) {
      const { registry } = crowded({ baseUrl, warn: (m) => warnings.push(m) });
      for (const market of MARKETS) expect(registry.bindingFor('institution-banking', market)).toMatchObject({ provider: 'crowded', mode: 'sandbox' });
    }
    expect(warnings).toEqual([]);
  });

  it('binds live only when asked explicitly, and warns that the approval is not applied by an env switch', () => {
    const warnings: string[] = [];
    const { registry } = crowded({ binding: 'live', warn: (m) => warnings.push(m) });
    for (const market of MARKETS) expect(registry.bindingFor('institution-banking', market)).toMatchObject({ provider: 'crowded', mode: 'live' });
    expect(warnings).toEqual([LIVE_BINDING_WARNING]);
    expect(warnings[0]).toMatch(/provider_binding approval in ops\.approval_request is not applied by an env switch/);
    expect(warnings[0]).not.toContain(TOKEN);
  });

  it('crowded leaves every other port on its simulator', () => {
    const { registry, simulators } = crowded();
    const others = PORTS.map((p) => p.capability).filter((c) => c !== 'institution-banking' && c in simulators.simulators);
    expect(others.length).toBeGreaterThan(5);
    for (const capability of others) {
      for (const market of MARKETS) {
        expect(registry.resolve(capability, market)).toBe((simulators.simulators as unknown as Record<string, unknown>)[capability]);
        expect(registry.bindingFor(capability, market)).toMatchObject({ provider: 'simulator', mode: 'sim' });
      }
    }
  });

  it('resolves one adapter instance, so its key ledger and client are shared', () => {
    const { registry } = crowded();
    expect(registry.resolve('institution-banking', 'US')).toBe(registry.resolve('institution-banking', 'IL'));
    expect(registry.resolve('institution-banking', 'US')).toBe(registry.resolve('institution-banking', 'US'));
  });

  it('talks to the configured base URL with the configured token', async () => {
    const fake = new FakeCrowded({ token: TOKEN });
    const { registry } = crowded({ fetch: fake.fetch });
    const port = registry.resolve<InstitutionBankingPort>('institution-banking', 'US');
    await port.createEntity({ holder: 'institution', institutionId: 'inst-1', legalName: 'American Friends of Amuta', ein: '12-3456789', idempotencyKey: 'key-0001-entity' });
    expect(fake.calls.map((c) => c.method + ' ' + c.path)).toContain('POST /organizations');
  });

  it('a wrong token reaches Crowded as a refusal and does not echo the token', async () => {
    const fake = new FakeCrowded({ token: 'another-token' });
    const { registry } = crowded({ fetch: fake.fetch });
    const port = registry.resolve<InstitutionBankingPort>('institution-banking', 'US');
    const err = await port.createEntity({ holder: 'institution', institutionId: 'inst-1', legalName: 'American Friends of Amuta', ein: '12-3456789', idempotencyKey: 'key-0001-entity' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it('the key ledger is the one given, built on the registry clock, and a retry is answered from it', async () => {
    const fake = new FakeCrowded({ token: TOKEN });
    const clock = systemClock();
    clock.advance(86_400_000);
    const ledger = new InMemoryKeyLedger();
    const seen: Date[] = [];
    const { registry } = createRegistry('sim', clock, {
      institutionBanking: override({
        fetch: fake.fetch,
        keys: (now): KeyLedger => {
          seen.push(now());
          return ledger;
        },
      }),
    });
    expect(seen).toHaveLength(1);
    expect(Math.abs(seen[0]!.getTime() - clock.now().getTime())).toBeLessThan(5_000);
    expect(seen[0]!.getTime()).toBeGreaterThan(Date.now() + 80_000_000);

    const port = registry.resolve<InstitutionBankingPort>('institution-banking', 'US');
    const input = { holder: 'institution' as const, institutionId: 'inst-1', legalName: 'American Friends of Amuta', ein: '12-3456789', idempotencyKey: 'key-0002-entity' };
    const first = await port.createEntity(input);
    expect(await ledger.get('entity:key-0002-entity')).toMatchObject({ result: first });
    const posts = fake.calls.filter((c) => c.method === 'POST').length;
    expect(await port.createEntity(input)).toEqual(first);
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);
  });

  it('verifies a webhook batch with the configured secrets, the previous one too, and refuses any other', async () => {
    const { registry } = crowded({ webhookSecrets: [new Secret(CURRENT), new Secret(PREVIOUS)] });
    const port = registry.resolve<InstitutionBankingPort>('institution-banking', 'US');
    const raw = JSON.stringify({ events: [{ eventId: 'ev-1', eventType: 'finance.application.approved', timestamp: '2026-11-03T09:00:00Z', context: { chapterId: 'ch1' }, data: {} }] });
    const sign = (secret: string) => ({ 'X-Webhook-Signature': computeCrowdedSignature(secret, raw) });
    expect(await port.parseWebhook(sign(CURRENT), raw)).toMatchObject({ events: [{ eventId: 'ev-1' }] });
    expect(await port.parseWebhook(sign(PREVIOUS), raw)).toMatchObject({ events: [{ eventId: 'ev-1' }] });
    expect(await port.parseWebhook(sign('whsec-someone-elses'), raw)).toEqual({ rejected: 'BAD_SIGNATURE' });
    expect(await port.parseWebhook({ 'x-webhook-signature': 'sha256=sim' }, raw)).toEqual({ rejected: 'BAD_SIGNATURE' });
    expect(await port.parseWebhook({}, raw)).toEqual({ rejected: 'BAD_SIGNATURE' });
  });

  it('refuses a base URL that is not https, without echoing the token', () => {
    const err = (() => {
      try {
        crowded({ baseUrl: 'http://crowded.test' });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a throw');
    })();
    expect(err.message).toMatch(/needs an https baseUrl/);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('overridesFromConfig (T-0659)', () => {
  const full = { PROVIDER_INSTITUTION_BANKING: 'crowded' as const, CROWDED_BASE_URL: BASE, CROWDED_API_TOKEN: new Secret(TOKEN), CROWDED_WEBHOOK_SECRETS: [new Secret(CURRENT), new Secret(PREVIOUS)] };
  const recorder = () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const db: SqlClient = {
      async query<R>(text: string, params: readonly unknown[] = []) {
        queries.push({ text, params });
        return { rows: [{ key: 'k' }] as R[], rowCount: 1 };
      },
    };
    return { db, queries };
  };

  it('on the simulator there is nothing to override and no webhook secret reaches the receiver', () => {
    const { db } = recorder();
    expect(overridesFromConfig({ PROVIDER_INSTITUTION_BANKING: 'sim' }, db)).toEqual({});
    expect(overridesFromConfig({ ...full, PROVIDER_INSTITUTION_BANKING: 'sim' }, db)).toEqual({});
    // A stray live on the simulator is accepted, but not silently.
    const warnings: string[] = [];
    expect(overridesFromConfig({ ...full, PROVIDER_INSTITUTION_BANKING: 'sim', CROWDED_BINDING: 'live' }, db, (m) => warnings.push(m))).toEqual({});
    expect(warnings).toEqual([IGNORED_LIVE_BINDING_WARNING]);
    expect(crowdedWebhookSecrets(createRegistry('sim', systemClock(), overridesFromConfig({ ...full, PROVIDER_INSTITUTION_BANKING: 'sim' }, db)).registry, 'US')).toEqual([]);
  });

  it('on crowded it passes the config through and the webhook secrets in order', () => {
    const { db } = recorder();
    const o = overridesFromConfig(full, db).institutionBanking!;
    expect(o).toMatchObject({ provider: 'crowded', baseUrl: BASE });
    expect(o.token.reveal()).toBe(TOKEN);
    expect(crowdedWebhookSecrets(createRegistry('sim', systemClock(), overridesFromConfig(full, db)).registry, 'US')).toEqual([CURRENT, PREVIOUS]);
  });

  it('maps CROWDED_BINDING to the binding mode: sandbox by default and for any URL, live only when set to live, with the warning', () => {
    const { db } = recorder();
    const warnings: string[] = [];
    expect(overridesFromConfig(full, db, (m) => warnings.push(m)).institutionBanking).toMatchObject({ binding: 'sandbox' });
    expect(overridesFromConfig({ ...full, CROWDED_BASE_URL: 'https://api.crowdedfinance.com/api/v1' }, db).institutionBanking).toMatchObject({ binding: 'sandbox' });
    expect(overridesFromConfig({ ...full, CROWDED_BINDING: 'sandbox' }, db).institutionBanking).toMatchObject({ binding: 'sandbox' });
    const live = overridesFromConfig({ ...full, CROWDED_BINDING: 'live' }, db, (m) => warnings.push(m)).institutionBanking!;
    expect(live.binding).toBe('live');
    expect(warnings).toEqual([]);
    expect(createRegistry('sim', systemClock(), { institutionBanking: live }).registry.bindingFor('institution-banking', 'US')).toMatchObject({ mode: 'live' });
    expect(warnings).toEqual([LIVE_BINDING_WARNING]);
  });

  it('keeps the adapter\'s keys in Postgres, under the crowded provider, stamped by the given clock', async () => {
    const { db, queries } = recorder();
    const at = new Date('2026-11-03T10:00:00Z');
    const ledger = overridesFromConfig(full, db).institutionBanking!.keys!(() => at);
    await ledger.put('entity:k-1', { body: 'h'.repeat(64), result: { entityRef: 'ch1' } });
    expect(queries[0]!.text).toMatch(/insert into ops\.vendor_idempotency/);
    expect(queries[0]!.params).toEqual(['crowded', 'entity:k-1', 'h'.repeat(64), '{"entityRef":"ch1"}', at]);
  });

  it('fails closed if crowded is chosen without a full set, naming keys and never a value', () => {
    const { db } = recorder();
    const err = (() => {
      try {
        overridesFromConfig({ ...full, CROWDED_WEBHOOK_SECRETS: undefined }, db);
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a throw');
    })();
    expect(err.message).toMatch(/CROWDED_WEBHOOK_SECRETS/);
    expect(err.message).not.toContain(TOKEN);
  });
});

// T-0042: the marketplace and identity ports, bound only when chosen.
const APPLE_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CREDS = {
  AIRALO_CLIENT_SECRET: 'airalo-secret-do-not-print',
  COVER_GENIUS_API_SECRET: 'xcover-secret-do-not-print',
  WORKOS_API_KEY: 'sk_workos_do_not_print',
  GOOGLE_CLIENT_SECRET: 'google-secret-do-not-print',
};
const chosen = {
  PROVIDER_ESIM: 'airalo' as const,
  AIRALO_BASE_URL: 'https://sandbox-partners-api.airalo.com',
  AIRALO_CLIENT_ID: new Secret('airalo-id'),
  AIRALO_CLIENT_SECRET: new Secret(CREDS.AIRALO_CLIENT_SECRET),
  PROVIDER_INSURANCE: 'cover-genius' as const,
  COVER_GENIUS_BASE_URL: 'https://api.sandbox.xcover.com',
  COVER_GENIUS_PARTNER_CODE: new Secret('KESHER'),
  COVER_GENIUS_API_KEY: new Secret('xcover-key'),
  COVER_GENIUS_API_SECRET: new Secret(CREDS.COVER_GENIUS_API_SECRET),
  COVER_GENIUS_PRODUCTS: { gadget: { policyType: 'gadget_protection', commissionBps: 2000n } },
  COVER_GENIUS_LICENSED_ENTITY: 'XCover (Cover Genius Ltd), licensed insurance intermediary',
  COVER_GENIUS_COMMISSION_DISCLOSURE: 'Kesher earns a commission on this policy.',
  PROVIDER_ORG_IDP: 'workos' as const,
  WORKOS_CLIENT_ID: new Secret('client_workos'),
  WORKOS_API_KEY: new Secret(CREDS.WORKOS_API_KEY),
  WORKOS_WEBHOOK_SECRET: new Secret('whsec_workos'),
  PROVIDER_FEDERATED_IDP: 'oidc' as const,
  APPLE_CLIENT_ID: new Secret('club.kesher.signin'),
  APPLE_TEAM_ID: new Secret('TEAM123456'),
  APPLE_KEY_ID: new Secret('KEY1234567'),
  APPLE_PRIVATE_KEY: new Secret(APPLE_PEM),
  GOOGLE_CLIENT_ID: new Secret('google-id.apps.googleusercontent.com'),
  GOOGLE_CLIENT_SECRET: new Secret(CREDS.GOOGLE_CLIENT_SECRET),
};
const nodb = {} as SqlClient;
const bind = (config: Parameters<typeof overridesFromConfig>[0]) => createRegistry('sandbox', systemClock(), overridesFromConfig(config, nodb));
const thrownBy = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
};

describe('marketplace and identity bindings (T-0042)', () => {
  it('defaults to the simulators on every one of the four ports', () => {
    const { registry, simulators, providers } = bind({ PROVIDER_INSTITUTION_BANKING: 'sim' });
    for (const capability of ['esim', 'insurance', 'org-idp', 'federated-idp'] as const) {
      for (const market of MARKETS) {
        expect(registry.resolve(capability, market)).toBe(simulators.simulators[capability]);
        expect(registry.bindingFor(capability, market)).toMatchObject({ provider: 'simulator', mode: 'sim' });
      }
    }
    expect(providers).toEqual(ALL_SIM);
    // Credentials present while the choice stays sim bind nothing.
    expect(bind({ PROVIDER_INSTITUTION_BANKING: 'sim', ...chosen, PROVIDER_ESIM: 'sim', PROVIDER_INSURANCE: 'sim', PROVIDER_ORG_IDP: 'sim', PROVIDER_FEDERATED_IDP: 'sim' }).providers).toEqual(ALL_SIM);
  });

  it('each choice binds its adapter in both markets, in sandbox mode, and leaves the other ports alone', () => {
    const cases = [
      ['esim', 'airalo', AiraloEsimAdapter, { PROVIDER_ESIM: 'airalo' as const }],
      ['insurance', 'cover-genius', CoverGeniusInsuranceAdapter, { PROVIDER_INSURANCE: 'cover-genius' as const }],
      ['org-idp', 'workos', WorkOsOrgIdPAdapter, { PROVIDER_ORG_IDP: 'workos' as const }],
      ['federated-idp', 'oidc', FederatedIdPRouter, { PROVIDER_FEDERATED_IDP: 'oidc' as const }],
    ] as const;
    for (const [capability, provider, adapterClass, pick] of cases) {
      const { registry, simulators, providers } = bind({ PROVIDER_INSTITUTION_BANKING: 'sim', ...chosen, PROVIDER_ESIM: 'sim', PROVIDER_INSURANCE: 'sim', PROVIDER_ORG_IDP: 'sim', PROVIDER_FEDERATED_IDP: 'sim', ...pick });
      for (const market of MARKETS) {
        expect(registry.resolve(capability, market)).toBeInstanceOf(adapterClass);
        expect(registry.bindingFor(capability, market)).toMatchObject({ provider, mode: 'sandbox' });
      }
      expect(providers).toEqual({ ...ALL_SIM, [capability]: provider });
      for (const other of ['esim', 'insurance', 'org-idp', 'federated-idp'] as const) {
        if (other !== capability) expect(registry.resolve(other, 'US')).toBe(simulators.simulators[other]);
      }
      expect(registry.resolve(capability, 'US')).toBe(registry.resolve(capability, 'IL'));
    }
  });

  it('all four chosen together bind all four, and the types line up with the ports', () => {
    const { registry, providers } = bind({ PROVIDER_INSTITUTION_BANKING: 'sim', ...chosen });
    expect(providers).toEqual({ ...ALL_SIM, esim: 'airalo', insurance: 'cover-genius', 'org-idp': 'workos', 'federated-idp': 'oidc' });
    expect(registry.resolve<EsimPort>('esim', 'US')).toBeInstanceOf(AiraloEsimAdapter);
    expect(registry.resolve<InsurancePort>('insurance', 'IL')).toBeInstanceOf(CoverGeniusInsuranceAdapter);
    expect(registry.resolve<OrgIdPPort>('org-idp', 'US')).toBeInstanceOf(WorkOsOrgIdPAdapter);
    expect(registry.resolve<FederatedIdPPort>('federated-idp', 'US')).toBeInstanceOf(FederatedIdPRouter);
  });

  it('the federated port routes each provider to its own adapter and refuses another', async () => {
    const apple = new AppleFederatedIdPAdapter({ clientId: 'c', teamId: 't', keyId: 'k', privateKeyPem: APPLE_PEM });
    const google = new GoogleFederatedIdPAdapter({ clientId: 'g', clientSecret: 's' });
    const port = new FederatedIdPRouter({ apple, google });
    const input = { state: 's1', nonce: 'n1', redirectUri: 'https://app.kesher.club/cb' };
    expect((await port.authorizationUrl('apple', input)).url).toContain('appleid.apple.com');
    expect((await port.authorizationUrl('google', input)).url).toContain('accounts.google.com');
    await expect(port.authorizationUrl('github' as never, input)).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
  });

  it('a registry given a half-built Apple and Google pair refuses it', () => {
    const { apple, google } = overridesFromConfig({ PROVIDER_INSTITUTION_BANKING: 'sim', ...chosen }, nodb).federatedIdp!;
    for (const half of [{ provider: 'oidc' as const, apple, google: undefined }, { provider: 'oidc' as const, apple: undefined, google }]) {
      const err = thrownBy(() => createRegistry('sim', systemClock(), { federatedIdp: half as never }));
      expect(err.message).toMatch(/both Apple and Google/);
    }
  });

  it('the configured base URL reaches the wire for Airalo and Cover Genius, never a default production host', async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response('{}', { status: 500 });
    };
    const { registry } = createRegistry('sandbox', systemClock(), overridesFromConfig({ PROVIDER_INSTITUTION_BANKING: 'sim', ...chosen }, nodb, undefined, fetch));
    await registry.resolve<EsimPort>('esim', 'US').listPackages('IL').catch(() => undefined);
    await registry.resolve<InsurancePort>('insurance', 'US').quote({ product: 'gadget', memberId: 'm1', market: 'US', startsAt: '2026-12-01T00:00:00Z', days: 3 }).catch(() => undefined);
    expect(urls.some((u) => u.startsWith(chosen.AIRALO_BASE_URL))).toBe(true);
    expect(urls.some((u) => u.startsWith(chosen.COVER_GENIUS_BASE_URL))).toBe(true);
    expect(urls.filter((u) => !u.startsWith(chosen.AIRALO_BASE_URL) && !u.startsWith(chosen.COVER_GENIUS_BASE_URL))).toEqual([]);
  });

  it('a chosen adapter without its full set fails closed, naming keys and never a value', () => {
    const base = { PROVIDER_INSTITUTION_BANKING: 'sim' as const, ...chosen };
    const drops: [string, string][] = [
      ['AIRALO_CLIENT_SECRET', 'PROVIDER_ESIM=airalo'],
      ['COVER_GENIUS_PRODUCTS', 'PROVIDER_INSURANCE=cover-genius'],
      ['WORKOS_WEBHOOK_SECRET', 'PROVIDER_ORG_IDP=workos'],
      ['GOOGLE_CLIENT_SECRET', 'PROVIDER_FEDERATED_IDP=oidc'],
      ['APPLE_KEY_ID', 'PROVIDER_FEDERATED_IDP=oidc'],
    ];
    for (const [key, choice] of drops) {
      const err = thrownBy(() => overridesFromConfig({ ...base, [key]: undefined }, nodb));
      expect(err.message).toContain(key);
      expect(err.message).toContain(choice);
      for (const v of [...Object.values(CREDS), APPLE_PEM]) expect(err.message).not.toContain(v);
    }
  });

  it('refuses a base URL that is not https without echoing a credential', () => {
    for (const patch of [{ AIRALO_BASE_URL: 'http://airalo.test' }, { COVER_GENIUS_BASE_URL: 'http://xcover.test' }]) {
      const err = thrownBy(() => bind({ PROVIDER_INSTITUTION_BANKING: 'sim', ...chosen, ...patch }));
      expect(err.message).toMatch(/needs an https baseUrl/);
      for (const v of Object.values(CREDS)) expect(err.message).not.toContain(v);
    }
  });

  it('adapter constructors that refuse (empty disclosure wording) do not echo a credential', () => {
    const err = thrownBy(() => bind({ PROVIDER_INSTITUTION_BANKING: 'sim', ...chosen, COVER_GENIUS_COMMISSION_DISCLOSURE: 'no mention' }));
    expect(err.message).toMatch(/commission/);
    for (const v of Object.values(CREDS)) expect(err.message).not.toContain(v);
  });
});

// T-0041: Stripe (funding and billing) and the notification channels (Twilio sms, Postmark email, Expo push).
const STRIPE_KEY = 'sk_test_do_not_print';
const STRIPE_CURRENT = 'whsec_current_do_not_print';
const STRIPE_PREVIOUS = 'whsec_previous_do_not_print';
const TWILIO_TOKEN = 'twilio-token-do-not-print';
const POSTMARK_TOKEN = 'postmark-token-do-not-print';
const EXPO_TOKEN = 'expo-token-do-not-print';
const NOTIFY_SECRETS = [STRIPE_KEY, STRIPE_CURRENT, STRIPE_PREVIOUS, TWILIO_TOKEN, POSTMARK_TOKEN, EXPO_TOKEN];
const copy = { 'money.received': { en: '{{from}} sent you {{amount}}', he: '{{from}} שלח/ה לך {{amount}}' } };
const stripeSet = {
  PROVIDER_FUNDING: 'stripe' as const,
  STRIPE_API_KEY: new Secret(STRIPE_KEY),
  STRIPE_WEBHOOK_SECRET: [new Secret(STRIPE_CURRENT)],
  STRIPE_PLAN_PRODUCTS: { club: 'prod_club' },
};
const smsSet = { PROVIDER_NOTIFY_SMS: 'twilio' as const, TWILIO_ACCOUNT_SID: new Secret('ACxxx'), TWILIO_AUTH_TOKEN: new Secret(TWILIO_TOKEN), TWILIO_FROM_SMS: '+12025550100', TWILIO_TEMPLATES: copy };
const emailSet = { PROVIDER_NOTIFY_EMAIL: 'postmark' as const, POSTMARK_SERVER_TOKEN: new Secret(POSTMARK_TOKEN), POSTMARK_FROM: 'club@kesher.example', POSTMARK_TEMPLATES: { 'money.received': { en: 'money-received-en', he: 'money-received-he' } } };
const pushSet = {
  PROVIDER_NOTIFY_PUSH: 'expo' as const,
  EXPO_ACCESS_TOKEN: new Secret(EXPO_TOKEN),
  EXPO_TEMPLATES: { 'money.received': { title: { en: 'Money', he: 'כסף' }, body: { en: '{{from}} sent {{amount}}', he: '{{from}} שלח {{amount}}' } } },
};
const sim = { PROVIDER_INSTITUTION_BANKING: 'sim' as const };

describe('Stripe and notification bindings (T-0041)', () => {
  it('a Stripe-bound billing and funding port is not a simulator, so the T-0043 prod guard does not fire on it', () => {
    const { registry } = bind({ ...sim, ...stripeSet });
    const bills = (flag: string) => simulatorFlagViolations((port) => registry.bindingFor(port, 'IL')?.mode, (f) => f === flag);
    expect(bills('billing.stripe')).toEqual([]);
    expect(bills('funding.ach')).toEqual([]);
    const plain = bind({ ...sim }).registry;
    expect(simulatorFlagViolations((port) => plain.bindingFor(port, 'IL')?.mode, (f) => f === 'billing.stripe')).toEqual([{ port: 'billing', flag: 'billing.stripe' }]);
  });

  it('PROVIDER_FUNDING=stripe binds the Stripe adapters to funding and billing in both markets, and every other port stays on its simulator', () => {
    const { registry, simulators, providers } = bind({ ...sim, ...stripeSet });
    for (const market of MARKETS) {
      expect(registry.resolve<FundingPort>('funding', market)).toBeInstanceOf(StripeFundingAdapter);
      expect(registry.resolve<BillingPort>('billing', market)).toBeInstanceOf(StripeBillingAdapter);
      expect(registry.bindingFor('funding', market)).toMatchObject({ provider: 'stripe', mode: 'sandbox' });
      expect(registry.bindingFor('billing', market)).toMatchObject({ provider: 'stripe', mode: 'sandbox' });
    }
    expect(providers).toEqual({ ...ALL_SIM, funding: 'stripe' });
    for (const other of ['esim', 'insurance', 'org-idp', 'federated-idp', 'notify', 'kyc', 'payout', 'fx'] as const) expect(registry.resolve(other, 'US')).toBe(simulators.simulators[other]);
  });

  it('the notification choices bind a router for their channel only, each in both markets, and the others stay on the simulator', () => {
    const cases = [
      ['notify-sms', 'twilio', smsSet],
      ['notify-email', 'postmark', emailSet],
      ['notify-push', 'expo', pushSet],
    ] as const;
    for (const [key, vendor, set] of cases) {
      const { registry, simulators, providers } = bind({ ...sim, ...set });
      expect(providers).toEqual({ ...ALL_SIM, [key]: vendor });
      for (const market of MARKETS) expect(registry.bindingFor('notify', market)).toMatchObject({ mode: 'sandbox' });
      expect(registry.resolve('notify', 'US')).toBe(registry.resolve('notify', 'IL'));
      expect(registry.resolve('notify', 'US')).not.toBe(simulators.simulators.notify);
      expect(registry.resolve('funding', 'US')).toBe(simulators.simulators.funding);
    }
    // Nothing chosen: the simulator itself, not a router.
    const none = bind({ ...sim });
    expect(none.registry.resolve('notify', 'US')).toBe(none.simulators.simulators.notify);
  });

  it('routes each channel to its vendor and the rest, whatsapp included, to the simulator', async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.includes('twilio')) return Response.json({ sid: 'SM1', status: 'queued' }, { status: 201 });
      if (url.includes('postmark')) return Response.json({ MessageID: 'pm_1', ErrorCode: 0 });
      return Response.json({ data: [{ status: 'ok', id: 'ticket_1' }] });
    };
    const { registry, simulators } = createRegistry('sandbox', systemClock(), overridesFromConfig({ ...sim, ...smsSet, ...emailSet, ...pushSet }, nodb, undefined, fetch));
    const port = registry.resolve<NotifyPort>('notify', 'IL');
    const base = { template: 'money.received', locale: 'en' as const, data: { amount: '$5', from: 'Dani' }, category: 'money' as const };
    const sms = await port.send({ ...base, channel: 'sms', to: '+12025550111' }, 'route-sms-1');
    const mail = await port.send({ ...base, channel: 'email', to: 'dani@example.com' }, 'route-mail-1');
    const push = await port.send({ ...base, channel: 'push', to: 'ExponentPushToken[abc]' }, 'route-push-1');
    expect([sms.messageId, mail.messageId, push.messageId]).toEqual(['SM1', 'pm_1', 'ticket_1']);
    expect(urls.some((u) => u.startsWith('https://api.twilio.com/'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://api.postmarkapp.com/'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://exp.host/'))).toBe(true);
    // WhatsApp has no vendor: it lands on the simulator and never on the wire.
    const before = urls.length;
    const wa = await port.send({ ...base, channel: 'whatsapp', to: '+12025550111' }, 'route-wa-1');
    expect(urls.length).toBe(before);
    expect(simulators.simulators.notify.sent.map((s) => s.messageId)).toEqual([wa.messageId]);
    // A lookup finds the message in whichever adapter sent it, and a stranger is a typed error.
    expect((await port.getDelivery(wa.messageId)).channel).toBe('whatsapp');
    expect((await port.getDelivery('SM1')).messageId).toBe('SM1');
    await expect(port.getDelivery('nobody')).rejects.toBeInstanceOf(NotifyError);
  });

  it('a channel left on sim keeps the simulator while the others are routed', async () => {
    const { registry, simulators } = bind({ ...sim, ...smsSet });
    const port = registry.resolve<NotifyPort>('notify', 'US');
    const d = await port.send({ channel: 'email', to: 'dani@example.com', template: 'money.received', locale: 'en', data: {}, category: 'money' }, 'sim-mail-1');
    expect(simulators.simulators.notify.sent.map((s) => s.messageId)).toEqual([d.messageId]);
  });

  it('Stripe reaches the wire with the configured key through the injected transport, and the plan map reaches billing', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const fake = new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: STRIPE_CURRENT, clock });
    const { registry } = createRegistry('sandbox', clock, overridesFromConfig({ ...sim, ...stripeSet }, nodb, undefined, fake.fetch));
    const load = await registry.resolve<FundingPort>('funding', 'US').createLoad({ customerId: 'cus_1', method: 'card', amount: { minor: 5_000n, currency: 'USD' }, paymentMethodId: 'pm_card_ok' }, 'load-key-0001');
    expect(load.status).not.toBe('failed');
    const billing = registry.resolve<BillingPort>('billing', 'US');
    const customer = await billing.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'cust-key-0001');
    const sub = await billing.createSubscription({ customerId: customer.customerId, planCode: 'club', price: { minor: 4_900n, currency: 'USD' }, termMonths: 10 }, 'sub-key-0001');
    expect(sub.planCode).toBe('club');
    await expect(billing.createSubscription({ customerId: customer.customerId, planCode: 'nope', price: { minor: 4_900n, currency: 'USD' }, termMonths: 10 }, 'sub-key-0002')).rejects.toMatchObject({ code: 'UNKNOWN_PLAN' });
  });

  it('during a rotation a Stripe webhook signed with the previous secret verifies, with the current one too, and a third secret does not', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const config = { ...sim, ...stripeSet, STRIPE_WEBHOOK_SECRET: [new Secret(STRIPE_CURRENT), new Secret(STRIPE_PREVIOUS)] };
    const signer = (secret: string) => new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: secret, clock });
    const old = signer(STRIPE_PREVIOUS);
    const { registry } = createRegistry('sandbox', clock, overridesFromConfig(config, nodb, undefined, old.fetch));
    const funding = registry.resolve<FundingPort>('funding', 'US');
    const l = await funding.createLoad({ customerId: 'cus_1', method: 'card', amount: { minor: 5_000n, currency: 'USD' }, paymentMethodId: 'pm_card_ok' }, 'load-key-0002');
    const hook = old.settlePaymentIntent(l.loadId);
    expect((await funding.parseWebhook(hook.headers, hook.rawBody)).load.loadId).toBe(l.loadId);
    const current = signer(STRIPE_CURRENT);
    expect((await funding.parseWebhook(current.sign(hook.rawBody), hook.rawBody)).load.loadId).toBe(l.loadId);
    const third = signer('whsec_third_do_not_print');
    await expect(funding.parseWebhook(third.sign(hook.rawBody), hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    // Billing takes the same pair.
    const billing = registry.resolve<BillingPort>('billing', 'US');
    const c = await billing.createCustomer({ partyId: 'p1', email: 'f@example.com' }, 'cust-key-0002');
    const s = await billing.createSubscription({ customerId: c.customerId, planCode: 'club', price: { minor: 4_900n, currency: 'USD' }, termMonths: 10 }, 'sub-key-0003');
    const invoice = old.failInvoice(s.subscriptionId);
    expect((await billing.parseWebhook(invoice.headers, invoice.rawBody)).type).toBe('invoice.payment_failed');
    const forged = { headers: third.sign(invoice.rawBody), rawBody: invoice.rawBody };
    await expect(billing.parseWebhook(forged.headers, forged.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
  });

  it('during a rotation a Stripe webhook older than the 5-minute window is refused whichever secret signed it (T-0781)', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const config = { ...sim, ...stripeSet, STRIPE_WEBHOOK_SECRET: [new Secret(STRIPE_CURRENT), new Secret(STRIPE_PREVIOUS)] };
    const old = new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: STRIPE_PREVIOUS, clock });
    const { registry } = createRegistry('sandbox', clock, overridesFromConfig(config, nodb, undefined, old.fetch));
    const funding = registry.resolve<FundingPort>('funding', 'US');
    const l = await funding.createLoad({ customerId: 'cus_1', method: 'card', amount: { minor: 5_000n, currency: 'USD' }, paymentMethodId: 'pm_card_ok' }, 'load-key-0004');
    const hook = old.settlePaymentIntent(l.loadId);
    await expect(funding.parseWebhook(old.sign(hook.rawBody, 301), hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    const current = new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: STRIPE_CURRENT, clock });
    await expect(funding.parseWebhook(current.sign(hook.rawBody, 301), hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    expect((await funding.parseWebhook(old.sign(hook.rawBody, 300), hook.rawBody)).load.loadId).toBe(l.loadId);
  });

  it('with a single webhook secret the previous one is not accepted', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const old = new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: STRIPE_PREVIOUS, clock });
    const { registry } = createRegistry('sandbox', clock, overridesFromConfig({ ...sim, ...stripeSet }, nodb, undefined, old.fetch));
    const funding = registry.resolve<FundingPort>('funding', 'US');
    const l = await funding.createLoad({ customerId: 'cus_1', method: 'card', amount: { minor: 5_000n, currency: 'USD' }, paymentMethodId: 'pm_card_ok' }, 'load-key-0003');
    const hook = old.settlePaymentIntent(l.loadId);
    await expect(funding.parseWebhook(hook.headers, hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
  });

  it('a chosen adapter without its full set fails closed, naming keys and never a value', () => {
    const base = { ...sim, ...stripeSet, ...smsSet, ...emailSet, ...pushSet };
    const drops: [string, string][] = [
      ['STRIPE_API_KEY', 'PROVIDER_FUNDING=stripe'],
      ['STRIPE_WEBHOOK_SECRET', 'PROVIDER_FUNDING=stripe'],
      ['STRIPE_PLAN_PRODUCTS', 'PROVIDER_FUNDING=stripe'],
      ['TWILIO_ACCOUNT_SID', 'PROVIDER_NOTIFY_SMS=twilio'],
      ['TWILIO_AUTH_TOKEN', 'PROVIDER_NOTIFY_SMS=twilio'],
      ['TWILIO_FROM_SMS', 'PROVIDER_NOTIFY_SMS=twilio'],
      ['TWILIO_TEMPLATES', 'PROVIDER_NOTIFY_SMS=twilio'],
      ['POSTMARK_SERVER_TOKEN', 'PROVIDER_NOTIFY_EMAIL=postmark'],
      ['POSTMARK_FROM', 'PROVIDER_NOTIFY_EMAIL=postmark'],
      ['POSTMARK_TEMPLATES', 'PROVIDER_NOTIFY_EMAIL=postmark'],
      ['EXPO_ACCESS_TOKEN', 'PROVIDER_NOTIFY_PUSH=expo'],
      ['EXPO_TEMPLATES', 'PROVIDER_NOTIFY_PUSH=expo'],
    ];
    for (const [key, choice] of drops) {
      const err = thrownBy(() => overridesFromConfig({ ...base, [key]: undefined }, nodb));
      expect(err.message).toContain(key);
      expect(err.message).toContain(choice);
      for (const v of NOTIFY_SECRETS) expect(err.message).not.toContain(v);
    }
  });

  it('credentials present while the choice stays sim bind nothing', () => {
    const { providers, registry, simulators } = bind({ ...sim, ...stripeSet, ...smsSet, ...emailSet, ...pushSet, PROVIDER_FUNDING: 'sim', PROVIDER_NOTIFY_SMS: 'sim', PROVIDER_NOTIFY_EMAIL: 'sim', PROVIDER_NOTIFY_PUSH: 'sim' });
    expect(providers).toEqual(ALL_SIM);
    expect(registry.resolve('funding', 'US')).toBe(simulators.simulators.funding);
    expect(registry.resolve('billing', 'US')).toBe(simulators.simulators.billing);
    expect(registry.resolve('notify', 'US')).toBe(simulators.simulators.notify);
  });

  it('adapter constructors that refuse do not echo a credential', () => {
    const err = thrownBy(() => createRegistry('sandbox', systemClock(), { funding: { provider: 'stripe', secretKey: new Secret(STRIPE_KEY), webhookSecrets: [], planProducts: {} } }));
    expect(err.message).toMatch(/webhook secret/);
    for (const v of NOTIFY_SECRETS) expect(err.message).not.toContain(v);
  });
});

describe('provider.error for every resolved port (T-0689)', () => {
  const metered = () => {
    const lines: Record<string, unknown>[] = [];
    const made = createRegistry('sim', systemClock(), {}, createMetrics({ write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }));
    return { ...made, lines };
  };

  it('without a metrics sink resolve hands back the bare port', () => {
    const { registry, simulators } = createRegistry('sim');
    expect(registry.resolve('fx', 'IL')).toBe(simulators.simulators.fx);
  });

  it('a thrown PROVIDER_UNAVAILABLE counts once as provider.error{port,provider} and is rethrown unchanged', async () => {
    const boom = new NotifyError('PROVIDER_UNAVAILABLE', 'vendor 0191a7c2 payload {"a":1} down');
    const { registry: r2, simulators, lines: l2 } = metered();
    simulators.registry.register('scratch', 'acme', () => ({ call: () => Promise.reject(boom), sync: () => { throw boom; }, ok: () => Promise.resolve(1) }));
    simulators.registry.bind({ capability: 'scratch', market: 'IL', provider: 'acme', mode: 'sim' });
    const port = r2.resolve<{ call: () => Promise<never>; sync: () => never; ok: () => Promise<number> }>('scratch', 'IL');
    await expect(port.call()).rejects.toBe(boom);
    expect(() => port.sync()).toThrow(boom);
    await expect(port.ok()).resolves.toBe(1);
    expect(l2).toHaveLength(2);
    expect(l2[0]).toMatchObject({ port: 'scratch', provider: 'acme', 'provider.error': 1 });
    expect(JSON.stringify(l2)).not.toMatch(/0191a7c2|payload/);
  });

  it("counts a failure on any port the registry resolves: the bank simulator outage fixture", async () => {
    const { registry, lines } = metered();
    const bank = registry.resolve<{ statement: (input: { valueDate: string }) => Promise<unknown> }>('bank', 'IL');
    const before = lines.length;
    await expect(bank.statement({ valueDate: '2000-01-01' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(lines.slice(before)).toEqual([expect.objectContaining({ port: 'bank', provider: 'simulator', 'provider.error': 1 })]);
  });

  it('an answer that is not an outage (a coded rejection) is not counted', async () => {
    const { registry, simulators, lines } = metered();
    simulators.registry.register('scratch', 'acme', () => ({ call: () => Promise.reject(new NotifyError('UNKNOWN_MESSAGE', 'no')) }));
    simulators.registry.bind({ capability: 'scratch', market: 'US', provider: 'acme', mode: 'sim' });
    await expect(registry.resolve<{ call: () => Promise<never> }>('scratch', 'US').call()).rejects.toMatchObject({ code: 'UNKNOWN_MESSAGE' });
    expect(lines).toEqual([]);
  });

  it('card-issuing parseAuthorization is left to its caller, so JIT does not double count', async () => {
    const { registry, lines } = metered();
    const port = registry.resolve<{ parseAuthorization: (h: Record<string, string>, b: string) => Promise<unknown> }>('card-issuing', 'IL');
    await expect(port.parseAuthorization({ 'x-sim-signature': 'sim' }, '{ not json')).rejects.toBeDefined();
    expect(lines).toEqual([]);
  });

  it('a broken metrics sink never changes what the caller sees', async () => {
    const throwing = { providerError: () => { throw new Error('sink'); } } as unknown as Parameters<typeof createRegistry>[3];
    const { simulators, registry } = createRegistry('sim', systemClock(), {}, throwing);
    const boom = new NotifyError('PROVIDER_UNAVAILABLE', 'x');
    simulators.registry.register('scratch', 'acme', () => ({ call: () => Promise.reject(boom) }));
    simulators.registry.bind({ capability: 'scratch', market: 'IL', provider: 'acme', mode: 'sim' });
    await expect(registry.resolve<{ call: () => Promise<never> }>('scratch', 'IL').call()).rejects.toBe(boom);
  });
});

// T-0771 slice 2: the stray CROWDED_BINDING=live warning reads whether a Crowded binding was declared, not the provider's name.
// `oracle` is the pre-slice rule, kept verbatim: warn exactly when the banking choice is not 'crowded' and CROWDED_BINDING is 'live'.
describe('stray live-binding warning (T-0771 slice 2)', () => {
  const choices = ['sim', 'crowded', 'Crowded', 'stub', ''] as const; // the config schema allows two; the rest pin what an unexpected value does
  const bindings = ['unset', 'sandbox', 'live'] as const;
  const noDb = { async query() { throw new Error('no db in this test'); } } as unknown as SqlClient;
  const cfg = (choice: string, binding: (typeof bindings)[number], keys: boolean) =>
    ({
      PROVIDER_INSTITUTION_BANKING: choice,
      ...(keys ? { CROWDED_BASE_URL: BASE, CROWDED_API_TOKEN: new Secret(TOKEN), CROWDED_WEBHOOK_SECRETS: [new Secret(CURRENT)] } : {}),
      ...(binding === 'unset' ? {} : { CROWDED_BINDING: binding }),
    }) as unknown as Parameters<typeof overridesFromConfig>[0];
  const oracleWarns = (c: { PROVIDER_INSTITUTION_BANKING: string; CROWDED_BINDING?: string }): string[] => (c.PROVIDER_INSTITUTION_BANKING !== 'crowded' && c.CROWDED_BINDING === 'live' ? [IGNORED_LIVE_BINDING_WARNING] : []);

  it('characterization: every (choice x binding x keys) cell warns, overrides and fails as the oracle says', () => {
    let n = 0;
    for (const choice of choices) {
      for (const binding of bindings) {
        for (const keys of [true, false]) {
          const config = cfg(choice, binding, keys);
          const warnings: string[] = [];
          const label = `${choice || '<empty>'}/${binding}/${keys ? 'keys' : 'nokeys'}`;
          if (choice === 'crowded' && !keys) {
            expect(() => overridesFromConfig(config, noDb, (m) => warnings.push(m)), label).toThrow('PROVIDER_INSTITUTION_BANKING=crowded needs CROWDED_BASE_URL, CROWDED_API_TOKEN and CROWDED_WEBHOOK_SECRETS');
            expect(warnings, label).toEqual([]);
          } else {
            const o = overridesFromConfig(config, noDb, (m) => warnings.push(m));
            expect(warnings, label).toEqual(oracleWarns(config as never));
            if (choice === 'crowded') expect(o.institutionBanking, label).toMatchObject({ provider: 'crowded', binding: binding === 'live' ? 'live' : 'sandbox' });
            else expect(o, label).toEqual({});
          }
          // No warn callback: nothing to call, nothing thrown.
          if (!(choice === 'crowded' && !keys)) expect(() => overridesFromConfig(config, noDb), label).not.toThrow();
          n += 1;
        }
      }
    }
    expect(n).toBe(5 * 3 * 2);
  });

  it('a live setting warns once and with the exact text; sandbox and unset never warn; crowded never warns here', () => {
    const warnings: string[] = [];
    overridesFromConfig(cfg('sim', 'live', true), noDb, (m) => warnings.push(m));
    expect(warnings).toEqual([IGNORED_LIVE_BINDING_WARNING]);
    for (const binding of ['unset', 'sandbox'] as const) overridesFromConfig(cfg('sim', binding, true), noDb, (m) => warnings.push(m));
    overridesFromConfig(cfg('crowded', 'unset', true), noDb, (m) => warnings.push(m));
    expect(warnings).toEqual([IGNORED_LIVE_BINDING_WARNING]);
  });

  it('the warning does not depend on the other vendors: marketplace overrides are returned beside it unchanged', () => {
    const warnings: string[] = [];
    const config = { ...cfg('sim', 'live', false), PROVIDER_ESIM: 'airalo', AIRALO_BASE_URL: 'https://sandbox.example/', AIRALO_CLIENT_ID: new Secret('id'), AIRALO_CLIENT_SECRET: new Secret('sec') } as never;
    const out = overridesFromConfig(config, noDb, (m) => warnings.push(m));
    expect(warnings).toEqual([IGNORED_LIVE_BINDING_WARNING]);
    expect(out.institutionBanking).toBeUndefined();
    expect(out.esim).toMatchObject({ provider: 'airalo' });
    expect(out).toEqual(overridesFromConfig({ ...(config as object), CROWDED_BINDING: 'sandbox' } as never, noDb));
  });
});

// T-0771 slice 1: the Crowded webhook secrets come from the binding's capability, not from comparing a provider name.
// `oracle` is the pre-slice rule, kept here verbatim so the table below proves old and new resolve identically.
describe('binding capabilities: webhook secrets (T-0771 slice 1)', () => {
  type Choice = 'sim' | 'crowded';
  const SECRET_SETS: readonly (readonly string[])[] = [[CURRENT], [CURRENT, PREVIOUS], []];
  const bindings = ['unset', 'sandbox', 'live'] as const;
  const cfg = (choice: Choice, secrets: readonly string[], binding: (typeof bindings)[number]) => ({
    PROVIDER_INSTITUTION_BANKING: choice,
    CROWDED_BASE_URL: BASE,
    CROWDED_API_TOKEN: new Secret(TOKEN),
    CROWDED_WEBHOOK_SECRETS: secrets.map((s) => new Secret(s)),
    ...(binding === 'unset' ? {} : { CROWDED_BINDING: binding }),
  });
  type Cfg = ReturnType<typeof cfg>;
  const oracle = (config: Cfg): string[] => (config.PROVIDER_INSTITUTION_BANKING === 'crowded' ? (config.CROWDED_WEBHOOK_SECRETS ?? []).map((s) => s.reveal()) : []);
  const noDb = { async query() { throw new Error('no db in this test'); } } as unknown as SqlClient;
  const build = (config: Cfg) => createRegistry('sim', systemClock(), overridesFromConfig(config, noDb)).registry;
  // The function under test, as the processes call it.
  const secretsOf = (_config: Cfg, registry: ReturnType<typeof build>, market: (typeof MARKETS)[number]): string[] => crowdedWebhookSecrets(registry, market);
  const cells = function* () {
    for (const choice of ['sim', 'crowded'] as const) for (const secrets of SECRET_SETS.filter((s) => choice === 'sim' || s.length > 0)) for (const binding of bindings) yield { choice, secrets, binding, config: cfg(choice, secrets, binding) };
  };

  it('characterization: every (choice x secrets x binding x market) cell resolves the receiver secrets as the oracle says', () => {
    let n = 0;
    for (const { choice, secrets, binding, config } of cells()) {
      const registry = build(config);
      for (const market of MARKETS) {
        expect(secretsOf(config, registry, market), `${choice}/${secrets.length}/${binding}/${market}`).toEqual(oracle(config));
        n += 1;
      }
    }
    expect(n).toBe((3 + 2) * 3 * 2); // sim: 3 secret sets, crowded: the 2 non-empty ones; 3 bindings; 2 markets
  });

  it('characterization: which port is bound, in which mode, and what an unbound or unregistered capability does', () => {
    for (const market of MARKETS) {
      expect(build(cfg('sim', [CURRENT], 'unset')).bindingFor('institution-banking', market)).toMatchObject({ provider: 'simulator', mode: 'sim' });
      expect(build(cfg('crowded', [CURRENT], 'unset')).bindingFor('institution-banking', market)).toMatchObject({ provider: 'crowded', mode: 'sandbox' });
      expect(build(cfg('crowded', [CURRENT], 'live')).bindingFor('institution-banking', market)).toMatchObject({ provider: 'crowded', mode: 'live' });
      // CROWDED_BINDING=live on the simulator binds nothing live.
      expect(build(cfg('sim', [CURRENT], 'live')).bindingFor('institution-banking', market)).toMatchObject({ provider: 'simulator', mode: 'sim' });
      expect(build(cfg('sim', [CURRENT], 'unset')).bindingFor('not-a-capability', market)).toBeUndefined();
      expect(() => build(cfg('sim', [CURRENT], 'unset')).resolve('not-a-capability', market)).toThrow(`Capability not-a-capability is not bound for ${market}`);
      const { registry: plain, simulators } = createRegistry('sim', systemClock(), {});
      expect(() => simulators.registry.bind({ capability: 'institution-banking', market, provider: 'nobody', mode: 'sim' })).toThrow('No adapter registered for institution-banking/nobody');
      expect(plain.bindingFor('funding', market)).toEqual({ capability: 'funding', market, provider: 'simulator', mode: 'sim' });
    }
  });

  it('differential: the binding carries the secrets exactly when the oracle says there are some, and only on institution-banking', () => {
    for (const { choice, secrets, config } of cells()) {
      const registry = build(config);
      for (const market of MARKETS) {
        expect(registry.bindingFor('institution-banking', market)?.webhook?.secrets).toEqual(choice === 'crowded' ? secrets : undefined);
        for (const { capability } of PORTS.filter((p) => p.capability !== 'institution-banking')) expect(registry.bindingFor(capability, market)?.webhook).toBeUndefined();
      }
    }
  });

  it('a binding that carries no capability, or a market that is unbound, reads as no secrets (fails closed)', () => {
    const { registry, simulators } = createRegistry('sim', systemClock(), {});
    simulators.registry.register('scratch', 'x', () => ({}));
    simulators.registry.bind({ capability: 'institution-banking', market: 'IL', provider: 'simulator', mode: 'sim' });
    expect(crowdedWebhookSecrets(registry, 'IL')).toEqual([]);
    expect(crowdedWebhookSecrets({ bindingFor: () => undefined }, 'US')).toEqual([]);
    expect(crowdedWebhookSecrets({ bindingFor: (capability, market) => ({ capability, market, provider: 'crowded', mode: 'live' }) }, 'US')).toEqual([]);
  });

  it('the answer is a copy: mutating it cannot change what the binding carries', () => {
    const registry = build(cfg('crowded', [CURRENT, PREVIOUS], 'unset'));
    crowdedWebhookSecrets(registry, 'US').push('evil');
    expect(crowdedWebhookSecrets(registry, 'US')).toEqual([CURRENT, PREVIOUS]);
  });

  it('the secrets are read per market: a binding on one market answers for that market only', () => {
    const { registry, simulators } = createRegistry('sim', systemClock(), {});
    simulators.registry.register('institution-banking', 'x', () => ({}));
    simulators.registry.bind({ capability: 'institution-banking', market: 'US', provider: 'x', mode: 'sim', webhook: { secrets: ['us-secret'] } });
    simulators.registry.bind({ capability: 'institution-banking', market: 'IL', provider: 'x', mode: 'sim', webhook: { secrets: ['il-secret'] } });
    expect(crowdedWebhookSecrets(registry, 'US')).toEqual(['us-secret']);
    expect(crowdedWebhookSecrets(registry, 'IL')).toEqual(['il-secret']);
  });

  it('every non-banking binding (stripe, esim, notify, the marketplace set) is exactly as before: provider and mode only', () => {
    const registry = bind({ ...cfg('crowded', [CURRENT], 'unset'), ...chosen, ...stripeSet, ...smsSet }).registry;
    expect(registry.bindingFor('funding', 'US')).toMatchObject({ provider: 'stripe' });
    expect(registry.bindingFor('esim', 'IL')).toMatchObject({ provider: 'airalo' });
    for (const market of MARKETS) {
      for (const { capability } of PORTS.filter((p) => p.capability !== 'institution-banking')) {
        const b = registry.bindingFor(capability, market);
        // Stripe's funding and billing carry their webhook secrets since slice 3; everything else is provider and mode only.
        const stripeBound = b?.provider === 'stripe';
        if (b) expect(Object.keys(b).sort()).toEqual(stripeBound ? ['capability', 'market', 'mode', 'provider', 'webhook'] : ['capability', 'market', 'mode', 'provider']);
      }
    }
  });
});

// T-0771 slice 3: the Stripe override block and the single-secret-per-vendor wiring. `oracle*` are the pre-slice rules kept verbatim
// (the `PROVIDER_FUNDING === 'stripe'` test, `stripe.webhookSecrets`, `acceptPreviousSecrets(funding|billing, ...)`), so the tables
// prove old and new agree for every config. There is no PROVIDER_BILLING: billing follows PROVIDER_FUNDING (T-0041).
describe('Stripe override and webhook secrets (T-0771 slice 3)', () => {
  const OLDER = 'whsec_older_do_not_print';
  const OTHER = 'whsec_other_do_not_print';
  const choices = ['sim', 'stripe', 'Stripe', '', undefined] as const;
  const shapes = ['full', 'noApi', 'noSecrets', 'noPlans', 'none', 'emptySecrets'] as const;
  const SECRET_SETS: readonly (readonly string[])[] = [[STRIPE_CURRENT], [STRIPE_CURRENT, STRIPE_PREVIOUS], [STRIPE_CURRENT, STRIPE_PREVIOUS, OLDER]];
  const PLANS = { club: 'prod_club' };
  const cfg = (choice: (typeof choices)[number], shape: (typeof shapes)[number], secrets: readonly string[] = [STRIPE_CURRENT]) => {
    const key = new Secret(STRIPE_KEY);
    const list = secrets.map((s) => new Secret(s));
    return {
      ...sim,
      ...(choice === undefined ? {} : { PROVIDER_FUNDING: choice }),
      PROVIDER_BILLING: 'stripe', // not a config key: billing follows funding, so this must change nothing
      ...(shape === 'noApi' || shape === 'none' ? {} : { STRIPE_API_KEY: key }),
      ...(shape === 'noSecrets' || shape === 'none' ? {} : { STRIPE_WEBHOOK_SECRET: shape === 'emptySecrets' ? [] : list }),
      ...(shape === 'noPlans' || shape === 'none' ? {} : { STRIPE_PLAN_PRODUCTS: PLANS }),
    } as unknown as Parameters<typeof overridesFromConfig>[0];
  };
  const oracleMissing = (c: ReturnType<typeof cfg>): string[] => [c.STRIPE_API_KEY ? '' : 'STRIPE_API_KEY', c.STRIPE_WEBHOOK_SECRET ? '' : 'STRIPE_WEBHOOK_SECRET', c.STRIPE_PLAN_PRODUCTS ? '' : 'STRIPE_PLAN_PRODUCTS'].filter(Boolean);
  const nothingToFetch = (async () => new Response('{}')) as unknown as typeof globalThis.fetch;

  it('characterization: every (choice x key shape x transport) cell builds the same override, throws the same, warns nothing', () => {
    let n = 0;
    for (const choice of choices) {
      for (const shape of shapes) {
        for (const withFetch of [false, true]) {
          const config = cfg(choice, shape);
          const label = `${choice ?? '<unset>'}/${shape}/${withFetch ? 'fetch' : 'nofetch'}`;
          const warnings: string[] = [];
          const missing = oracleMissing(config);
          const run = () => overridesFromConfig(config, nodb, (m) => warnings.push(m), withFetch ? nothingToFetch : undefined);
          if (choice === 'stripe' && missing.length > 0) {
            expect(run, label).toThrow(new Error(`PROVIDER_FUNDING=stripe needs ${missing.join(', ')}`));
          } else if (choice === 'stripe') {
            const f = run().funding;
            expect(f, label).toEqual({ provider: 'stripe', secretKey: config.STRIPE_API_KEY, webhookSecrets: config.STRIPE_WEBHOOK_SECRET, planProducts: PLANS, ...(withFetch ? { fetch: nothingToFetch } : {}) });
            expect(f?.secretKey, label).toBe(config.STRIPE_API_KEY);
            expect(f?.webhookSecrets, label).toBe(config.STRIPE_WEBHOOK_SECRET);
            expect(f?.planProducts, label).toBe(config.STRIPE_PLAN_PRODUCTS);
            expect(Object.keys(f ?? {}).sort(), label).toEqual(withFetch ? ['fetch', 'planProducts', 'provider', 'secretKey', 'webhookSecrets'] : ['planProducts', 'provider', 'secretKey', 'webhookSecrets']);
          } else {
            expect(run(), label).toEqual({}); // any other value (sim, Stripe, empty, unset) binds nothing and never reads the keys
          }
          expect(warnings, label).toEqual([]);
          n += 1;
        }
      }
    }
    expect(n).toBe(5 * 6 * 2);
  });

  it('characterization: an empty secret list passes the override and is refused where the adapter is built, naming no secret', () => {
    const o = overridesFromConfig(cfg('stripe', 'emptySecrets'), nodb);
    expect(o.funding?.webhookSecrets).toEqual([]);
    const err = thrownBy(() => createRegistry('sandbox', systemClock(), o));
    expect(err.message).toBe('Stripe needs a webhook secret');
  });

  it('characterization: what is bound, per choice, in both markets (funding and billing together, on stripe only, mode sandbox)', () => {
    for (const choice of choices) {
      if (choice === 'stripe') continue;
      const { registry, providers } = createRegistry('sandbox', systemClock(), overridesFromConfig(cfg(choice, 'full'), nodb));
      expect(providers.funding, String(choice)).toBe('sim');
      for (const market of MARKETS) for (const capability of ['funding', 'billing']) expect(registry.bindingFor(capability, market), `${choice}/${capability}`).toEqual({ capability, market, provider: 'simulator', mode: 'sim' });
    }
    const { registry, providers } = createRegistry('sandbox', systemClock(), overridesFromConfig(cfg('stripe', 'full'), nodb));
    expect(providers).toEqual({ ...ALL_SIM, funding: 'stripe' });
    for (const market of MARKETS) for (const capability of ['funding', 'billing']) expect(registry.bindingFor(capability, market)).toMatchObject({ capability, market, provider: 'stripe', mode: 'sandbox' });
  });

  it('delivery table: signed with the current secret verifies, with a previous one only when configured, with another is refused (funding and billing)', async () => {
    let n = 0;
    for (const secrets of SECRET_SETS) {
      const clock = fixedClock() as AdvanceableClock;
      const fake = new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: STRIPE_CURRENT, clock });
      const { registry } = createRegistry('sandbox', clock, overridesFromConfig(cfg('stripe', 'full', secrets), nodb, undefined, fake.fetch));
      const funding = registry.resolve<FundingPort>('funding', 'US');
      const billing = registry.resolve<BillingPort>('billing', 'US');
      const customer = await billing.createCustomer({ partyId: `p${secrets.length}`, email: 'f@example.com' }, `cust-key-${secrets.length}000`);
      const sub = await billing.createSubscription({ customerId: customer.customerId, planCode: 'club', price: { minor: 4_900n, currency: 'USD' }, termMonths: 10 }, `sub-key-${secrets.length}000`);
      let i = 0;
      for (const signer of [STRIPE_CURRENT, STRIPE_PREVIOUS, OLDER, OTHER]) {
        const signedBy = new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: signer, clock });
        const accepted = secrets.includes(signer);
        const label = `${secrets.length} secrets, signer ${signer}`;
        i += 1;
        const l = await funding.createLoad({ customerId: 'cus_1', method: 'card', amount: { minor: 5_000n, currency: 'USD' }, paymentMethodId: 'pm_card_ok' }, `load-key-${secrets.length}${i}00`);
        const hook = fake.settlePaymentIntent(l.loadId);
        const fundingResult = funding.parseWebhook(signedBy.sign(hook.rawBody), hook.rawBody);
        if (accepted) expect((await fundingResult).load.loadId, label).toBe(l.loadId);
        else await expect(fundingResult, label).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
        const invoice = fake.failInvoice(sub.subscriptionId, i);
        const billingResult = billing.parseWebhook(signedBy.sign(invoice.rawBody), invoice.rawBody);
        if (accepted) expect((await billingResult).type, label).toBe('invoice.payment_failed');
        else await expect(billingResult, label).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
        n += 2;
      }
    }
    expect(n).toBe(3 * 4 * 2);
  });

  it('a request with no signature header is refused whatever the rotation', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const fake = new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: STRIPE_CURRENT, clock });
    const { registry } = createRegistry('sandbox', clock, overridesFromConfig(cfg('stripe', 'full', SECRET_SETS[2]), nodb, undefined, fake.fetch));
    const funding = registry.resolve<FundingPort>('funding', 'IL');
    const l = await funding.createLoad({ customerId: 'cus_1', method: 'card', amount: { minor: 5_000n, currency: 'USD' }, paymentMethodId: 'pm_card_ok' }, 'load-key-nohdr0');
    const hook = fake.settlePaymentIntent(l.loadId);
    await expect(funding.parseWebhook({}, hook.rawBody)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
  });

  it('the second market accepts the same secrets (both markets share one adapter)', async () => {
    const clock = fixedClock() as AdvanceableClock;
    const prev = new FakeStripe({ secretKey: STRIPE_KEY, webhookSecret: STRIPE_PREVIOUS, clock });
    const { registry } = createRegistry('sandbox', clock, overridesFromConfig(cfg('stripe', 'full', SECRET_SETS[1]), nodb, undefined, prev.fetch));
    for (const market of MARKETS) {
      const funding = registry.resolve<FundingPort>('funding', market);
      const l = await funding.createLoad({ customerId: 'cus_1', method: 'card', amount: { minor: 5_000n, currency: 'USD' }, paymentMethodId: 'pm_card_ok' }, `load-key-mkt-${market}`);
      const hook = prev.settlePaymentIntent(l.loadId);
      expect((await funding.parseWebhook(hook.headers, hook.rawBody)).load.loadId).toBe(l.loadId);
    }
  });

  it('the bindings carry the secrets they verify with: funding and billing, both markets, in config order, on stripe only', () => {
    for (const choice of choices) {
      for (const secrets of SECRET_SETS) {
        const config = cfg(choice, 'full', secrets);
        const { registry } = createRegistry('sandbox', systemClock(), overridesFromConfig(config, nodb));
        const expected = choice === 'stripe' ? secrets : undefined;
        for (const market of MARKETS) {
          for (const { capability } of PORTS) {
            const stripeBound = choice === 'stripe' && (capability === 'funding' || capability === 'billing');
            expect(registry.bindingFor(capability, market)?.webhook?.secrets, `${choice}/${secrets.length}/${capability}/${market}`).toEqual(stripeBound ? expected : undefined);
          }
        }
      }
    }
  });

  it('the stripe bindings keep every other field, and the funding provider key space is still `stripe`', () => {
    const { registry } = createRegistry('sandbox', systemClock(), overridesFromConfig(cfg('stripe', 'full', SECRET_SETS[1]), nodb));
    for (const market of MARKETS) {
      for (const capability of ['funding', 'billing']) expect(Object.keys(registry.bindingFor(capability, market) ?? {}).sort()).toEqual(['capability', 'market', 'mode', 'provider', 'webhook']);
      expect(registry.bindingFor('funding', market)).toMatchObject({ provider: 'stripe', mode: 'sandbox' });
    }
  });
});

describe('the panel never serialises a binding whole, and the shared secret list is frozen (T-1025)', () => {
  const SECRETS = [STRIPE_CURRENT, STRIPE_PREVIOUS, 'whsec_older_do_not_print'];
  const nodb = { async query() { throw new Error('no db in this test'); } } as unknown as SqlClient;
  const stripeCfg = { ...sim, ...stripeSet, STRIPE_WEBHOOK_SECRET: SECRETS.map((s) => new Secret(s)) };
  const crowdedCfg = {
    PROVIDER_INSTITUTION_BANKING: 'crowded' as const,
    CROWDED_BASE_URL: BASE,
    CROWDED_API_TOKEN: new Secret(TOKEN),
    CROWDED_WEBHOOK_SECRETS: [CURRENT, PREVIOUS, 'whsec-older-0123456789'].map((s) => new Secret(s)),
  };
  const hosts = [
    { name: 'stripe', config: stripeCfg, secrets: SECRETS, ports: ['funding', 'billing'] },
    { name: 'crowded', config: crowdedCfg, secrets: [CURRENT, PREVIOUS, 'whsec-older-0123456789'], ports: ['institution-banking'] },
  ] as const;

  it('GET /ports/{capability} answers provider and mode and no webhook, no secret string, whatever is bound', async () => {
    let n = 0;
    for (const h of hosts) {
      const { simulators } = createRegistry('sandbox', systemClock(), overridesFromConfig(h.config, nodb, undefined, (async () => new Response('{}')) as typeof fetch));
      for (const capability of h.ports) {
        // Precondition: the binding really carries the secrets, so the assertions below can fail.
        expect(simulators.registry.bindingFor(capability, 'IL')?.webhook?.secrets).toEqual(h.secrets);
        const res = await handle(simulators, 'GET', `/ports/${capability}`);
        expect(res.status).toBe(200);
        const text = JSON.stringify(res.body);
        // The Crowded port has a hook named "webhook", so the key is checked on the binding and as the secrets-bearing object.
        expect(text, `${h.name}/${capability}`).not.toContain('"webhook":{"secrets"');
        expect(text).not.toContain('"secrets"');
        expect(JSON.stringify((res.body as { binding: object }).binding)).not.toContain('webhook');
        for (const secret of [...h.secrets, STRIPE_KEY, TOKEN]) expect(text).not.toContain(secret);
        expect(res.body).toMatchObject({ capability, binding: { provider: h.name, mode: 'sandbox' } });
        expect(Object.keys((res.body as { binding: object }).binding).sort()).toEqual(['mode', 'provider']);
        n += 1;
      }
    }
    expect(n).toBe(3);
  });

  it('a simulator-bound capability still answers its provider and mode', async () => {
    const { simulators } = createRegistry('sim', systemClock(), {});
    expect((await handle(simulators, 'GET', '/ports/kyc')).body).toMatchObject({ binding: { provider: 'simulator', mode: 'sim' } });
  });

  it('the secret list on a binding is a frozen copy: not the config array, and nothing can change what is accepted', () => {
    for (const [name, config, capability] of [['stripe', stripeCfg, 'funding'], ['crowded', crowdedCfg, 'institution-banking']] as const) {
      const { registry } = createRegistry('sandbox', systemClock(), overridesFromConfig(config, nodb, undefined, (async () => new Response('{}')) as typeof fetch));
      for (const market of MARKETS) {
        const list = registry.bindingFor(capability, market)?.webhook?.secrets as string[];
        const before = [...list];
        expect(Object.isFrozen(list), `${name}/${market}`).toBe(true);
        expect(Object.isFrozen(registry.bindingFor(capability, market)?.webhook), `${name}/${market} webhook`).toBe(true);
        expect(() => { (registry.bindingFor(capability, market) as unknown as { webhook: { secrets: string[] } }).webhook.secrets = []; }).toThrow(TypeError);
        expect(() => list.push('whsec_attacker')).toThrow(TypeError);
        expect(() => { list[0] = 'whsec_attacker'; }).toThrow(TypeError);
        expect(() => list.pop()).toThrow(TypeError);
        expect(() => list.sort()).toThrow(TypeError);
        expect(list).toEqual(before);
      }
    }
    const crowded2 = createRegistry('sandbox', systemClock(), overridesFromConfig(crowdedCfg, nodb)).registry;
    expect(crowdedWebhookSecrets(crowded2, 'US')).toEqual([CURRENT, PREVIOUS, 'whsec-older-0123456789']);
    // The reader hands back a copy it owns: changing it changes nothing.
    crowdedWebhookSecrets(crowded2, 'US').push('x');
    expect(crowdedWebhookSecrets(crowded2, 'US')).toHaveLength(3);
  });

  it('the markets share one frozen list per capability set, and it is not the caller\'s array', () => {
    const list = [new Secret(CURRENT), new Secret(PREVIOUS)];
    const { registry } = createRegistry('sim', systemClock(), { institutionBanking: override({ webhookSecrets: list }) });
    const bound = registry.bindingFor('institution-banking', 'US')?.webhook?.secrets;
    expect(bound).toEqual([CURRENT, PREVIOUS]);
    list.push(new Secret('whsec-late-0123456789'));
    expect(registry.bindingFor('institution-banking', 'US')?.webhook?.secrets).toEqual([CURRENT, PREVIOUS]);
  });

  it('duplicates in the configured list are kept: the binding list equals the config list ([A, B, B])', () => {
    const dup = [CURRENT, PREVIOUS, PREVIOUS];
    const { registry } = createRegistry('sim', systemClock(), { institutionBanking: override({ webhookSecrets: dup.map((s) => new Secret(s)) }) });
    for (const market of MARKETS) expect(registry.bindingFor('institution-banking', market)?.webhook?.secrets).toEqual(dup);
    expect(crowdedWebhookSecrets(registry, 'IL')).toEqual(dup);
    const stripe = createRegistry('sandbox', systemClock(), overridesFromConfig({ ...sim, ...stripeSet, STRIPE_WEBHOOK_SECRET: dup.map((s) => new Secret(s)) }, nodb, undefined, (async () => new Response('{}')) as typeof fetch)).registry;
    for (const market of MARKETS) for (const capability of ['funding', 'billing']) expect(stripe.bindingFor(capability, market)?.webhook?.secrets).toEqual(dup);
  });
});
