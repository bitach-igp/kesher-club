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
import { apiConfigSchema, loadApiConfig, loadWorkerConfig, PROVIDER_PORTS, workerConfigSchema } from './config.ts';

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

describe('marketplace and identity providers are opt-in in Terraform (T-0042)', () => {
  for (const file of ['infra/terraform/envs/staging/main.tf', 'infra/terraform/envs/prod/main.tf']) {
    it(`${file}: PROVIDER_* default to sim, and each adapter's whole credential set is a Secrets Manager container mapped for it`, () => {
      const hcl = read(file);
      const env = keys(block(hcl, 'common_env'));
      // `names = [ … ]` is a list, not a block: read it directly.
      const names = new Set([...(/names\s*=\s*\[([\s\S]*?)\]/.exec(hcl.slice(hcl.indexOf('module "secrets"')))?.[1] ?? '').matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!));
      expect(names.size).toBeGreaterThan(10);
      for (const [capability, port] of Object.entries(PROVIDER_PORTS)) {
        if (capability === 'institution-banking') continue; // Crowded is wired by its own card
        expect(env, port.env).toContain(port.env);
        const variable = port.env.toLowerCase();
        expect(hcl, port.env).toMatch(new RegExp(`${port.env}\\s*=\\s*var\\.${variable}\\b`));
        expect(hcl, variable).toMatch(new RegExp(`variable "${variable}" \\{[\\s\\S]*?default\\s*=\\s*"sim"`));
        for (const [adapter, adapterKeys] of Object.entries(port.adapters)) {
          const mapped = block(hcl, 'adapter_secrets').slice(block(hcl, 'adapter_secrets').search(new RegExp(`^\\s*"?${adapter}"?\\s*=\\s*tomap`, 'm')));
          for (const k of adapterKeys) {
            const container = k.toLowerCase().replace(/_/g, '-');
            expect(mapped, k).toMatch(new RegExp(`${k}\\s*=\\s*module\\.secrets\\.arns\\["${container}"\\]`));
            expect(names.has(container), `${container} container`).toBe(true);
          }
        }
      }
    });

    it(`${file}: a sim choice passes the config, and the API, worker and jit services all receive the chosen sets`, () => {
      const hcl = read(file);
      const raw = { ...VALID, APP_ENV: 'staging', PROVIDER_MODE_DEFAULT: 'sandbox', PROVIDER_ESIM: 'sim', PROVIDER_INSURANCE: 'sim', PROVIDER_ORG_IDP: 'sim', PROVIDER_FEDERATED_IDP: 'sim' } as Record<string, string>;
      for (const load of [loadApiConfig, loadWorkerConfig]) expect(() => load(raw)).not.toThrow();
      expect(hcl).toMatch(/jit_secrets\s*=\s*merge\([^)]*local\.provider_secrets\)/);
      for (const module of ['api', 'worker']) {
        const body = hcl.slice(hcl.indexOf(`module "${module}" {`), hcl.indexOf('\nmodule "', hcl.indexOf(`module "${module}" {`) + 10));
        expect(body, `module ${module}`).toMatch(/secrets\s*=\s*merge\([^\n]*local\.provider_secrets\)/);
      }
    });
  }
});

describe('the service roles Terraform passes are ones the processes know (T-0063)', () => {
  for (const file of ['infra/terraform/envs/staging/main.tf', 'infra/terraform/envs/prod/main.tf']) {
    it(`${file}: api and jit services get a role the API config accepts, the worker gets worker`, () => {
      const hcl = read(file);
      const roles = [...hcl.matchAll(/module "(api|jit|worker)" \{[\s\S]*?SERVICE_ROLE\s*=\s*"([a-z]+)"/g)].map((m) => [m[1]!, m[2]!] as const);
      expect(roles.map(([module]) => module).sort()).toEqual(['api', 'jit', 'worker']);
      // The load balancer health-checks both on the status route; the module's default /healthz is the console's and the API serves none.
      for (const module of ['api', 'jit']) {
        const block = hcl.slice(hcl.indexOf(`module "${module}" {`), hcl.indexOf('module "', hcl.indexOf(`module "${module}" {`) + 10));
        expect(block, `module ${module}`).toMatch(/health_check_path\s*=\s*"\/v1\/status"/);
      }
      for (const [module, role] of roles) {
        expect(role, `module ${module}`).toBe(module);
        if (module !== 'worker') expect(() => loadApiConfig({ ...VALID, APP_ENV: 'staging', PROVIDER_MODE_DEFAULT: 'sim', SERVICE_ROLE: role } as Record<string, string>)).not.toThrow();
      }
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

describe('the authorisation service connects as club_jit with its own password (T-0045)', () => {
  for (const file of ['infra/terraform/envs/staging/main.tf', 'infra/terraform/envs/prod/main.tf']) {
    it(`${file}: module jit carries the club_jit URL and db-jit-password, and no other service does`, () => {
      const hcl = read(file);
      const block = (name: string) => hcl.slice(hcl.indexOf(`module "${name}" {`), hcl.indexOf('\nmodule "', hcl.indexOf(`module "${name}" {`) + 10));
      expect(hcl).toMatch(/jit_database_url\s*=\s*"postgres:\/\/club_jit@/);
      expect(hcl).toMatch(/jit_secrets\s*=\s*merge\(local\.common_secrets,\s*\{\s*PGPASSWORD\s*=\s*module\.secrets\.arns\["db-jit-password"\]/);
      const jit = block('jit');
      expect(jit).toMatch(/DATABASE_URL\s*=\s*local\.jit_database_url/);
      expect(jit).toMatch(/secrets\s*=\s*local\.jit_secrets/);
      expect(jit).not.toMatch(/club_app|db-app-password|common_secrets/);
      for (const other of ['api', 'worker']) {
        expect(block(other), `module ${other}`).not.toMatch(/jit_database_url|jit_secrets|db-jit-password/);
      }
      // The URL carries no password: it comes from PGPASSWORD, as for the other roles.
      expect(hcl).not.toMatch(/postgres:\/\/club_jit:/);
    });
  }
});
