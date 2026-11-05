// T-0056: what tools/secrets generates is what the processes accept. The tool checks its values against its own validators; this
// loads them through the real API and worker config, so a change to either schema that the tool does not follow fails here.
import { describe, expect, it } from 'vitest';
import { generateAll, kids } from '../../../tools/secrets/generate.mjs';
import { loadApiConfig, loadWorkerConfig } from './config.ts';

const env = (target: string) => {
  const v = generateAll(target);
  return {
    // The provider label is not under test, and prod refuses simulators: both environments' secrets load as a staging process.
    APP_ENV: 'staging',
    DATABASE_URL: `postgres://club_app:${v['db-app-password']}@db.internal:5432/club`,
    TEMPORAL_ADDRESS: 'temporal.internal:7233',
    PROVIDER_MODE_DEFAULT: 'sim',
    JWT_SIGNING_KEY: v['jwt-signing-key']!,
    JWT_SIGNING_KID: kids(target).jwt,
    TOKEN_ISSUER: 'https://api.kesher.club',
    MARKET: 'IL',
    STAFF_JWKS: v['staff-jwks']!,
    PORT: '3000',
    PII_DATA_KEY: v['pii-data-key']!,
    PII_INDEX_KEY: v['pii-index-key']!,
  };
};

describe('generated secrets load through the process config (T-0056)', () => {
  for (const target of ['staging', 'prod']) {
    it(`${target}: the API and the worker accept the signing key, the staff JWKS and both PII keys`, () => {
      const e = env(target);
      expect(() => loadApiConfig(e)).not.toThrow();
      expect(() => loadWorkerConfig(e)).not.toThrow();
    });
  }

  it('the database password survives a connection URL, which is why it is base64url', () => {
    const e = env('staging');
    const url = new URL(e.DATABASE_URL);
    expect(decodeURIComponent(url.password)).toBe(url.password);
    expect(url.password.length).toBeGreaterThanOrEqual(40);
  });
});
