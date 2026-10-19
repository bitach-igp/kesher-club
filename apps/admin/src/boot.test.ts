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
