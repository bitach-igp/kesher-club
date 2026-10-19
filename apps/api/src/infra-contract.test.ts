// T-0025: what the processes read and what Terraform passes them are one contract. The keys a
// process requires come from the config schemas themselves, the keys an environment passes from its
// Terraform, so adding a required key to the config without wiring it (or renaming it on one side
// only) fails here instead of at boot in AWS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { apiConfigSchema, workerConfigSchema } from './config.ts';

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
  { file: 'infra/preview/main.tf', deferred: [] as string[] },
  { file: 'infra/terraform/envs/staging/main.tf', deferred: ['MARKET'] },
  { file: 'infra/terraform/envs/prod/main.tf', deferred: ['MARKET'] },
];

describe('the process config and Terraform agree (T-0025)', () => {
  for (const { file, deferred } of ENVIRONMENTS) {
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
