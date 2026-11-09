// The local stack the screenshots are taken against (T-0073): the T-0031 process on an in-memory database,
// seeded by T-0032 and T-0034 (apps/demo/src/record/stack.ts, the same entry the T-0920 recordings use), the
// member app's web build (T-0033), the admin console and the institution console. Development only: every key is
// made here for this run, held in memory and passed through the environment, never written down or printed.
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT } from './lib.mjs';

export const PORTS = { api: 3000, panel: 4010, member: 8081, console: 3100, institution: 3200, ready: 4099 };
export const URLS = {
  api: `http://localhost:${PORTS.api}/v1`,
  panel: `http://localhost:${PORTS.panel}`,
  member: `http://localhost:${PORTS.member}`,
  admin: `http://localhost:${PORTS.console}`,
  institution: `http://localhost:${PORTS.institution}`,
  ready: `http://127.0.0.1:${PORTS.ready}`,
};
const KID = 'screenshots-staff-1';

/** A fresh staff key pair for this run: the API trusts the public half, the console and the seed sign with the private half. */
function staffKeys() {
  const priv = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  const pub = Object.fromEntries(Object.entries(priv).filter(([k]) => k !== 'd'));
  return {
    STAFF_JWKS: JSON.stringify({ keys: [{ ...pub, kid: KID, alg: 'ES256', use: 'sig' }] }),
    ADMIN_API_SIGNING_KEY: JSON.stringify(priv),
    ADMIN_API_SIGNING_KID: KID,
  };
}

async function waitFor(url, timeoutMs, label, alive) {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    if (!alive()) throw new Error(`${label} exited before it answered`);
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000);
  }
  throw new Error(`${label} did not answer ${url} within ${timeoutMs / 1000} s (${last})`);
}

/** Starts the four servers, waits for each, and returns `stop()`. Ports 3000, 3100, 3200, 4010, 4099 and 8081 must be free. */
export async function startStack({ logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesher-screenshots-')) } = {}) {
  const staff = staffKeys();
  const children = [];
  const start = (name, command, args, cwd, env) => {
    const out = fs.openSync(path.join(logDir, `${name}.log`), 'w');
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], detached: true });
    const entry = { name, child, alive: true };
    child.on('exit', () => (entry.alive = false));
    children.push(entry);
    return entry;
  };
  const stop = async () => {
    for (const { child, alive } of children) if (alive) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await sleep(1500);
    for (const { child, alive } of children) if (alive) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  };
  try {
    const demo = path.join(ROOT, 'apps/demo');
    const api = start('stack', process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'src/record/stack.ts'], demo, {
      APP_ENV: 'development', MARKET: 'US', PORT: String(PORTS.api), SIMULATOR_PORT: String(PORTS.panel),
      DEMO_WEB_ORIGINS: URLS.member, RECORD_READY_PORT: String(PORTS.ready), ...staff,
    });
    const member = start('member', process.execPath, ['node_modules/expo/bin/cli', 'start', '--web', '--port', String(PORTS.member)], path.join(ROOT, 'apps/mobile'), {
      CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_API_URL: `http://localhost:${PORTS.api}`, EXPO_PUBLIC_APP_ENV: 'development',
    });
    const admin = start('admin', 'pnpm', ['exec', 'next', 'dev', '-p', String(PORTS.console)], path.join(ROOT, 'apps/admin'), {
      NODE_ENV: 'development', ADMIN_ENVIRONMENT: 'local', ADMIN_BASE_URL: URLS.admin, ADMIN_VPN_CIDRS: '127.0.0.0/8,::1/128',
      ADMIN_OIDC_ISSUER: `${URLS.panel}/oidc`, ADMIN_OIDC_JWKS_URL: `${URLS.panel}/oidc/jwks`,
      ADMIN_OIDC_CLIENT_ID: 'kesher-admin-local', ADMIN_OIDC_AUDIENCE: 'kesher-admin-local', ADMIN_OIDC_CLIENT_SECRET: 'local-simulator-client',
      ADMIN_DATA: 'api', ADMIN_API_URL_IL: URLS.api, ADMIN_API_URL_US: URLS.api, ADMIN_API_SIGNING_KID: KID,
      ADMIN_API_SIGNING_KEY: staff.ADMIN_API_SIGNING_KEY, ADMIN_CLOCK_URL: `${URLS.panel}/health`,
    });
    const institution = start('institution', 'pnpm', ['exec', 'next', 'dev', '-p', String(PORTS.institution)], path.join(ROOT, 'apps/console'), {
      NODE_ENV: 'development', CONSOLE_ENVIRONMENT: 'local', CONSOLE_API_URL: URLS.api,
    });
    await Promise.all([
      waitFor(URLS.ready, 240_000, 'the demo stack (seeding)', () => api.alive),
      waitFor(URLS.member, 300_000, 'the member app', () => member.alive),
      waitFor(`${URLS.admin}/healthz`, 240_000, 'the admin console', () => admin.alive),
      waitFor(`${URLS.institution}/sign-in`, 240_000, 'the institution console', () => institution.alive),
    ]);
  } catch (e) {
    await stop();
    throw new Error(`${e instanceof Error ? e.message : e}; logs are in ${logDir}`, { cause: e });
  }
  return { stop, logDir, staff: { jwk: JSON.parse(staff.ADMIN_API_SIGNING_KEY), kid: KID } };
}

// `node tools/screenshots/stack.mjs` starts the stack and leaves it up (for trying a flow by hand); Ctrl-C stops it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const stack = await startStack();
  // The run's own throwaway staff key, for `record.mjs --attach <logDir>` (mode 600, in the run's temp directory).
  fs.writeFileSync(path.join(stack.logDir, 'staff.json'), JSON.stringify(stack.staff), { mode: 0o600 });
  process.stdout.write(`stack up; logs in ${stack.logDir}\n`);
  process.on('SIGINT', () => void stack.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => void stack.stop().then(() => process.exit(0)));
  await new Promise(() => undefined);
}
