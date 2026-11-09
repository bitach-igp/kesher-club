// Build-time configuration of the static site (T-0048, constitution art. 6: missing configuration crashes, no fallbacks). Read once at
// the start of `next build` (next.config.ts) and by the pages while they render. There is no server and nothing is read at runtime.
//
//   WEB_ENV                       local | staging | production. Required. Outside `local` the site must carry real app ids and a real
//                                 support address, and LEGAL_API_URL must be https and not a loopback host.
//   LEGAL_API_URL                 The API base WITH /v1; the build fetches `${LEGAL_API_URL}/legal/documents`. Required.
//   STRIPE_APPLE_PAY_DOMAIN_FILE  Path of the file Stripe issued for this domain (Apple Pay domain verification). Required in production,
//                                 optional elsewhere; when set the file is published at /.well-known/apple-developer-merchantid-domain-association.
import { readFileSync } from 'node:fs';
import { APP_IDS, appIdProblems, type AppIds } from './app-ids.ts';

/**
 * The address members write to. A PLACEHOLDER on purpose: no address has been chosen, and an invented one could reach a stranger. The
 * production build refuses it. `.invalid` is reserved (RFC 2606) and never resolves.
 */
export const SUPPORT_EMAIL = 'support@PLACEHOLDER-set-in-src-site-config.invalid';

const EMAIL = /^[^\s@<>"',;]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export type WebEnv = 'local' | 'staging' | 'production';

export interface BuildConfig {
  webEnv: WebEnv;
  legalApiUrl: string;
  /** Contents of Stripe's verification file, when configured. */
  stripeApplePayFile: string | undefined;
}

export class SiteConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`The web build is not configured: ${problems.join('; ')}`);
    this.name = 'SiteConfigError';
    this.problems = problems;
  }
}

const isLoopback = (host: string) => host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);

export interface ConfigSources {
  appIds: AppIds;
  supportEmail: string;
}

/**
 * Every problem at once (so a person fixes them in one pass). Messages name keys, never values. `sources` is for tests; the build uses
 * the real constants.
 */
export function loadBuildConfig(env: Record<string, string | undefined>, sources: ConfigSources = { appIds: APP_IDS, supportEmail: SUPPORT_EMAIL }): BuildConfig {
  const problems: string[] = [];

  const rawEnv = env.WEB_ENV;
  let webEnv: WebEnv = 'local';
  if (rawEnv === 'local' || rawEnv === 'staging' || rawEnv === 'production') webEnv = rawEnv;
  else problems.push('WEB_ENV must be local, staging or production');

  const legalApiUrl = (env.LEGAL_API_URL ?? '').trim();
  if (legalApiUrl === '') problems.push('LEGAL_API_URL is required');
  else {
    try {
      const url = new URL(legalApiUrl);
      if (url.protocol !== 'https:' && !(webEnv === 'local' && url.protocol === 'http:')) problems.push('LEGAL_API_URL must be https');
      else if (webEnv !== 'local' && isLoopback(url.hostname)) problems.push('LEGAL_API_URL must not be a loopback host outside WEB_ENV=local');
    } catch {
      problems.push('LEGAL_API_URL is not a URL');
    }
  }

  const stripePath = (env.STRIPE_APPLE_PAY_DOMAIN_FILE ?? '').trim();
  let stripeApplePayFile: string | undefined;
  if (stripePath === '') {
    if (webEnv === 'production') problems.push('STRIPE_APPLE_PAY_DOMAIN_FILE is required in production (the file Stripe issued for this domain)');
  } else {
    try {
      stripeApplePayFile = readFileSync(stripePath, 'utf8');
      if (stripeApplePayFile.trim() === '') problems.push('STRIPE_APPLE_PAY_DOMAIN_FILE names an empty file');
    } catch {
      problems.push('STRIPE_APPLE_PAY_DOMAIN_FILE cannot be read');
    }
  }

  if (webEnv !== 'local') {
    for (const field of appIdProblems(sources.appIds)) problems.push(`app id ${field} in src/app-ids.ts is still a placeholder or malformed (T-0058 sets it)`);
    if (sources.supportEmail.includes('PLACEHOLDER') || !EMAIL.test(sources.supportEmail)) problems.push('SUPPORT_EMAIL in src/site-config.ts is still a placeholder or malformed');
  }

  if (problems.length > 0) throw new SiteConfigError(problems);
  return { webEnv, legalApiUrl, stripeApplePayFile };
}
