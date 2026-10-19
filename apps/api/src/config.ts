// Process configuration for the API and the worker (T-0020, constitution art. 6). Both build their
// services through createApp, so they share one shape; the API adds its port. The base shape from
// @kesher/domain brings NODE_ENV, DATABASE_URL, TEMPORAL_ADDRESS and PROVIDER_MODE_DEFAULT, and already
// refuses simulators in production. Only `sim` is accepted for now: no vendor adapter is wired into the
// registry until ADR-006 names a processor, so `sandbox` and `live` would boot on nothing.
// `loadConfig` throws ConfigError naming every missing or invalid key; secrets never print.
import { defineConfig, loadConfig, secret, type Config } from '@kesher/domain';
import type { JWK } from 'jose';
import { z } from 'zod';

const jwksJson = z.string().transform((raw, ctx): JWK[] => {
  try {
    const parsed = JSON.parse(raw) as { keys?: unknown };
    if (Array.isArray(parsed.keys) && parsed.keys.length > 0 && parsed.keys.every((k) => typeof k === 'object' && k !== null && 'kty' in k)) return parsed.keys as JWK[];
  } catch {
    // reported below
  }
  ctx.addIssue({ code: 'custom', message: 'must be a JWKS document: {"keys":[{ "kty": … }]}' });
  return z.NEVER;
});

const shared = {
  /** The member token key: a private ES256 JWK as JSON, from Secrets Manager. */
  TOKEN_SIGNING_JWK: secret(),
  TOKEN_SIGNING_KID: z.string().min(1),
  TOKEN_ISSUER: z.string().url(),
  MARKET: z.enum(['US', 'IL']),
  /** Public JWKS of the admin console's staff-token key (ADR-013). Public, so not a secret. */
  STAFF_JWKS: jwksJson,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
};

const simulatorsOnly = (cfg: unknown, ctx: z.RefinementCtx) => {
  if ((cfg as { PROVIDER_MODE_DEFAULT: string }).PROVIDER_MODE_DEFAULT !== 'sim') {
    ctx.addIssue({ code: 'custom', path: ['PROVIDER_MODE_DEFAULT'], message: 'only sim until ADR-006 wires a vendor adapter' });
  }
};

export const apiConfigSchema = defineConfig({ ...shared, PORT: z.coerce.number().int().min(1).max(65535) }).superRefine(simulatorsOnly);
export const workerConfigSchema = defineConfig(shared).superRefine(simulatorsOnly);

export type ApiConfig = Config<typeof apiConfigSchema>;
export type WorkerConfig = Config<typeof workerConfigSchema>;

export const loadApiConfig = (env: Record<string, string | undefined>): ApiConfig => loadConfig(apiConfigSchema, env);
export const loadWorkerConfig = (env: Record<string, string | undefined>): WorkerConfig => loadConfig(workerConfigSchema, env);
