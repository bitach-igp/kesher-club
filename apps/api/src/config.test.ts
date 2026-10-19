// T-0020: the API and worker configuration. Missing or bad values crash with every problem named;
// a secret never reaches an error message or a log line.
import { ConfigError, Secret } from '@kesher/domain';
import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig } from './config.ts';

const SIGNING_JWK = '{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"super-secret-d"}';
const env = {
  NODE_ENV: 'preview',
  DATABASE_URL: 'postgres://club_app@db.internal:5432/club',
  TEMPORAL_ADDRESS: 'temporal.internal:7233',
  PROVIDER_MODE_DEFAULT: 'sim',
  TOKEN_SIGNING_JWK: SIGNING_JWK,
  TOKEN_SIGNING_KID: 'k-2026-10',
  TOKEN_ISSUER: 'https://api.preview.kesher.club',
  MARKET: 'IL',
  STAFF_JWKS: '{"keys":[{"kty":"EC","crv":"P-256","x":"x","y":"y","kid":"staff-1"}]}',
  PORT: '8080',
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
    expect(c.TOKEN_SIGNING_JWK).toBeInstanceOf(Secret);
    expect(c.TOKEN_SIGNING_JWK.reveal()).toBe(SIGNING_JWK);
    expect(c.STAFF_JWKS).toEqual([{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'staff-1' }]);
  });

  it('the worker needs everything but the port', () => {
    const { PORT: _port, ...workerEnv } = env;
    expect(loadWorkerConfig(workerEnv).MARKET).toBe('IL');
    expect(thrown(() => loadApiConfig(workerEnv)).missing).toEqual(['PORT']);
  });

  it('names every missing value at once, and an empty string counts as missing', () => {
    const e = thrown(() => loadApiConfig({ ...env, DATABASE_URL: undefined, TOKEN_SIGNING_JWK: '', STAFF_JWKS: undefined }));
    expect([...e.missing].sort()).toEqual(['DATABASE_URL', 'STAFF_JWKS', 'TOKEN_SIGNING_JWK']);
  });

  it('never prints the signing key: not in the error, not in the loaded config', () => {
    const e = thrown(() => loadApiConfig({ ...env, MARKET: 'FR' }));
    expect(e.message).toMatch(/MARKET/);
    expect(e.message).not.toContain('super-secret-d');
    const c = loadApiConfig(env);
    expect(JSON.stringify(c)).not.toContain('super-secret-d');
    expect(String(c.TOKEN_SIGNING_JWK)).toBe('[redacted]');
  });

  it('refuses a staff JWKS that is not a key set', () => {
    for (const STAFF_JWKS of ['not json', '{"keys":[]}', '{"keys":[{"kid":"no-kty"}]}']) {
      expect(thrown(() => loadApiConfig({ ...env, STAFF_JWKS })).invalid.join()).toMatch(/STAFF_JWKS/);
    }
  });

  it('runs on simulators only until ADR-006 wires a vendor, and never on simulators in production', () => {
    expect(thrown(() => loadApiConfig({ ...env, PROVIDER_MODE_DEFAULT: 'sandbox' })).invalid.join()).toMatch(/PROVIDER_MODE_DEFAULT: only sim/);
    expect(thrown(() => loadApiConfig({ ...env, NODE_ENV: 'production' })).invalid.join()).toMatch(/PROVIDER_MODE_DEFAULT: simulators are not allowed in production/);
  });
});
