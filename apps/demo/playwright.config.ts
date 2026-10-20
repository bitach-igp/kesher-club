// The recording harness (T-0920): Playwright starts the demo stack (src/record/stack.ts), the member app's
// web build (T-0033) and the admin console against the simulator identity provider (T-0919), then records
// each flow's harness page. A staff key pair is made here, per run: the API trusts its public half, and the
// console and the stack's seed sign with the private half. Nothing here is a production key or setting.
//
//   pnpm --filter @kesher/demo record --grep "REC-0[1-5]"
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const KID = 'record-staff-1';
// One pair per run. The runner makes it; its workers inherit it through the environment, so a worker
// that evaluates this file again signs with the key the stack and the console trust.
process.env['RECORD_STAFF_KEY'] ??= JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }));
const { d: _private, ...publicJwk } = JSON.parse(process.env['RECORD_STAFF_KEY']) as Record<string, string>;
const staff = {
  STAFF_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: 'ES256', use: 'sig' }] }),
  ADMIN_API_SIGNING_KEY: process.env['RECORD_STAFF_KEY'],
  ADMIN_API_SIGNING_KID: KID,
};
process.env['RECORD_STAFF_KID'] = KID;

export const PORTS = { api: 3000, panel: 4010, member: 8081, console: 3100, ready: 4099 } as const;

export default defineConfig({
  testDir: 'src/record',
  testMatch: /rec-.*\.spec\.ts$/,
  outputDir: 'out/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: [['list']],
  use: { viewport: { width: 1600, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Jerusalem' },
  webServer: [
    {
      command: 'node --experimental-strip-types --disable-warning=ExperimentalWarning src/record/stack.ts',
      cwd: here,
      url: `http://127.0.0.1:${PORTS.ready}`,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: { APP_ENV: 'development', MARKET: 'US', PORT: String(PORTS.api), SIMULATOR_PORT: String(PORTS.panel), DEMO_WEB_ORIGINS: `http://localhost:${PORTS.member}`, RECORD_READY_PORT: String(PORTS.ready), ...staff },
    },
    {
      command: `node node_modules/expo/bin/cli start --web --port ${PORTS.member}`,
      cwd: path.resolve(here, '../mobile'),
      url: `http://localhost:${PORTS.member}`,
      timeout: 300_000,
      reuseExistingServer: false,
      env: { CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_API_URL: `http://localhost:${PORTS.api}`, EXPO_PUBLIC_APP_ENV: 'development' },
    },
    {
      command: `pnpm exec next dev -p ${PORTS.console}`,
      cwd: path.resolve(here, '../admin'),
      url: `http://localhost:${PORTS.console}/healthz`,
      timeout: 240_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'development',
        ADMIN_ENVIRONMENT: 'local',
        ADMIN_BASE_URL: `http://localhost:${PORTS.console}`,
        ADMIN_VPN_CIDRS: '127.0.0.0/8,::1/128',
        ADMIN_OIDC_ISSUER: `http://localhost:${PORTS.panel}/oidc`,
        ADMIN_OIDC_JWKS_URL: `http://localhost:${PORTS.panel}/oidc/jwks`,
        ADMIN_OIDC_CLIENT_ID: 'kesher-admin-local',
        ADMIN_OIDC_AUDIENCE: 'kesher-admin-local',
        ADMIN_OIDC_CLIENT_SECRET: 'local-simulator-client',
        ADMIN_DATA: 'api',
        ADMIN_API_URL_IL: `http://localhost:${PORTS.api}/v1`,
        ADMIN_API_URL_US: `http://localhost:${PORTS.api}/v1`,
        ADMIN_API_SIGNING_KID: KID,
        ADMIN_API_SIGNING_KEY: staff.ADMIN_API_SIGNING_KEY,
      },
    },
  ],
});
