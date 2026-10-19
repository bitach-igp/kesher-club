// Process configuration for the API and the worker (T-0020, constitution art. 6). Both build their
// services through createApp, so they share one shape; the API adds its port. The base shape from
// @kesher/domain brings NODE_ENV, DATABASE_URL, TEMPORAL_ADDRESS and PROVIDER_MODE_DEFAULT, and already
// refuses simulators in production. Only `sim` is accepted for now: no vendor adapter is wired into the
// registry until ADR-006 names a processor, so `sandbox` and `live` would boot on nothing.
// `loadConfig` throws ConfigError naming every missing or invalid key; secrets never print.
import { defineConfig, loadConfig, secret, type Config, type Secret } from '@kesher/domain';
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

/** A 32-byte key, standard base64. Decoding is strict: Node's base64 decoder skips junk, so re-encode and compare. */
const key32 = () =>
  secret().refine((k) => {
    const raw = k.reveal();
    const bytes = Buffer.from(raw, 'base64');
    return bytes.length === 32 && bytes.toString('base64') === raw;
  }, 'must be 32 bytes, standard base64');

const shared = {
  /** The member token key: a private ES256 JWK as JSON, from Secrets Manager. Checked here, because a
   *  JSON.parse error quotes its input and would carry the key into a boot log. */
  TOKEN_SIGNING_JWK: secret().refine((k) => {
    try {
      const jwk = JSON.parse(k.reveal()) as Record<string, unknown>;
      return jwk['kty'] === 'EC' && jwk['crv'] === 'P-256' && ['x', 'y', 'd'].every((f) => typeof jwk[f] === 'string');
    } catch {
      return false;
    }
  }, 'must be a private ES256 JWK (kty EC, crv P-256, with x, y and d)'),
  TOKEN_SIGNING_KID: z.string().min(1),
  TOKEN_ISSUER: z.string().url(),
  MARKET: z.enum(['US', 'IL']),
  /** Public JWKS of the admin console's staff-token key (ADR-013). Public, so not a secret. */
  STAFF_JWKS: jwksJson,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Field-level PII keys (T-0024): one seals, the other blind-indexes. Never the same key. */
  PII_DATA_KEY: key32(),
  PII_INDEX_KEY: key32(),
};

const processRules = (cfg: unknown, ctx: z.RefinementCtx) => {
  const c = cfg as { PROVIDER_MODE_DEFAULT: string; PII_DATA_KEY: Secret; PII_INDEX_KEY: Secret };
  if (c.PROVIDER_MODE_DEFAULT !== 'sim') {
    ctx.addIssue({ code: 'custom', path: ['PROVIDER_MODE_DEFAULT'], message: 'only sim until ADR-006 wires a vendor adapter' });
  }
  if (c.PII_DATA_KEY.reveal() === c.PII_INDEX_KEY.reveal()) {
    ctx.addIssue({ code: 'custom', path: ['PII_INDEX_KEY'], message: 'must differ from PII_DATA_KEY' });
  }
};

export const apiConfigSchema = defineConfig({ ...shared, PORT: z.coerce.number().int().min(1).max(65535) }).superRefine(processRules);
export const workerConfigSchema = defineConfig(shared).superRefine(processRules);

export type ApiConfig = Config<typeof apiConfigSchema>;
export type WorkerConfig = Config<typeof workerConfigSchema>;

export const loadApiConfig = (env: Record<string, string | undefined>): ApiConfig => loadConfig(apiConfigSchema, env);
export const loadWorkerConfig = (env: Record<string, string | undefined>): WorkerConfig => loadConfig(workerConfigSchema, env);
