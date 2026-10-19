// Config loader (T-0004). Constitution art. 6: missing configuration crashes on boot and
// secrets have no fallback. Apps call `loadConfig(defineConfig({...}), process.env)` exactly once.
import { z } from 'zod';

export class ConfigError extends Error {
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
  constructor(
    missing: readonly string[],
    invalid: readonly string[],
  ) {
    super(
      [
        missing.length ? `Missing configuration: ${missing.join(', ')}` : '',
        invalid.length ? `Invalid configuration: ${invalid.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('. '),
    );
    this.missing = missing;
    this.invalid = invalid;
    this.name = 'ConfigError';
  }
}

/** A value that never prints. `reveal()` is the only way to read it. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

const SECRET_MARK = Symbol('kesher.secret');

/** A required secret: non-empty string, wrapped so it cannot leak through logs. Never has a default. */
export function secret() {
  const schema = z
    .string()
    .min(1)
    .transform((v) => new Secret(v));
  (schema as unknown as Record<symbol, boolean>)[SECRET_MARK] = true;
  return schema;
}

export const baseConfigShape = {
  NODE_ENV: z.enum(['development', 'test', 'preview', 'staging', 'production']),
  DATABASE_URL: z.string().url(),
  TEMPORAL_ADDRESS: z.string().regex(/^[^\s:]+:\d+$/, 'host:port'),
  PROVIDER_MODE_DEFAULT: z.enum(['sim', 'sandbox', 'live']),
} as const;

const failSecure = (cfg: unknown, ctx: z.RefinementCtx) => {
  const c = cfg as { NODE_ENV: string; PROVIDER_MODE_DEFAULT: string };
  if (c.NODE_ENV === 'production' && c.PROVIDER_MODE_DEFAULT === 'sim') {
    ctx.addIssue({ code: 'custom', path: ['PROVIDER_MODE_DEFAULT'], message: 'simulators are not allowed in production' });
  }
};

/** Builds a config schema: the base shape plus app-specific keys. Secrets may not carry defaults. */
export function defineConfig<T extends z.ZodRawShape>(extra: T) {
  for (const [key, schema] of Object.entries(extra)) {
    let node: unknown = schema;
    let wrappedInDefault = false;
    while (node && typeof node === 'object') {
      const def = (node as { def?: { type?: string; innerType?: unknown } }).def;
      if (def?.type === 'default') wrappedInDefault = true;
      if (wrappedInDefault && (node as Record<symbol, boolean>)[SECRET_MARK]) {
        throw new Error(`Secret ${key} may not have a default (constitution art. 6)`);
      }
      node = def?.innerType;
    }
  }
  return z.object({ ...baseConfigShape, ...extra }).superRefine(failSecure);
}

export const baseConfigSchema = defineConfig({});

export type Config<S extends z.ZodTypeAny> = z.infer<S>;

/** Parses `env` with `schema`. Empty strings count as missing. Throws ConfigError listing every problem. */
export function loadConfig<S extends z.ZodTypeAny>(schema: S, env: Record<string, string | undefined>): z.infer<S> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') cleaned[k] = v;
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join('.') || '(root)';
    const top = issue.path[0];
    const isMissing = typeof top === 'string' && !(top in cleaned);
    if (isMissing) missing.push(key);
    else invalid.push(`${key}: ${issue.message}`);
  }
  throw new ConfigError(missing, invalid);
}
