import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources (exports point at src/index.ts).
  transpilePackages: ['@kesher/domain', '@kesher/ports', '@kesher/tokens'],
  // The admin never serves anonymous traffic; the proxy enforces VPN + SSO (T-0116).
  poweredByHeader: false,
  // The image runs the traced server alone (T-0917): `.next/standalone` holds server.js and only the
  // modules it reaches, traced from the repository root so the workspace packages are found.
  output: 'standalone',
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
};

export default nextConfig;
