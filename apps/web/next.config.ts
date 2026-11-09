import type { NextConfig } from 'next';
import { loadBuildConfig } from './src/site-config.ts';

// Fail the build, before anything renders, when the site is not configured (T-0048): a production build with a placeholder app id,
// support address or a missing Stripe file stops here, naming the keys.
loadBuildConfig(process.env);

const nextConfig: NextConfig = {
  // A static site: `next build` writes `out/`, which the deploy workflow syncs to the web bucket. No server, no middleware, no rewrites.
  output: 'export',
  // The tests build a fixture site into a scratch directory; the deploy always uses the default `out`.
  ...(process.env.WEB_DIST_DIR ? { distDir: process.env.WEB_DIST_DIR } : {}),
  poweredByHeader: false,
  transpilePackages: ['@kesher/tokens'],
  // `/legal/terms` is `legal/terms.html`; the deploy job also uploads it under the extensionless key (CloudFront has no rewrite).
  trailingSlash: false,
};

export default nextConfig;
