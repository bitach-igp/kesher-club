// T-0025: what the processes read and what Terraform passes them are one contract. The keys a
// process requires come from the config schemas themselves, the keys an environment passes from its
// Terraform, so adding a required key to the config without wiring it (or renaming it on one side
// only) fails here instead of at boot in AWS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { apiConfigSchema, loadApiConfig, loadWorkerConfig, workerConfigSchema } from './config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

type Shape = Record<string, { safeParse(v: unknown): { success: boolean } }>;
const required = (schema: unknown): string[] =>
  Object.entries((schema as { shape: Shape }).shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key);

/** The body of `name = { … }` in an HCL file, by brace matching (enough for flat maps of KEY = value). */
function block(hcl: string, name: string): string {
  const start = hcl.search(new RegExp(`^\\s*${name}\\s*=\\s*\\{`, 'm'));
  if (start < 0) throw new Error(`no ${name} block`);
  let depth = 0;
  for (let i = hcl.indexOf('{', start); i < hcl.length; i++) {
    if (hcl[i] === '{') depth++;
    if (hcl[i] === '}' && --depth === 0) return hcl.slice(hcl.indexOf('{', start) + 1, i);
  }
  throw new Error(`unclosed ${name} block`);
}
const keys = (body: string): string[] => [...body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]!);

/** Keys the config reads as `secret()`: these must come through ECS secrets, never plain environment. */
const SECRET_KEYS = ['JWT_SIGNING_KEY', 'PII_DATA_KEY', 'PII_INDEX_KEY'];

const ENVIRONMENTS = [
  // MARKET is set per service in staging and prod, one service per market (T-0026).
  // `bootsToday`: whether the environment's PROVIDER_MODE_DEFAULT passes the config (T-0040). Prod passes `live`, which the
  // config refuses until the production guard lands (T-0043, which flips this to true).
  { file: 'infra/preview/main.tf', deferred: [] as string[], appEnv: 'preview', bootsToday: true },
  { file: 'infra/terraform/envs/staging/main.tf', deferred: ['MARKET'], appEnv: 'staging', bootsToday: true },
  { file: 'infra/terraform/envs/prod/main.tf', deferred: ['MARKET'], appEnv: 'prod', bootsToday: false },
];

/** Every other required value, valid: only the keys under test change, so a refusal names the Terraform value alone. */
const VALID = {
  DATABASE_URL: 'postgres://club_app@db.internal:5432/club',
  TEMPORAL_ADDRESS: 'temporal.internal:7233',
  JWT_SIGNING_KEY: '{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"}',
  JWT_SIGNING_KID: 'k-1',
  TOKEN_ISSUER: 'https://api.kesher.club',
  MARKET: 'IL',
  STAFF_JWKS: '{"keys":[{"kty":"EC","crv":"P-256","x":"x","y":"y"}]}',
  PORT: '3000',
  PII_DATA_KEY: randomBytes(32).toString('base64'),
  PII_INDEX_KEY: randomBytes(32).toString('base64'),
};

describe('the process config and Terraform agree (T-0025)', () => {
  for (const { file, deferred, appEnv, bootsToday } of ENVIRONMENTS) {
    describe(file, () => {
      const hcl = read(file);
      const env = keys(block(hcl, 'common_env'));
      const secrets = keys(block(hcl, 'common_secrets'));

      it('passes every key the API and the worker require', () => {
        const passed = new Set([...env, ...secrets, ...deferred]);
        for (const schema of [apiConfigSchema, workerConfigSchema]) {
          expect(required(schema).filter((k) => !passed.has(k))).toEqual([]);
        }
      });

      it('passes values the config accepts for the keys that choose providers (T-0040)', () => {
        // Keys alone were checked above; a value the config refuses fails here, in CI, instead of at boot in AWS.
        const body = block(hcl, 'common_env');
        const value = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(body)?.[1];
        // APP_ENV is `local.env` in the roots that share a locals block, so the environment names it here.
        const chosen = { APP_ENV: appEnv, PROVIDER_MODE_DEFAULT: value('PROVIDER_MODE_DEFAULT') };
        expect(chosen.PROVIDER_MODE_DEFAULT).toBeTruthy();
        const raw = { ...VALID, ...chosen } as Record<string, string>;
        for (const load of [loadApiConfig, loadWorkerConfig]) {
          if (bootsToday) expect(() => load(raw)).not.toThrow();
          // Refused for `live` itself, not for any other reason: the same environment with `sandbox` loads.
          else {
            expect(() => load(raw)).toThrow(/PROVIDER_MODE_DEFAULT: only sim or sandbox/);
            expect(() => load({ ...raw, PROVIDER_MODE_DEFAULT: 'sandbox' })).not.toThrow();
          }
        }
      });

      it('passes the secrets through ECS secrets, never as plain environment', () => {
        for (const k of SECRET_KEYS) {
          expect(secrets).toContain(k);
          expect(env).not.toContain(k);
        }
      });

      it('names the environment in APP_ENV and verifies the database certificate against the vendored RDS bundle', () => {
        expect(env).toContain('APP_ENV');
        const url = /DATABASE_URL\s*=\s*(?:local\.database_url|"([^"]+)")/.exec(block(hcl, 'common_env'));
        const databaseUrl = /database_url\s*=\s*"([^"]+)"/.exec(hcl)?.[1] ?? url?.[1] ?? '';
        expect(databaseUrl).toContain('sslmode=verify-full');
        const cert = /sslrootcert=([^&"]+)/.exec(databaseUrl)?.[1] ?? '';
        expect(cert.startsWith('/app/')).toBe(true); // the image's WORKDIR is the repository root
        expect(fs.existsSync(path.join(ROOT, cert.replace(/^\/app\//, '')))).toBe(true);
      });

      it('health-checks the API on the route it serves', () => {
        expect(hcl).toMatch(/health_check_path\s*=\s*"\/v1\/status"/);
      });
    });
  }
});

describe('node-postgres reads what Terraform passes (T-0025)', () => {
  it('takes the password from PGPASSWORD when DATABASE_URL carries none, and loads the CA from sslrootcert', () => {
    const before = process.env['PGPASSWORD'];
    process.env['PGPASSWORD'] = 'from-secrets-manager';
    try {
      const client = new pg.Client({ connectionString: `postgres://club_app@db.internal:5432/club?sslmode=verify-full&sslrootcert=${path.join(ROOT, 'db/certs/rds-global-bundle.pem')}` });
      const params = (client as unknown as { connectionParameters: { password: string; ssl: { ca?: string } } }).connectionParameters;
      expect(params.password).toBe('from-secrets-manager');
      expect(params.ssl.ca).toBe(read('db/certs/rds-global-bundle.pem'));
    } finally {
      if (before === undefined) delete process.env['PGPASSWORD'];
      else process.env['PGPASSWORD'] = before;
    }
  });
});
