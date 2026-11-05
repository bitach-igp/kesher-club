// Process configuration for the API and the worker (T-0020, constitution art. 6). Both build their
// services through createApp, so they share one shape; the API adds its port. The base shape from
// @kesher/domain brings APP_ENV, DATABASE_URL, TEMPORAL_ADDRESS and PROVIDER_MODE_DEFAULT, and already
// refuses simulators in prod. Key names are the ones Terraform passes (T-0025); the database password
// may arrive separately as PGPASSWORD, which node-postgres reads when DATABASE_URL carries none.
// PROVIDER_MODE_DEFAULT is `sim` or `sandbox` (T-0040). It only labels the environment: which vendor backs a port is chosen per
// port by a PROVIDER_<PORT> key (T-0659 for the US banking port), and a port with no choice stays on its simulator. `live` is
// refused until the production guard (T-0043). `PROVIDER_PORTS` below is the one table of those keys and each adapter's
// credentials, which are an all-there-or-refused set. A PROVIDER_* key the table does not list is NOT refused: Terraform injects
// PROVIDER_WEBHOOK_SECRETS as an ECS secret that no code reads yet, and refusing it would stop the boot.
// `loadConfig` throws ConfigError naming every missing or invalid key; secrets never print.
import { ConfigError, defineConfig, loadConfig, secret, Secret, type Config } from '@kesher/domain';
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

