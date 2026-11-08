import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources (exports point at src/index.ts). @kesher/demo and the
  // seeded passkeys in @kesher/ports load only in a local development build's persona picker.
  transpilePackages: ['@kesher/domain', '@kesher/ports', '@kesher/sdk', '@kesher/tokens', '@kesher/demo'],
  poweredByHeader: false,
  // The image runs the traced server alone (T-0047): `.next/standalone` holds server.js and only the
  // modules it reaches, traced from the repository root so the workspace packages are found.
  output: 'standalone',
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
};

export default nextConfig;
