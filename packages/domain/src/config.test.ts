// T-0004: config loader. Gate "fallback secrets" (Tab 3 §8): a missing required variable crashes
// at boot with every missing name listed; secrets never have defaults and never print.
import { describe, expect, it } from 'vitest';
import { ConfigError, baseConfigSchema, defineConfig, loadConfig, secret } from './config.ts';
import { z } from 'zod';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://club_app:pw@localhost:5432/club',
  TEMPORAL_ADDRESS: 'localhost:7233',
  PROVIDER_MODE_DEFAULT: 'sim',
};

describe('config loader', () => {
  it('loads a valid environment', () => {
    const cfg = loadConfig(baseConfigSchema, valid);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PROVIDER_MODE_DEFAULT).toBe('sim');
  });

  it('crashes on boot listing every missing variable, not just the first', () => {
    expect(() => loadConfig(baseConfigSchema, { NODE_ENV: 'development' })).toThrow(ConfigError);
    try {
      loadConfig(baseConfigSchema, { NODE_ENV: 'development' });
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

  it('refuses simulator mode in production (fail secure)', () => {
    expect(() => loadConfig(baseConfigSchema, { ...valid, NODE_ENV: 'production' })).toThrow(/PROVIDER_MODE_DEFAULT/);
    expect(loadConfig(baseConfigSchema, { ...valid, NODE_ENV: 'production', PROVIDER_MODE_DEFAULT: 'live' }).PROVIDER_MODE_DEFAULT).toBe('live');
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