/** An https URL with a host. The message never quotes the value. */
const httpsUrl = () => z.string().refine((v) => /^https:\/\/[^/\s?#]+/.test(v) && URL.canParse(v), 'must be an https URL');

/**
 * One or two comma-separated secrets (the current endpoint secret and, during a rotation, the previous one). The parser reports
 * only the rule that failed, never a value; a repeated secret is a rotation that rotated nothing.
 */
const secretPair = () =>
  z.string().transform((raw, ctx): Secret[] => {
    const parts = raw.split(',').map((p) => p.trim());
    if (parts.length >= 1 && parts.length <= 2 && parts.every((p) => p !== '') && new Set(parts).size === parts.length) return parts.map((p) => new Secret(p));
    ctx.addIssue({ code: 'custom', message: 'must be one or two distinct, non-empty secrets separated by a comma' });
    return z.NEVER;
  });

/**
 * The ports that can leave their simulator (T-0040). `env` is the key that chooses the provider; each adapter lists the
 * credentials it needs. Adding a vendor is a row here, its keys in `shared` and a registry binding.
 */
export const PROVIDER_PORTS = {
  'institution-banking': { env: 'PROVIDER_INSTITUTION_BANKING', adapters: { crowded: ['CROWDED_BASE_URL', 'CROWDED_API_TOKEN', 'CROWDED_WEBHOOK_SECRETS'] } },
} as const satisfies Record<string, { env: string; adapters: Record<string, readonly string[]> }>;

const shared = {
  /**
   * Which provider backs the US banking port (T-0659). A per-port override: PROVIDER_MODE_DEFAULT stays `sim` (ADR-006 names no
   * processor), and `crowded` binds only `institution-banking` to the Crowded adapter. It needs the three CROWDED_* keys.
   */
  PROVIDER_INSTITUTION_BANKING: z.enum(['sim', 'crowded']).default('sim'),
  CROWDED_BASE_URL: httpsUrl().optional(),
  /** The binding mode recorded for the port: `sandbox` (default, whatever the base URL) or `live`, only when set explicitly. Not part of the all-or-nothing set. */
  CROWDED_BINDING: z.enum(['sandbox', 'live']).default('sandbox'),
  CROWDED_API_TOKEN: secret().optional(),
  /** The endpoint secret and, during a rotation, the previous one, comma-separated. */
  CROWDED_WEBHOOK_SECRETS: secretPair().optional(),
  /** The member token key: a private ES256 JWK as JSON, from Secrets Manager. Checked here, because a
   *  JSON.parse error quotes its input and would carry the key into a boot log. */
  JWT_SIGNING_KEY: secret().refine((k) => {
    try {
      const jwk = JSON.parse(k.reveal()) as Record<string, unknown>;
      return jwk['kty'] === 'EC' && jwk['crv'] === 'P-256' && ['x', 'y', 'd'].every((f) => typeof jwk[f] === 'string');
    } catch {
      return false;
    }
  }, 'must be a private ES256 JWK (kty EC, crv P-256, with x, y and d)'),
  JWT_SIGNING_KID: z.string().min(1),
  TOKEN_ISSUER: z.string().url(),
  /** Where the member app is served on the web (T-1014): an assistant's consent request opens {MEMBER_APP_URL}/connect/{id}.
   *  Unset, it opens the native app's kesher://connect link. */
  MEMBER_APP_URL: z.string().url().optional(),
  MARKET: z.enum(['US', 'IL']),
  /** Public JWKS of the admin console's staff-token key (ADR-013). Public, so not a secret. */
  STAFF_JWKS: jwksJson,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Field-level PII keys (T-0024): one seals, the other blind-indexes. Never the same key. */
  PII_DATA_KEY: key32(),
  PII_INDEX_KEY: key32(),
};

const processRules = (cfg: unknown, ctx: z.RefinementCtx) => {
  const c = cfg as {
    PROVIDER_MODE_DEFAULT: string;
    PROVIDER_INSTITUTION_BANKING: 'sim' | 'crowded';
    CROWDED_BASE_URL?: string | undefined;
    CROWDED_API_TOKEN?: Secret | undefined;
    CROWDED_WEBHOOK_SECRETS?: Secret[] | undefined;
    PII_DATA_KEY: Secret;
    PII_INDEX_KEY: Secret;
  };
  if (c.PROVIDER_MODE_DEFAULT !== 'sim' && c.PROVIDER_MODE_DEFAULT !== 'sandbox') {
    ctx.addIssue({ code: 'custom', path: ['PROVIDER_MODE_DEFAULT'], message: 'only sim or sandbox; live waits for the production guard (T-0043)' });
  }
  // The Crowded keys come as a set: `crowded` needs all three, and a partial set is refused even while the port stays on the
  // simulator (half a credential is a mistake, not a choice). A key left out is reported as missing by name.
  const crowdedKeys = ['CROWDED_BASE_URL', 'CROWDED_API_TOKEN', 'CROWDED_WEBHOOK_SECRETS'] as const;
  const present = crowdedKeys.filter((k) => c[k] !== undefined);
  if (c.PROVIDER_INSTITUTION_BANKING === 'crowded' || present.length > 0) {
    for (const k of crowdedKeys) if (c[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: 'required when any Crowded key is set or PROVIDER_INSTITUTION_BANKING=crowded' });
  }
  if (c.PII_DATA_KEY.reveal() === c.PII_INDEX_KEY.reveal()) {
    ctx.addIssue({ code: 'custom', path: ['PII_INDEX_KEY'], message: 'must differ from PII_DATA_KEY' });
  }
};

export const apiConfigSchema = defineConfig({ ...shared, PORT: z.coerce.number().int().min(1).max(65535) }).superRefine(processRules);
export const workerConfigSchema = defineConfig(shared).superRefine(processRules);

export type ApiConfig = Config<typeof apiConfigSchema>;
export type WorkerConfig = Config<typeof workerConfigSchema>;

/**
 * The credentials the raw env leaves out while a set is in play (the port chose the adapter, or any key of the set is present).
 * zod skips an object-level refinement once any field has failed, so `processRules` alone would hide a half-set credential
 * behind, say, a bad MARKET; this runs on the raw env instead.
 */
const missingProviderKeys = (env: Record<string, string | undefined>): string[] => {
  const set = (k: string) => env[k] !== undefined && env[k] !== '';
  const missing: string[] = [];
  for (const port of Object.values(PROVIDER_PORTS)) {
    for (const [adapter, keys] of Object.entries(port.adapters)) {
      if (env[port.env] === adapter || keys.some(set)) missing.push(...keys.filter((k) => !set(k)));
    }
  }
  return missing;
};

/** `loadConfig`, plus the provider credential-set check reported alongside any other problem rather than behind it. */
const load = <S extends Parameters<typeof loadConfig>[0]>(schema: S, env: Record<string, string | undefined>): Config<S> => {
  try {
    return loadConfig(schema, env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    const extra = missingProviderKeys(env).filter((k) => !e.missing.includes(k));
    if (extra.length === 0) throw e;
    throw new ConfigError([...e.missing, ...extra], e.invalid);
  }
};

export const loadApiConfig = (env: Record<string, string | undefined>): ApiConfig => load(apiConfigSchema, env);
export const loadWorkerConfig = (env: Record<string, string | undefined>): WorkerConfig => load(workerConfigSchema, env);
