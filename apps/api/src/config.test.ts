// T-0020: the API and worker configuration. Missing or bad values crash with every problem named;
// a secret never reaches an error message or a log line.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { ConfigError, Secret } from '@kesher/domain';
import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig } from './config.ts';

const SIGNING_JWK = '{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"super-secret-d"}';
const DATA_KEY = randomBytes(32).toString('base64');
const env = {
  APP_ENV: 'preview',
  DATABASE_URL: 'postgres://club_app@db.internal:5432/club',
  TEMPORAL_ADDRESS: 'temporal.internal:7233',
  PROVIDER_MODE_DEFAULT: 'sim',
  JWT_SIGNING_KEY: SIGNING_JWK,
  JWT_SIGNING_KID: 'k-2026-10',
  TOKEN_ISSUER: 'https://api.preview.kesher.club',
  MARKET: 'IL',
  STAFF_JWKS: '{"keys":[{"kty":"EC","crv":"P-256","x":"x","y":"y","kid":"staff-1"}]}',
  PORT: '8080',
  PII_DATA_KEY: DATA_KEY,
  PII_INDEX_KEY: randomBytes(32).toString('base64'),
};

const thrown = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected a ConfigError');
};

describe('API and worker config (T-0020)', () => {
  it('loads a complete environment with the defaults filled in', () => {
    const c = loadApiConfig(env);
    expect(c).toMatchObject({ PORT: 8080, MARKET: 'IL', DATABASE_POOL_MAX: 10, PROVIDER_MODE_DEFAULT: 'sim' });
    expect(c.JWT_SIGNING_KEY).toBeInstanceOf(Secret);
    expect(c.JWT_SIGNING_KEY.reveal()).toBe(SIGNING_JWK);
    expect(c.STAFF_JWKS).toEqual([{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'staff-1' }]);
  });

  it('the worker needs everything but the port', () => {
    const { PORT: _port, ...workerEnv } = env;
    expect(loadWorkerConfig(workerEnv).MARKET).toBe('IL');
    expect(thrown(() => loadApiConfig(workerEnv)).missing).toEqual(['PORT']);
  });

  it('names every missing value at once, and an empty string counts as missing', () => {
    const e = thrown(() => loadApiConfig({ ...env, DATABASE_URL: undefined, JWT_SIGNING_KEY: '', STAFF_JWKS: undefined }));
    expect([...e.missing].sort()).toEqual(['DATABASE_URL', 'JWT_SIGNING_KEY', 'STAFF_JWKS']);
  });

  it('never prints the signing key: not in the error, not in the loaded config', () => {
    const e = thrown(() => loadApiConfig({ ...env, MARKET: 'FR' }));
    expect(e.message).toMatch(/MARKET/);
    expect(e.message).not.toContain('super-secret-d');
    const c = loadApiConfig(env);
    expect(JSON.stringify(c)).not.toContain('super-secret-d');
    expect(String(c.JWT_SIGNING_KEY)).toBe('[redacted]');
  });

  it('refuses a signing key that is not a private ES256 JWK, without quoting it', () => {
    for (const JWT_SIGNING_KEY of ['{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"super-secret-d" oops', '{"kty":"EC","crv":"P-256","x":"x","y":"y"}', '{"kty":"RSA","n":"n","e":"e","d":"super-secret-d"}']) {
      const e = thrown(() => loadApiConfig({ ...env, JWT_SIGNING_KEY }));
      expect(e.invalid.join()).toMatch(/JWT_SIGNING_KEY/);
      expect(e.message).not.toContain('super-secret-d');
    }
  });

  it('takes two distinct 32-byte PII keys and never prints them (T-0024)', () => {
    expect(loadApiConfig(env).PII_DATA_KEY.reveal()).toBe(DATA_KEY);
    const bad = [
      ['PII_DATA_KEY', randomBytes(16).toString('base64')],
      ['PII_DATA_KEY', `${DATA_KEY.slice(0, 10)}*${DATA_KEY.slice(10)}`], // lenient base64 would read the same 32 bytes
      ['PII_INDEX_KEY', DATA_KEY],
    ] as const;
    for (const [k, v] of bad) {
      const e = thrown(() => loadApiConfig({ ...env, [k]: v }));
      expect(e.invalid.join()).toMatch(new RegExp(k));
      expect(e.message).not.toContain(v);
    }
    expect(thrown(() => loadApiConfig({ ...env, PII_INDEX_KEY: undefined })).missing).toEqual(['PII_INDEX_KEY']);
  });

  it('refuses a staff JWKS that is not a key set', () => {
    for (const STAFF_JWKS of ['not json', '{"keys":[]}', '{"keys":[{"kid":"no-kty"}]}']) {
      expect(thrown(() => loadApiConfig({ ...env, STAFF_JWKS })).invalid.join()).toMatch(/STAFF_JWKS/);
    }
  });

  it('takes sim or sandbox as the environment label, refuses live, and never allows simulators in production', () => {
    expect(loadApiConfig({ ...env, PROVIDER_MODE_DEFAULT: 'sandbox' }).PROVIDER_MODE_DEFAULT).toBe('sandbox');
    expect(loadWorkerConfig({ ...env, PROVIDER_MODE_DEFAULT: 'sandbox' }).PROVIDER_MODE_DEFAULT).toBe('sandbox');
    expect(thrown(() => loadApiConfig({ ...env, PROVIDER_MODE_DEFAULT: 'live' })).invalid.join()).toMatch(/PROVIDER_MODE_DEFAULT: only sim or sandbox/);
    expect(thrown(() => loadApiConfig({ ...env, APP_ENV: 'prod' })).invalid.join()).toMatch(/PROVIDER_MODE_DEFAULT: simulators are not allowed in production/);
  });
});

