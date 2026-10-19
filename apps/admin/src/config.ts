// Admin configuration (T-0116, constitution art. 6): read once through Zod, crash when missing.
// Never `process.env.X ?? 'default'`; the ESLint rule in the root config bans it as well.
import { ConfigError, loadConfig } from '@kesher/domain';
import { z } from 'zod';
import { parseCidr, type Cidr } from './auth/vpn.ts';

const cidrList = z
  .string()
  .min(1)
  .transform((raw, ctx): readonly Cidr[] => {
    const out: Cidr[] = [];
    for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const cidr = parseCidr(part);
      if (!cidr) ctx.addIssue({ code: 'custom', message: `not a CIDR: ${part}` });
      else out.push(cidr);
    }
    if (out.length === 0) ctx.addIssue({ code: 'custom', message: 'at least one CIDR is required' });
    return out;
  });

export const adminConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'preview', 'staging', 'production']),
  /** Drives the environment banner in the shell (staging vs prod). */
  ADMIN_ENVIRONMENT: z.enum(['local', 'preview', 'staging', 'production']),
  /** Public origin of this admin, used for the OIDC redirect_uri. */
  ADMIN_BASE_URL: z.string().url(),
  /** Comma-separated CIDRs of the Client VPN. Requests from outside get 403 (REQ-AUTH-009). */
  ADMIN_VPN_CIDRS: cidrList,
  ADMIN_OIDC_ISSUER: z.string().url(),
  ADMIN_OIDC_AUDIENCE: z.string().min(1),
  ADMIN_OIDC_CLIENT_ID: z.string().min(1),
  ADMIN_OIDC_CLIENT_SECRET: z.string().min(1),
  ADMIN_OIDC_JWKS_URL: z.string().url(),
  /** `api` talks to /admin/* (ADR-013); `memory` is the seeded store, allowed in local and preview only. */
  ADMIN_DATA: z.enum(['api', 'memory']),
  /** Each market's API, with its `/v1` prefix (T-0913). Club-wide data comes from IL; bindings from both. */
  ADMIN_API_URL_IL: z.string().url().optional(),
  ADMIN_API_URL_US: z.string().url().optional(),
  /** Private ES256 JWK (JSON) that signs 5-minute staff tokens; its public half is the API's staff JWKS. */
  ADMIN_API_SIGNING_KEY: z
    .string()
    .optional()
    .transform((raw, ctx): Record<string, unknown> | undefined => {
      if (raw === undefined) return undefined;
      try {
        const jwk = JSON.parse(raw) as Record<string, unknown>;
        if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256' || typeof jwk['d'] !== 'string') ctx.addIssue({ code: 'custom', message: 'must be a private P-256 JWK' });
        return jwk;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be JSON' });
        return undefined;
      }
    }),
  ADMIN_API_SIGNING_KID: z.string().min(1).optional(),
}).superRefine((c, ctx) => {
  if (c.ADMIN_DATA === 'memory' && c.ADMIN_ENVIRONMENT !== 'local' && c.ADMIN_ENVIRONMENT !== 'preview') ctx.addIssue({ code: 'custom', path: ['ADMIN_DATA'], message: 'memory data is allowed in local and preview only' });
  if (c.ADMIN_DATA === 'api') for (const k of ['ADMIN_API_URL_IL', 'ADMIN_API_URL_US', 'ADMIN_API_SIGNING_KEY', 'ADMIN_API_SIGNING_KID'] as const) if (c[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when ADMIN_DATA=api` });
});

type ParsedAdminConfig = z.infer<typeof adminConfigSchema>;
/** After the refinement, `api` mode carries its four settings. */
export type AdminConfig = (ParsedAdminConfig & { ADMIN_DATA: 'memory' }) | (ParsedAdminConfig & { ADMIN_DATA: 'api'; ADMIN_API_URL_IL: string; ADMIN_API_URL_US: string; ADMIN_API_SIGNING_KEY: Record<string, unknown>; ADMIN_API_SIGNING_KID: string });

/** The keys this app reads. Listed explicitly so the edge bundle inlines them. */
export const readAdminEnv = (): Record<string, string | undefined> => ({
  NODE_ENV: process.env.NODE_ENV,
  ADMIN_ENVIRONMENT: process.env.ADMIN_ENVIRONMENT,
  ADMIN_BASE_URL: process.env.ADMIN_BASE_URL,
  ADMIN_VPN_CIDRS: process.env.ADMIN_VPN_CIDRS,
  ADMIN_OIDC_ISSUER: process.env.ADMIN_OIDC_ISSUER,
  ADMIN_OIDC_AUDIENCE: process.env.ADMIN_OIDC_AUDIENCE,
  ADMIN_OIDC_CLIENT_ID: process.env.ADMIN_OIDC_CLIENT_ID,
  ADMIN_OIDC_CLIENT_SECRET: process.env.ADMIN_OIDC_CLIENT_SECRET,
  ADMIN_OIDC_JWKS_URL: process.env.ADMIN_OIDC_JWKS_URL,
  ADMIN_DATA: process.env.ADMIN_DATA,
  ADMIN_API_URL_IL: process.env.ADMIN_API_URL_IL,
  ADMIN_API_URL_US: process.env.ADMIN_API_URL_US,
  ADMIN_API_SIGNING_KEY: process.env.ADMIN_API_SIGNING_KEY,
  ADMIN_API_SIGNING_KID: process.env.ADMIN_API_SIGNING_KID,
});

/** Parses an env record. Throws ConfigError (listing every missing key) rather than defaulting. */
export const parseAdminConfig = (env: Record<string, string | undefined>): AdminConfig => loadConfig(adminConfigSchema, env) as AdminConfig;

let cached: AdminConfig | undefined;

/** Read once per process. The first caller (the proxy at boot) crashes the app when config is missing. */
export function getConfig(): AdminConfig {
  if (!cached) cached = parseAdminConfig(readAdminEnv());
  return cached;
}

export { ConfigError };
