// T-0914: what the console reads and what Terraform passes it are one contract, as T-0025 made them for
// the API and the worker. The keys come from the config schema and its `api`-mode list, the values from
// staging's and prod's `module "admin"`, so a key added on one side only fails here, not at boot in AWS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROXY_MATCHER } from './auth/proxy.ts';
import { adminConfigSchema, API_MODE_KEYS } from './config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Shape = Record<string, { safeParse(v: unknown): { success: boolean } }>;
const required = Object.entries((adminConfigSchema as unknown as { shape: Shape }).shape)
  .filter(([, field]) => !field.safeParse(undefined).success)
  .map(([key]) => key);

/** The body of the first `{ … }` after `head` in `hcl`, by brace matching. */
function bodyAfter(hcl: string, head: RegExp): string {
  const start = hcl.search(head);
  if (start < 0) throw new Error(`no ${String(head)}`);
  const open = hcl.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < hcl.length; i++) {
    if (hcl[i] === '{') depth++;
    if (hcl[i] === '}' && --depth === 0) return hcl.slice(open + 1, i);
  }
  throw new Error(`unclosed ${String(head)}`);
}
const entries = (body: string): Map<string, string> => new Map([...body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));

/** Read as secrets: they must arrive through ECS secrets, never as plain environment. */
const SECRET_KEYS = ['ADMIN_API_SIGNING_KEY', 'ADMIN_OIDC_CLIENT_SECRET'];

describe('the console config and Terraform agree (T-0914)', () => {
  for (const file of ['infra/terraform/envs/staging/main.tf', 'infra/terraform/envs/prod/main.tf']) {
    describe(file, () => {
      const admin = bodyAfter(fs.readFileSync(path.join(ROOT, file), 'utf8'), /^module "admin" \{/m);
      const env = entries(bodyAfter(admin, /^\s*environment\s*=\s*\{/m));
      const secrets = entries(bodyAfter(admin, /^\s*secrets\s*=\s*\{/m));

      it('passes every key the console requires in api mode', () => {
        const passed = new Set([...env.keys(), ...secrets.keys()]);
        expect([...required, ...API_MODE_KEYS].filter((k) => !passed.has(k))).toEqual([]);
      });

      it('passes the signing key and the OIDC client secret as ECS secrets only', () => {
        for (const k of SECRET_KEYS) {
          expect([...secrets.keys()]).toContain(k);
          expect([...env.keys()]).not.toContain(k);
        }
      });

      it('runs on the API, reaches each market under /v1, and gates on the VPN subnets', () => {
        expect(env.get('ADMIN_DATA')).toBe('"api"');
        expect(env.get('ADMIN_API_URL_IL')).toMatch(/il\.api\}\/v1"$/);
        expect(env.get('ADMIN_API_URL_US')).toMatch(/us\.api\}\/v1"$/);
        expect(env.get('ADMIN_VPN_CIDRS')).toBe('join(",", module.network.client_vpn_source_cidrs)');
      });

      it('health-checks a path the console serves and the proxy leaves to the load balancer (T-0917)', () => {
        const healthPath = /^\s*health_check_path\s*=\s*"([^"]+)"/m.exec(bodyAfter(admin, /^\s*ingress\s*=\s*\{/m))?.[1];
        expect(healthPath).toBe('/healthz');
        expect(fs.existsSync(path.join(ROOT, 'apps/admin/app/healthz/route.ts'))).toBe(true);
        // Next anchors each matcher to the whole path; a matched path goes through the VPN and SSO gate.
        expect(PROXY_MATCHER.some((m) => new RegExp(`^${m}$`).test(healthPath!))).toBe(false);
        expect(PROXY_MATCHER.some((m) => new RegExp(`^${m}$`).test('/api/healthz'))).toBe(true);
      });
    });
  }
});
