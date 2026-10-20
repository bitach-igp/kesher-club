import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources (exports point at src/index.ts). @kesher/demo and the
  // seeded passkeys in @kesher/ports load only in a local development build's persona picker.
  transpilePackages: ['@kesher/domain', '@kesher/ports', '@kesher/sdk', '@kesher/tokens', '@kesher/demo'],
  poweredByHeader: false,
};

export default nextConfig;
