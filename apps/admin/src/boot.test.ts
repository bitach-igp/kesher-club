// T-0918: an unconfigured or misconfigured console stops at boot like the API and the worker. It writes one
// JSON boot_failed line naming the keys, never their values, and exits 1. It no longer answers 500 with
// an empty log.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootCheck } from './boot.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('boot check (T-0918)', () => {
  it('a bad or missing setting writes one boot_failed line with key names only, then exits 1', () => {
    vi.stubEnv('ADMIN_VPN_CIDRS', 'vpn-range-typo');
    vi.stubEnv('ADMIN_OIDC_CLIENT_SECRET', 'do-not-print-me');
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    bootCheck();
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, string>;
    expect(line).toMatchObject({ service: 'admin', event: 'boot_failed', error: 'ConfigError' });
    expect(line['message']).toMatch(/ADMIN_ENVIRONMENT/);
    expect(line['message']).toMatch(/ADMIN_VPN_CIDRS: entry 1 is not a CIDR/);
    expect(lines[0]).not.toContain('vpn-range-typo');
    expect(lines[0]).not.toContain('do-not-print-me');
  });
});

// T-0919: the simulator identity provider is allowed for a local console only, and only on this machine.
describe('identity provider location (T-0919)', () => {
  const local = {
    NODE_ENV: 'development',
    ADMIN_ENVIRONMENT: 'local',
    ADMIN_BASE_URL: 'http://localhost:3100',
    ADMIN_VPN_CIDRS: '127.0.0.0/8',
    ADMIN_OIDC_ISSUER: 'http://localhost:4010/oidc',
    ADMIN_OIDC_AUDIENCE: 'kesher-admin-local',
    ADMIN_OIDC_CLIENT_ID: 'kesher-admin-local',
    ADMIN_OIDC_CLIENT_SECRET: 'local-simulator-client',
    ADMIN_OIDC_JWKS_URL: 'http://localhost:4010/oidc/jwks',
    ADMIN_DATA: 'memory',
  };

  /** A fresh process: the config is read once per module, so each case gets its own. */
  async function boot(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    (await import('./boot.ts')).bootCheck();
    return { exit, lines };
  }

  it('preview with the simulator issuer on localhost exits 1 naming ADMIN_OIDC_ISSUER', async () => {
    const { exit, lines } = await boot({ ...local, ADMIN_ENVIRONMENT: 'preview', NODE_ENV: 'preview' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: 'admin', event: 'boot_failed', error: 'ConfigError', message: expect.stringMatching(/ADMIN_OIDC_ISSUER: must be https and not a loopback host/) });
    expect(lines[0]).not.toContain('localhost:4010');
  });

  it('local with the same issuer boots', async () => {
    const { exit, lines } = await boot(local);
    expect(exit).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('local with plain http to another host exits 1: the simulator issuer cannot be pointed off the machine', async () => {
    const { exit, lines } = await boot({ ...local, ADMIN_OIDC_ISSUER: 'http://idp.example/oidc', ADMIN_OIDC_JWKS_URL: 'http://idp.example/oidc/jwks' });
    expect(exit).toHaveBeenCalledWith(1);
    const message = (JSON.parse(lines[0]!) as { message: string }).message;
    expect(message).toMatch(/ADMIN_OIDC_ISSUER: http is allowed only for localhost/);
    expect(message).toMatch(/ADMIN_OIDC_JWKS_URL: http is allowed only for localhost/);
    expect(message).not.toContain('idp.example');
  });
});
