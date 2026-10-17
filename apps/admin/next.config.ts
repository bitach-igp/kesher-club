import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources (exports point at src/index.ts).
  transpilePackages: ['@kesher/domain', '@kesher/ports', '@kesher/tokens'],
  // The admin never serves anonymous traffic; the proxy enforces VPN + SSO (T-0116).
  poweredByHeader: false,
};

export default nextConfig;
