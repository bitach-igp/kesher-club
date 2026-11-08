// T-0659 (REQ-INS-022, REQ-INS-025): the provider registry a process runs on. `sim` binds every port to the
// simulators; a per-port override binds `institution-banking` to the Crowded adapter and nothing else.
import { AiraloEsimAdapter, FederatedIdPRouter, AppleFederatedIdPAdapter, CoverGeniusInsuranceAdapter, GoogleFederatedIdPAdapter, WorkOsOrgIdPAdapter, computeCrowdedSignature, CrowdedInstitutionBankingAdapter, FakeCrowded, InMemoryKeyLedger, SANDBOX_BASE_URL, type KeyLedger } from '@kesher/adapters';
import { generateKeyPairSync } from 'node:crypto';
import { Secret } from '@kesher/domain';
import type { EsimPort, FederatedIdPPort, InstitutionBankingPort, InsurancePort, OrgIdPPort } from '@kesher/ports';
import { PORTS } from '@kesher/ports';
import { describe, expect, it } from 'vitest';
import type { SqlClient } from './db.ts';
import { createRegistry, crowdedWebhookSecrets, IGNORED_LIVE_BINDING_WARNING, LIVE_BINDING_WARNING, overridesFromConfig, systemClock, type CrowdedBankingOverride } from './registry.ts';

const BASE = 'https://crowded.test/api/v1';
const TOKEN = 'crowded-token-do-not-print';
const CURRENT = 'whsec-current-0123456789';
const PREVIOUS = 'whsec-previous-0123456789';
const MARKETS = ['IL', 'US'] as const;
const ALL_SIM = { 'institution-banking': 'sim', esim: 'sim', insurance: 'sim', 'org-idp': 'sim', 'federated-idp': 'sim' };

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
    expect(crowdedWebhookSecrets({ ...full, PROVIDER_INSTITUTION_BANKING: 'sim' })).toEqual([]);
  });

  it('on crowded it passes the config through and the webhook secrets in order', () => {
    const { db } = recorder();
    const o = overridesFromConfig(full, db).institutionBanking!;
    expect(o).toMatchObject({ provider: 'crowded', baseUrl: BASE });
    expect(o.token.reveal()).toBe(TOKEN);
    expect(crowdedWebhookSecrets(full)).toEqual([CURRENT, PREVIOUS]);
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