// T-0659 (REQ-INS-022, REQ-INS-025): the banking port is a per-port override, not a new global mode.
const TOKEN = 'crowded-api-token-do-not-print';
const WH_SECRET = 'whsec-current-do-not-print';
const WH_PREVIOUS = 'whsec-previous-do-not-print';
const crowded = { PROVIDER_INSTITUTION_BANKING: 'crowded', CROWDED_BASE_URL: 'https://sandbox-api.crowdedfinance.com/api/v1', CROWDED_API_TOKEN: TOKEN, CROWDED_WEBHOOK_SECRETS: WH_SECRET };

describe('SERVICE_ROLE (T-0063)', () => {
  it('is api by default, jit when asked, and nothing else for the API', () => {
    expect(loadApiConfig(env).SERVICE_ROLE).toBe('api');
    expect(loadApiConfig({ ...env, SERVICE_ROLE: 'jit' }).SERVICE_ROLE).toBe('jit');
    expect(thrown(() => loadApiConfig({ ...env, SERVICE_ROLE: 'worker' })).invalid.join()).toMatch(/SERVICE_ROLE/);
    expect(thrown(() => loadApiConfig({ ...env, SERVICE_ROLE: 'admin' })).invalid.join()).toMatch(/SERVICE_ROLE/);
  });

  it('the worker, which Terraform also gives SERVICE_ROLE=worker, ignores it', () => {
    expect(() => loadWorkerConfig({ ...env, SERVICE_ROLE: 'worker' })).not.toThrow();
  });
});

