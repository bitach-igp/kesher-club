// T-0004: config loader. Gate "fallback secrets" (Tab 3 §8): a missing required variable crashes
// at boot with every missing name listed; secrets never have defaults and never print.
import { describe, expect, it } from 'vitest';
import { ConfigError, baseConfigSchema, defineConfig, loadConfig, secret } from './config.ts';
import { z } from 'zod';

const valid = {
  APP_ENV: 'development',
  DATABASE_URL: 'postgres://club_app:pw@localhost:5432/club',
  TEMPORAL_ADDRESS: 'localhost:7233',
  PROVIDER_MODE_DEFAULT: 'sim',
};

describe('config loader', () => {
  it('loads a valid environment', () => {
    const cfg = loadConfig(baseConfigSchema, valid);
    expect(cfg.APP_ENV).toBe('development');
    expect(cfg.PROVIDER_MODE_DEFAULT).toBe('sim');
  });

  it('crashes on boot listing every missing variable, not just the first', () => {
    expect(() => loadConfig(baseConfigSchema, { APP_ENV: 'development' })).toThrow(ConfigError);
    try {
      loadConfig(baseConfigSchema, { APP_ENV: 'development' });
    } catch (e) {
      const err = e as ConfigError;
      expect(err.missing).toEqual(['DATABASE_URL', 'TEMPORAL_ADDRESS', 'PROVIDER_MODE_DEFAULT']);
      expect(err.message).toContain('DATABASE_URL');
      expect(err.message).toContain('TEMPORAL_ADDRESS');
    }
  });

  it('treats an empty string as missing (no silent blanks)', () => {
    expect(() => loadConfig(baseConfigSchema, { ...valid, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('refuses simulator mode in prod (fail secure)', () => {
    expect(() => loadConfig(baseConfigSchema, { ...valid, APP_ENV: 'prod' })).toThrow(/PROVIDER_MODE_DEFAULT/);
    expect(loadConfig(baseConfigSchema, { ...valid, APP_ENV: 'prod', PROVIDER_MODE_DEFAULT: 'live' }).PROVIDER_MODE_DEFAULT).toBe('live');
  });

  it('names the environment in APP_ENV, as Terraform passes it, and ignores NODE_ENV (T-0025)', () => {
    // Every container runs with NODE_ENV=production; that must not make a preview count as prod.
    expect(loadConfig(baseConfigSchema, { ...valid, APP_ENV: 'preview', NODE_ENV: 'production' }).APP_ENV).toBe('preview');
    expect(() => loadConfig(baseConfigSchema, { ...valid, APP_ENV: 'production' })).toThrow(/APP_ENV/);
    expect(() => loadConfig(baseConfigSchema, { DATABASE_URL: valid.DATABASE_URL, TEMPORAL_ADDRESS: valid.TEMPORAL_ADDRESS, PROVIDER_MODE_DEFAULT: 'sim', NODE_ENV: 'development' })).toThrow(/APP_ENV/);
  });

  it('secrets have no default and are redacted when the config is printed or serialised', () => {
    const schema = defineConfig({ STRIPE_SECRET_KEY: secret() });
    expect(() => loadConfig(schema, valid)).toThrow(/STRIPE_SECRET_KEY/);
    const cfg = loadConfig(schema, { ...valid, STRIPE_SECRET_KEY: 'sk_live_abc' });
    expect(cfg.STRIPE_SECRET_KEY.reveal()).toBe('sk_live_abc');
    expect(String(cfg.STRIPE_SECRET_KEY)).toBe('[redacted]');
    expect(JSON.stringify(cfg)).not.toContain('sk_live');
    expect(JSON.stringify(cfg)).toContain('[redacted]');
  });

  it('rejects a default on a secret at schema definition time', () => {
    expect(() => defineConfig({ API_KEY: secret().default('x' as never) })).toThrow(/default/);
  });

  it('extends the base schema with typed extras', () => {
    const schema = defineConfig({ PORT: z.coerce.number().int().min(1).max(65535) });
    expect(loadConfig(schema, { ...valid, PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadConfig(schema, { ...valid, PORT: 'eighty' })).toThrow(/PORT/);
  });
});
