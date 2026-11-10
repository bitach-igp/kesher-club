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

    it(`${file}: a sim choice passes the config, the API and worker receive the chosen sets and jit receives none`, () => {
      const hcl = read(file);
      const raw = { ...VALID, APP_ENV: 'staging', PROVIDER_MODE_DEFAULT: 'sandbox', PROVIDER_ESIM: 'sim', PROVIDER_INSURANCE: 'sim', PROVIDER_ORG_IDP: 'sim', PROVIDER_FEDERATED_IDP: 'sim' } as Record<string, string>;
      for (const load of [loadApiConfig, loadWorkerConfig]) expect(() => load(raw)).not.toThrow();
      // The authorisation service (jit) is mapped none of the adapter secrets and runs all four ports on sim, so it boots without them.
      expect(hcl).not.toMatch(/jit_secrets\s*=[^\n]*provider_secrets/);
      const jit = hcl.slice(hcl.indexOf('module "jit" {'), hcl.indexOf('\nmodule "', hcl.indexOf('module "jit" {') + 10));
      expect(jit).not.toMatch(/provider_secrets|adapter_secrets/);
      for (const port of ['PROVIDER_ESIM', 'PROVIDER_INSURANCE', 'PROVIDER_ORG_IDP', 'PROVIDER_FEDERATED_IDP']) expect(jit, port).toMatch(new RegExp(`${port}\\s*=\\s*"sim"`));
      expect(() => loadApiConfig({ ...raw, SERVICE_ROLE: 'jit' })).not.toThrow();
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

// T-0068: the console's roster import (900 KB) crosses the public ALB, whose WAF blocks bodies over 8 KB (SizeRestrictions_BODY).
// Without a terraform binary this is the proof; infra/terraform/tests/alb.tftest.hcl asserts the planned rules where one exists.
describe('the WAF lets one route past the body-size rule and no other (T-0068)', () => {
  const alb = read('infra/terraform/modules/alb/main.tf');
  const vars = read('infra/terraform/modules/alb/variables.tf');
  const rule = (name: string) => {
    const at = alb.indexOf(`name     = "${name}"`);
    expect(at, name).toBeGreaterThan(-1);
    const start = alb.lastIndexOf('dynamic "rule"', at);
    const next = alb.indexOf('\n  dynamic "rule"', at);
    return alb.slice(start, next < 0 ? undefined : next);
  };

  it('keeps the managed rule group, and the rule is relaxed by an override of that one rule, never by removing the group', () => {
    expect(vars).toMatch(/default\s*=\s*\[\s*"AWSManagedRulesCommonRuleSet"/);
    expect(alb).toMatch(/managed_rule_group_statement\s*\{/);
    expect(alb).not.toMatch(/excluded_rule|scope_down_statement/);
    expect([...alb.matchAll(/rule_action_override\s*"?\s*\{/g)]).toHaveLength(1);
    expect([...alb.matchAll(/\bname\s*=\s*"SizeRestrictions_BODY"/g)]).toHaveLength(1);
    const override = alb.slice(alb.indexOf('dynamic "rule_action_override"'), alb.indexOf('dynamic "rule_action_override"') + 400);
    expect(override).toMatch(/action_to_use\s*\{\s*count\s*\{\}/);
    expect(override).not.toMatch(/allow\s*\{/);
    // Only the common rule set, and only when a route is named.
    expect(override).toMatch(/rule\.key == "AWSManagedRulesCommonRuleSet" && var\.large_body_route != null/);
    // The override never turns the group's own action off.
    expect(alb).toMatch(/override_action\s*\{\s*none\s*\{\}/);
  });

  it('blocks the labelled request when the host, the path or the method is not the exempt one, after the managed groups', () => {
    const parts = {
      host: { leaf: /byte_match_statement[\s\S]*search_string\s*=\s*lower\(rule\.value\.host\)[\s\S]*single_header\s*\{\s*name\s*=\s*"host"[\s\S]*type\s*=\s*"LOWERCASE"/, priority: 50 },
      path: { leaf: /regex_match_statement[\s\S]*regex_string\s*=\s*rule\.value\.path_regex[\s\S]*uri_path\s*\{\}/, priority: 51 },
      method: { leaf: /byte_match_statement[\s\S]*search_string\s*=\s*rule\.value\.method[\s\S]*method\s*\{\}/, priority: 52 },
    };
    for (const [n, { leaf, priority }] of Object.entries(parts)) {
      const r = rule(`body-size-outside-exempt-${n}`);
      expect(r, n).toMatch(/block\s*\{\}/);
      expect(r, n).toMatch(/key\s*=\s*"awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"/);
      // The provider allows three statement levels: and -> not -> one leaf, never deeper.
      expect(r, n).toMatch(/and_statement[\s\S]*label_match_statement[\s\S]*not_statement/);
      expect([...r.matchAll(/and_statement\s*\{/g)], n).toHaveLength(1);
      expect([...r.matchAll(/not_statement\s*\{/g)], n).toHaveLength(1);
      expect([...r.matchAll(/or_statement\s*\{/g)], n).toHaveLength(0);
      expect(r, n).toMatch(leaf);
      expect(Number(/priority\s*=\s*(\d+)/.exec(r)?.[1]), n).toBe(priority);
      expect(priority).toBeGreaterThan(10 + 3); // the managed groups take 10 + index (three by default)
      expect(r, n).toMatch(/for_each\s*=\s*var\.large_body_route == null \? \[\] : \[var\.large_body_route\]/);
    }
    expect([...alb.matchAll(/^\s*name\s*=\s*"body-size-outside-exempt-/gm)]).toHaveLength(3);
  });

  it('is a module variable that defaults to no exemption, and the method defaults to POST', () => {
    const v = vars.slice(vars.indexOf('variable "large_body_route"'), vars.indexOf('variable "rate_limit_per_5_minutes"'));
    expect(v).toMatch(/default\s*=\s*null/);
    expect(v).toMatch(/method\s*=\s*optional\(string,\s*"POST"\)/);
  });

  for (const file of ['infra/terraform/envs/staging/main.tf', 'infra/terraform/envs/prod/main.tf']) {
    it(`${file}: only the public ALB exempts the roster import, on the IL API host the console calls`, () => {
      const hcl = read(file);
      const alb = hcl.slice(hcl.indexOf('module "alb" {'), hcl.indexOf('module "admin_alb" {'));
      const admin = hcl.slice(hcl.indexOf('module "admin_alb" {'), hcl.indexOf('# T-0069: the console-to-API hop'));
      const route = /large_body_route\s*=\s*\{([^}]*)\}/.exec(alb)?.[1] ?? '';
      expect(route).toMatch(/host\s*=\s*local\.market_hosts\["il"\]\.api/);
      expect(route).toMatch(/path_regex\s*=\s*"\^\/v1\/institutions\/\[0-9a-f-\]\+\/rosters\$"/);
      expect(route).not.toMatch(/method/);
      expect(admin).not.toMatch(/large_body_route/);
      // The one other exemption is the internal ALB's (T-0069), on the internal host the console calls.
      expect(hcl.match(/large_body_route\s*=/g)).toHaveLength(2);
      // The path is the one the console posts to: the OpenAPI operation importRoster.
      expect(read('contracts/openapi.yaml')).toMatch(/\/institutions\/\{id\}\/rosters:\s+post:\s+operationId: importRoster/);
      expect(read('apps/console/src/api.ts')).toMatch(/c\.post\('\/institutions\/\{id\}\/rosters'/);
    });
  }
});

// T-0069: the console reaches the IL API through an internal ALB, not the NAT gateway and the public ALB, and the API's client-address rule
// (apps/api/src/institutions/us-banking.ts, tested in us-banking.test.ts) skips the one private hop that ALB appends.
describe('the console calls the API over the internal ALB (T-0069)', () => {
  for (const file of ['infra/terraform/envs/staging/main.tf', 'infra/terraform/envs/prod/main.tf']) {
    it(`${file}: CONSOLE_API_URL is the internal host, on an internal ALB that forwards only that host to the IL API`, () => {
      const hcl = read(file);
      const slice = (start: string, end: string) => hcl.slice(hcl.indexOf(start), hcl.indexOf(end, hcl.indexOf(start) + 10));
      expect(hcl).toMatch(/internal_api_host\s*=\s*"api-il-internal\.\$\{var\.domain\}"/);
      // The host is covered by the wildcard certificate (one label under the domain) and is not the public IL host.
      expect(hcl).toMatch(/subject_alternative_names\s*=\s*\["\*\.\$\{var\.domain\}"\]/);
      expect(hcl).not.toMatch(/internal_api_host\s*=\s*local\.market_hosts/);
      expect(slice('module "console" {', '\nresource "aws_vpc_security_group_ingress_rule" "db_from_services"')).toMatch(/CONSOLE_API_URL\s*=\s*"https:\/\/\$\{local\.internal_api_host\}\/v1"/);
      expect(hcl).not.toMatch(/CONSOLE_API_URL\s*=\s*"https:\/\/\$\{local\.market_hosts/);
      const alb = slice('module "internal_alb" {', '\nmodule "api" {');
      expect(alb).toMatch(/internal\s*=\s*true/);
      expect(alb).toMatch(/subnet_ids\s*=\s*module\.network\.private_subnet_ids/);
      expect(alb).toMatch(/host\s*=\s*local\.internal_api_host/);
      // The trust boundary: only the console's task security group may connect, never the VPC CIDR (Client VPN users are inside it and could forge x-forwarded-for).
      expect(alb).toMatch(/allowed_security_group_ids\s*=\s*\[module\.console\.security_group_id\]/);
      expect(alb).not.toMatch(/vpc_cidr\s*=\s*"|0\.0\.0\.0\/0/);
      const rule = slice('resource "aws_lb_listener_rule" "api_internal" {', '\nresource "aws_vpc_security_group_ingress_rule" "api_il_from_internal_alb"');
      expect(rule).toMatch(/listener_arn\s*=\s*module\.internal_alb\.https_listener_arn/);
      expect(rule).toMatch(/target_group_arn\s*=\s*module\.api\["il"\]\.target_group_arn/);
      expect(rule).toMatch(/values\s*=\s*\[local\.internal_api_host\]/);
      const sg = slice('resource "aws_vpc_security_group_ingress_rule" "api_il_from_internal_alb" {', '\n}\n');
      expect(sg).toMatch(/referenced_security_group_id\s*=\s*module\.internal_alb\.security_group_id/);
      expect(sg).toMatch(/security_group_id\s*=\s*module\.api\["il"\]\.security_group_id/);
      // The record resolves the host to the internal ALB only.
      expect(slice('resource "aws_route53_record" "api_internal" {', '\n}\n')).toMatch(/name\s*=\s*module\.internal_alb\.dns_name/);
      // The public ALB still has no rule for the internal host: a request carrying that Host header from the internet gets the 404 default.
      expect(hcl.match(/host_headers\s*=\s*\[local\.internal_api_host\]/g) ?? []).toHaveLength(0);
    });
  }

  it('the module admits only the named security groups when given, and the VPC CIDR only when none is named', () => {
    const alb = read('infra/terraform/modules/alb/main.tf');
    const vars = read('infra/terraform/modules/alb/variables.tf');
    expect(vars).toMatch(/variable "allowed_security_group_ids"[\s\S]*?default\s*=\s*\[\]/);
    expect(alb).toMatch(/"https_internal"[\s\S]*?count\s*=\s*var\.internal && length\(var\.allowed_security_group_ids\) == 0 \? 1 : 0/);
    expect(alb).toMatch(/"https_from_security_group"[\s\S]*?count\s*=\s*var\.internal \? length\(var\.allowed_security_group_ids\) : 0[\s\S]*?referenced_security_group_id\s*=\s*var\.allowed_security_group_ids\[count\.index\]/);
    expect(alb).not.toMatch(/for_each\s*=\s*var\.internal \? toset\(var\.allowed/); // an unknown id (a service in the same apply) would fail a for_each at plan
    expect(alb).not.toMatch(/description\s*=\s*"[^"]*Client VPN/);
  });

  it('the module ALB is internal-only when asked: no 0.0.0.0/0 ingress, the VPC CIDR instead', () => {
    const alb = read('infra/terraform/modules/alb/main.tf');
    expect(alb).toMatch(/https_public[\s\S]*count\s*=\s*var\.internal \? 0 : 1/);
    expect(alb).toMatch(/https_internal[\s\S]*count\s*=\s*var\.internal && length\(var\.allowed_security_group_ids\) == 0 \? 1 : 0/);
  });
});