describe('Crowded banking override (T-0659)', () => {
  it('defaults to the simulator and needs no Crowded key', () => {
    const c = loadApiConfig(env);
    expect(c.PROVIDER_INSTITUTION_BANKING).toBe('sim');
    expect(c.CROWDED_API_TOKEN).toBeUndefined();
    expect(loadApiConfig({ ...env, ...crowded, PROVIDER_MODE_DEFAULT: 'sandbox' }).PROVIDER_INSTITUTION_BANKING).toBe('crowded');
  });

  it('does not refuse a PROVIDER_* key it does not know: Terraform injects PROVIDER_WEBHOOK_SECRETS as an ECS secret (T-0040)', () => {
    expect(loadApiConfig({ ...env, PROVIDER_WEBHOOK_SECRETS: 'whsec-not-read-yet' }).PROVIDER_INSTITUTION_BANKING).toBe('sim');
    expect(loadWorkerConfig({ ...env, PROVIDER_WEBHOOK_SECRETS: 'whsec-not-read-yet' }).MARKET).toBe('IL');
    expect(loadApiConfig({ ...env, PROVIDER_MODE_DEFAULT: 'sandbox', PROVIDER_INSTITUTION_BANKING: 'sim' }).PROVIDER_INSTITUTION_BANKING).toBe('sim');
  });

  it('an empty PROVIDER_* value counts as not set, as every other key does (T-0040)', () => {
    expect(loadApiConfig({ ...env, PROVIDER_INSTITUTION_BANKING: '' }).PROVIDER_INSTITUTION_BANKING).toBe('sim');
  });

  it('loads a full Crowded set for the API and the worker, the token and secrets as Secrets', () => {
    const c = loadApiConfig({ ...env, ...crowded, CROWDED_WEBHOOK_SECRETS: `${WH_SECRET}, ${WH_PREVIOUS}` });
    expect(c.PROVIDER_INSTITUTION_BANKING).toBe('crowded');
    expect(c.CROWDED_BASE_URL).toBe(crowded.CROWDED_BASE_URL);
    expect(c.CROWDED_API_TOKEN).toBeInstanceOf(Secret);
    expect(c.CROWDED_API_TOKEN?.reveal()).toBe(TOKEN);
    expect(c.CROWDED_WEBHOOK_SECRETS?.map((s) => s.reveal())).toEqual([WH_SECRET, WH_PREVIOUS]);
    const { PORT: _port, ...workerEnv } = env;
    expect(loadWorkerConfig({ ...workerEnv, ...crowded }).PROVIDER_INSTITUTION_BANKING).toBe('crowded');
    expect(JSON.stringify(c)).not.toContain(TOKEN);
    expect(JSON.stringify(c)).not.toContain(WH_SECRET);
  });

  it('refuses crowded with a partial Crowded environment, naming what is missing', () => {
    for (const key of ['CROWDED_BASE_URL', 'CROWDED_API_TOKEN', 'CROWDED_WEBHOOK_SECRETS']) {
      const e = thrown(() => loadApiConfig({ ...env, ...crowded, [key]: undefined }));
      expect(e.missing).toEqual([key]);
    }
    expect(thrown(() => loadApiConfig({ ...env, PROVIDER_INSTITUTION_BANKING: 'crowded' })).missing).toEqual(['CROWDED_BASE_URL', 'CROWDED_API_TOKEN', 'CROWDED_WEBHOOK_SECRETS']);
  });

  it('refuses a partial set even while the banking port stays on the simulator', () => {
    const { CROWDED_WEBHOOK_SECRETS: _w, ...partial } = crowded;
    const e = thrown(() => loadApiConfig({ ...env, ...partial, PROVIDER_INSTITUTION_BANKING: 'sim' }));
    expect(e.missing).toEqual(['CROWDED_WEBHOOK_SECRETS']);
    expect(e.message).not.toContain(TOKEN);
  });

  it('accepts a full Crowded set while the banking port stays on the simulator, and ignores it', () => {
    for (const e of [{ ...env, ...crowded, PROVIDER_INSTITUTION_BANKING: 'sim' }, { ...env, CROWDED_BASE_URL: crowded.CROWDED_BASE_URL, CROWDED_API_TOKEN: TOKEN, CROWDED_WEBHOOK_SECRETS: WH_SECRET }]) {
      const c = loadApiConfig(e);
      expect(c.PROVIDER_INSTITUTION_BANKING).toBe('sim');
      expect(c.CROWDED_BASE_URL).toBe(crowded.CROWDED_BASE_URL);
      expect(c.CROWDED_API_TOKEN?.reveal()).toBe(TOKEN);
      expect(JSON.stringify(c)).not.toContain(TOKEN);
    }
    const { PORT: _port, ...workerEnv } = env;
    expect(loadWorkerConfig({ ...workerEnv, ...crowded, PROVIDER_INSTITUTION_BANKING: 'sim' }).PROVIDER_INSTITUTION_BANKING).toBe('sim');
  });

  it('CROWDED_BINDING is sandbox unless set to live, and is not part of the Crowded set', () => {
    expect(loadApiConfig(env).CROWDED_BINDING).toBe('sandbox');
    expect(loadApiConfig({ ...env, ...crowded }).CROWDED_BINDING).toBe('sandbox');
    expect(loadApiConfig({ ...env, ...crowded, CROWDED_BINDING: 'live' }).CROWDED_BINDING).toBe('live');
    // Alone it names no credential, so it does not trigger the partial-set refusal.
    expect(loadApiConfig({ ...env, CROWDED_BINDING: 'live' }).CROWDED_BINDING).toBe('live');
    expect(thrown(() => loadApiConfig({ ...env, ...crowded, CROWDED_BINDING: 'prod' })).invalid.join()).toMatch(/CROWDED_BINDING/);
  });

  it('reports a half-set Crowded credential alongside other config errors, not behind them', () => {
    const { CROWDED_WEBHOOK_SECRETS: _w, ...partial } = crowded;
    const e = thrown(() => loadApiConfig({ ...env, ...partial, MARKET: 'FR' }));
    expect(e.invalid.join()).toMatch(/MARKET/);
    expect(e.missing).toEqual(['CROWDED_WEBHOOK_SECRETS']);
    const { MARKET: _m, ...noMarket } = env;
    expect(thrown(() => loadApiConfig({ ...noMarket, PROVIDER_INSTITUTION_BANKING: 'crowded' })).missing).toEqual(['MARKET', 'CROWDED_BASE_URL', 'CROWDED_API_TOKEN', 'CROWDED_WEBHOOK_SECRETS']);
    // Nothing is reported twice when the schema already named it.
    expect(thrown(() => loadApiConfig({ ...env, ...partial })).missing).toEqual(['CROWDED_WEBHOOK_SECRETS']);
    // The simulator with no Crowded key at all is untouched.
    expect(thrown(() => loadApiConfig({ ...env, MARKET: 'FR' })).missing).toEqual([]);
  });

  it('refuses an unknown banking provider and a base URL that is not https', () => {
    expect(thrown(() => loadApiConfig({ ...env, PROVIDER_INSTITUTION_BANKING: 'stripe' })).invalid.join()).toMatch(/PROVIDER_INSTITUTION_BANKING/);
    for (const CROWDED_BASE_URL of ['http://sandbox-api.crowdedfinance.com/api/v1', 'sandbox-api.crowdedfinance.com', 'ftp://crowded.example', 'https://']) {
      const e = thrown(() => loadApiConfig({ ...env, ...crowded, CROWDED_BASE_URL }));
      expect(e.invalid.join()).toMatch(/CROWDED_BASE_URL/);
      expect(e.message).not.toContain(TOKEN);
    }
  });

  it('takes one or two webhook secrets, and refuses none, three or an empty entry', () => {
    expect(loadApiConfig({ ...env, ...crowded }).CROWDED_WEBHOOK_SECRETS).toHaveLength(1);
    for (const CROWDED_WEBHOOK_SECRETS of ['a,b,c', `${WH_SECRET},`, `,${WH_SECRET}`, `${WH_SECRET},,${WH_PREVIOUS}`, `${WH_SECRET},${WH_SECRET}`]) {
      const e = thrown(() => loadApiConfig({ ...env, ...crowded, CROWDED_WEBHOOK_SECRETS }));
      expect(e.invalid.join()).toMatch(/CROWDED_WEBHOOK_SECRETS/);
      expect(e.message).not.toContain(WH_SECRET);
    }
  });

  it('never puts the token or a webhook secret in an error, whatever else is wrong', () => {
    const e = thrown(() => loadApiConfig({ ...env, ...crowded, CROWDED_WEBHOOK_SECRETS: `${WH_SECRET},${WH_PREVIOUS},extra`, CROWDED_BASE_URL: 'http://x.example', MARKET: 'FR' }));
    for (const s of [TOKEN, WH_SECRET, WH_PREVIOUS]) {
      expect(e.message).not.toContain(s);
      expect(JSON.stringify([e.missing, e.invalid])).not.toContain(s);
    }
    expect(String(loadApiConfig({ ...env, ...crowded }).CROWDED_API_TOKEN)).toBe('[redacted]');
  });
});

