// T-0047: the console is configured by two settings and stops at boot when either is missing or bad, as the
// admin does (T-0918). It writes one boot_failed line naming the keys, never their values, and exits 1.
// /healthz is the load balancer's check: 200 only when the config loads, and the proxy leaves it alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** A fresh process: the config is read once per module, so each case gets its own. */
async function boot(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const k of ['CONSOLE_ENVIRONMENT', 'CONSOLE_API_URL']) vi.stubEnv(k, env[k] as string);
  for (const k of ['CONSOLE_ENVIRONMENT', 'CONSOLE_API_URL']) if (env[k] === undefined) delete process.env[k];
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  (await import('./boot.ts')).bootCheck();
  return { exit, lines };
}

describe('boot check (T-0047)', () => {
  it('a missing setting exits 1 with one boot_failed line naming the key', async () => {
    const { exit, lines } = await boot({ CONSOLE_ENVIRONMENT: 'staging' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: 'console', event: 'boot_failed', error: 'ConfigError', message: expect.stringMatching(/CONSOLE_API_URL/) });
  });

  it('an unknown environment exits 1 naming CONSOLE_ENVIRONMENT, without printing its value', async () => {
    const { exit, lines } = await boot({ CONSOLE_ENVIRONMENT: 'qa-secret-name', CONSOLE_API_URL: 'https://api.example.com/v1' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'boot_failed', message: expect.stringMatching(/CONSOLE_ENVIRONMENT/) });
    expect(lines[0]).not.toContain('qa-secret-name');
  });

  it('staging with plain http or a loopback API exits 1 naming CONSOLE_API_URL', async () => {
    for (const url of ['http://api.example.com/v1', 'https://localhost:3000/v1', 'https://127.0.0.1/v1']) {
      const { exit, lines } = await boot({ CONSOLE_ENVIRONMENT: 'staging', CONSOLE_API_URL: url });
      expect(exit).toHaveBeenCalledWith(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ message: expect.stringMatching(/CONSOLE_API_URL: must be https and not a loopback host/) });
      expect(lines[0]).not.toContain(url);
    }
  });

  it('local with the demo API on this machine boots', async () => {
    const { exit, lines } = await boot({ CONSOLE_ENVIRONMENT: 'local', CONSOLE_API_URL: 'http://localhost:3000/v1' });
    expect(exit).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('production with an https API boots', async () => {
    const { exit, lines } = await boot({ CONSOLE_ENVIRONMENT: 'production', CONSOLE_API_URL: 'https://api-il.kesher.example/v1' });
    expect(exit).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});

describe('/healthz (T-0047)', () => {
  async function health(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) if (v !== undefined) vi.stubEnv(k, v);
    for (const k of ['CONSOLE_ENVIRONMENT', 'CONSOLE_API_URL']) if (env[k] === undefined) delete process.env[k];
    const res = (await import('../app/healthz/route.ts')).GET();
    return { status: res.status, body: await res.text(), cache: res.headers.get('cache-control') };
  }

  it('answers 200 uncached when configured', async () => {
    const r = await health({ CONSOLE_ENVIRONMENT: 'staging', CONSOLE_API_URL: 'https://api-il.kesher.example/v1' });
    expect(r).toEqual({ status: 200, body: '{"status":"ok"}', cache: 'no-store' });
  });

  it('answers 503 when misconfigured and names no key or value', async () => {
    const r = await health({ CONSOLE_ENVIRONMENT: 'staging', CONSOLE_API_URL: 'http://api.example.com/v1' });
    expect(r.status).toBe(503);
    expect(r.body).toBe('{"status":"misconfigured"}');
    expect(r.cache).toBe('no-store');
  });

  it('the proxy matcher leaves /healthz alone', () => {
    const src = fs.readFileSync(path.join(APP, 'proxy.ts'), 'utf8');
    const m = /matcher: \['([^']+)'\]/.exec(src)?.[1];
    expect(m).toBeDefined();
    const re = new RegExp(`^${m!}$`);
    expect(re.test('/healthz')).toBe(false);
    expect(re.test('/roster')).toBe(true);
  });
});