// T-0042: Airalo, Cover Genius, WorkOS and the Apple + Google pair.
const APPLE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const RSA_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const GOOGLE_SECRET = 'google-secret-do-not-print';
const AIRALO_SECRET = 'airalo-secret-do-not-print';
const SETS: Record<string, { choose: Record<string, string>; keys: Record<string, string> }> = {
  airalo: {
    choose: { PROVIDER_ESIM: 'airalo' },
    keys: { AIRALO_BASE_URL: 'https://sandbox-partners-api.airalo.com', AIRALO_CLIENT_ID: 'airalo-id', AIRALO_CLIENT_SECRET: AIRALO_SECRET },
  },
  'cover-genius': {
    choose: { PROVIDER_INSURANCE: 'cover-genius' },
    keys: {
      COVER_GENIUS_BASE_URL: 'https://api.sandbox.xcover.com',
      COVER_GENIUS_PARTNER_CODE: 'KESHER',
      COVER_GENIUS_API_KEY: 'xcover-key',
      COVER_GENIUS_API_SECRET: 'xcover-secret-do-not-print',
      COVER_GENIUS_PRODUCTS: '{"gadget":{"policyType":"gadget_protection","commissionBps":2000}}',
      COVER_GENIUS_LICENSED_ENTITY: 'XCover (Cover Genius Ltd), licensed insurance intermediary',
      COVER_GENIUS_COMMISSION_DISCLOSURE: 'Kesher earns a commission on this policy.',
    },
  },
  workos: {
    choose: { PROVIDER_ORG_IDP: 'workos' },
    keys: { WORKOS_CLIENT_ID: 'client_workos', WORKOS_API_KEY: 'sk_workos_do_not_print', WORKOS_WEBHOOK_SECRET: 'whsec_workos' },
  },
  oidc: {
    choose: { PROVIDER_FEDERATED_IDP: 'oidc' },
    keys: {
      APPLE_CLIENT_ID: 'club.kesher.signin',
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_KEY_ID: 'KEY1234567',
      APPLE_PRIVATE_KEY: APPLE_KEY,
      GOOGLE_CLIENT_ID: 'google-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
    },
  },
};

describe('marketplace and identity provider choices (T-0042)', () => {
  it('default to sim and need none of their keys', () => {
    const c = loadApiConfig(env);
    expect([c.PROVIDER_ESIM, c.PROVIDER_INSURANCE, c.PROVIDER_ORG_IDP, c.PROVIDER_FEDERATED_IDP]).toEqual(['sim', 'sim', 'sim', 'sim']);
    expect(c.AIRALO_CLIENT_ID).toBeUndefined();
    expect(c.APPLE_PRIVATE_KEY).toBeUndefined();
    expect(loadWorkerConfig({ ...env }).PROVIDER_ESIM).toBe('sim');
  });

  it('refuses a vendor name it does not know', () => {
    for (const key of ['PROVIDER_ESIM', 'PROVIDER_INSURANCE', 'PROVIDER_ORG_IDP', 'PROVIDER_FEDERATED_IDP']) {
      expect(thrown(() => loadApiConfig({ ...env, [key]: 'holafly' })).invalid.join()).toMatch(new RegExp(key));
    }
  });

  for (const [name, { choose, keys }] of Object.entries(SETS)) {
    describe(name, () => {
      it('loads a full set for the API and the worker, credentials as Secrets', () => {
        const c = loadApiConfig({ ...env, ...choose, ...keys }) as unknown as Record<string, unknown>;
        expect(Object.values(choose)[0]).toBe(name);
        for (const k of Object.keys(keys)) expect(c[k]).toBeDefined();
        expect(loadWorkerConfig({ ...env, ...choose, ...keys })).toBeDefined();
      });

      it('refuses the choice with any key missing, naming only that key', () => {
        for (const key of Object.keys(keys)) {
          const { [key]: _drop, ...rest } = keys;
          const e = thrown(() => loadApiConfig({ ...env, ...choose, ...rest }));
          expect(e.missing).toEqual([key]);
        }
        expect(thrown(() => loadApiConfig({ ...env, ...choose })).missing).toEqual(Object.keys(keys));
      });

      it('refuses a partial set even while the port stays on sim, and accepts the full set while on sim', () => {
        const [first, ...others] = Object.keys(keys);
        const e = thrown(() => loadApiConfig({ ...env, [first!]: keys[first!] }));
        expect(e.missing).toEqual(others);
        expect(() => loadApiConfig({ ...env, ...keys })).not.toThrow();
      });

      it('reports a half-set credential alongside other problems and never prints a value', () => {
        const [first, ...others] = Object.keys(keys);
        const { MARKET: _m, ...noMarket } = env;
        const e = thrown(() => loadApiConfig({ ...noMarket, ...choose, [first!]: keys[first!] }));
        expect(e.missing).toEqual(['MARKET', ...others]);
        const printed = `${e.message} ${e.missing.join()} ${e.invalid.join()}`;
        for (const v of Object.values(keys)) expect(printed).not.toContain(v);
        expect(printed).not.toContain('do-not-print');
      });
    });
  }

  it('Apple and Google come together: either one alone is refused, naming the other half and the flag', () => {
    const { keys } = SETS['oidc']!;
    const appleOnly = Object.fromEntries(Object.entries(keys).filter(([k]) => k.startsWith('APPLE_')));
    const googleOnly = Object.fromEntries(Object.entries(keys).filter(([k]) => k.startsWith('GOOGLE_')));
    for (const [only, absent] of [[appleOnly, 'GOOGLE_'], [googleOnly, 'APPLE_']] as const) {
      for (const choose of [{}, { PROVIDER_FEDERATED_IDP: 'oidc' }]) {
        const e = thrown(() => loadApiConfig({ ...env, ...choose, ...only }));
        expect(e.missing.length).toBeGreaterThan(0);
        expect(e.missing.every((k) => k.startsWith(absent))).toBe(true);
      }
    }
    // The rule itself is reported, on a key that is present (a missing key is reported by name only).
    for (const [only, other] of [[appleOnly, 'GOOGLE_*'], [googleOnly, 'APPLE_*']] as const) {
      const e = thrown(() => loadApiConfig({ ...env, ...only }));
      expect(e.invalid.join('\n')).toContain(`Sign in with Apple and Google are offered together or not at all (auth.social.enabled): the ${other} keys are missing`);
    }
  });

  it('checks the values it can: https URLs, the product map, the commission wording and the PEM, without quoting them', () => {
    const bad: [string, Record<string, string>, string][] = [
      ['airalo', { AIRALO_BASE_URL: 'http://airalo.test' }, 'AIRALO_BASE_URL'],
      ['cover-genius', { COVER_GENIUS_BASE_URL: 'api.xcover.com' }, 'COVER_GENIUS_BASE_URL'],
      ['cover-genius', { COVER_GENIUS_PRODUCTS: '{"gadget":{"policyType":"x"}}' }, 'COVER_GENIUS_PRODUCTS'],
      ['cover-genius', { COVER_GENIUS_PRODUCTS: '[]' }, 'COVER_GENIUS_PRODUCTS'],
      ['cover-genius', { COVER_GENIUS_PRODUCTS: 'not json' }, 'COVER_GENIUS_PRODUCTS'],
      ['cover-genius', { COVER_GENIUS_COMMISSION_DISCLOSURE: 'nothing to see' }, 'COVER_GENIUS_COMMISSION_DISCLOSURE'],
      ['oidc', { APPLE_PRIVATE_KEY: 'apple-key-do-not-print' }, 'APPLE_PRIVATE_KEY'],
      ['oidc', { APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nanVuay1iYXNlNjQtZG8tbm90LXByaW50\n-----END PRIVATE KEY-----' }, 'APPLE_PRIVATE_KEY'],
      ['oidc', { APPLE_PRIVATE_KEY: RSA_PEM }, 'APPLE_PRIVATE_KEY'],
      ['cover-genius', { COVER_GENIUS_PRODUCTS: '{"__proto__":{"policyType":"x","commissionBps":1}}' }, 'COVER_GENIUS_PRODUCTS'],
      ['cover-genius', { COVER_GENIUS_PRODUCTS: '{"constructor":{"policyType":"x","commissionBps":1}}' }, 'COVER_GENIUS_PRODUCTS'],
      ['cover-genius', { COVER_GENIUS_PRODUCTS: '{"":{"policyType":"x","commissionBps":1}}' }, 'COVER_GENIUS_PRODUCTS'],
    ];
    for (const [name, patch, key] of bad) {
      const { choose, keys } = SETS[name]!;
      const e = thrown(() => loadApiConfig({ ...env, ...choose, ...keys, ...patch }));
      expect(e.invalid.join()).toMatch(new RegExp(key));
      expect(`${e.message} ${e.invalid.join()}`).not.toContain('do-not-print');
    }
    const { choose, keys } = SETS['cover-genius']!;
    const c = loadApiConfig({ ...env, ...choose, ...keys });
    expect(c.COVER_GENIUS_PRODUCTS).toEqual({ gadget: { policyType: 'gadget_protection', commissionBps: 2000n } });
  });

  it('accepts a real P-256 key, and rejects a PEM pasted with literal backslash-n sequences with a clear message', () => {
    const { choose, keys } = SETS['oidc']!;
    expect(() => loadApiConfig({ ...env, ...choose, ...keys })).not.toThrow();
    const pasted = keys['APPLE_PRIVATE_KEY']!.replace(/\n/g, '\\n');
    const e = thrown(() => loadApiConfig({ ...env, ...choose, ...keys, APPLE_PRIVATE_KEY: pasted }));
    expect(e.invalid.join()).toMatch(/APPLE_PRIVATE_KEY: has literal backslash-n sequences/);
    expect(e.invalid.join()).not.toContain('BEGIN PRIVATE KEY-----\\n');
  });

  it('product codes are plain own keys: __proto__ never becomes a code', () => {
    const { choose, keys } = SETS['cover-genius']!;
    const c = loadApiConfig({ ...env, ...choose, ...keys });
    expect(Object.keys(c.COVER_GENIUS_PRODUCTS ?? {})).toEqual(['gadget']);
  });

  it('prints no credential through String() or JSON', () => {
    const c = loadApiConfig({ ...env, ...SETS['airalo']!.choose, ...SETS['airalo']!.keys, ...SETS['oidc']!.keys });
    expect(String(c.AIRALO_CLIENT_SECRET)).toBe('[redacted]');
    expect(JSON.stringify({ a: c.AIRALO_CLIENT_SECRET, g: c.GOOGLE_CLIENT_SECRET, k: c.APPLE_PRIVATE_KEY })).not.toMatch(/do-not-print/);
  });
});
