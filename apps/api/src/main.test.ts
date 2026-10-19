// T-0021: the API as a process. `main()` boots the real composition root on node-postgres against
// PGlite's wire server, `drain()` is checked on its own, and the real entry point runs as a child
// process under plain `node --experimental-strip-types`, the way the container starts it.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { ConfigError } from '@kesher/domain';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drain, main } from './main.ts';
import { createMigratedPGlite } from './test-db.ts';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Migrating a fresh PGlite takes seconds, and well over vitest's 10 s hook default when every package tests at once. */
const MIGRATED_PGLITE_MS = 60_000;
let lite: PGlite;
let server: PGLiteSocketServer;
let env: Record<string, string>;

const freePort = async (): Promise<number> => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};

beforeAll(async () => {
  lite = await createMigratedPGlite();
  server = new PGLiteSocketServer({ db: lite, host: '127.0.0.1', port: 0 });
  await server.start();
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  env = {
    APP_ENV: 'test',
    DATABASE_URL: `postgres://postgres@${server.getServerConn()}/postgres?sslmode=disable`,
    DATABASE_POOL_MAX: '1',
    TEMPORAL_ADDRESS: 'localhost:7233',
    PROVIDER_MODE_DEFAULT: 'sim',
    JWT_SIGNING_KEY: JSON.stringify(await exportJWK(privateKey)),
    JWT_SIGNING_KID: 'test-key',
    TOKEN_ISSUER: 'https://api.kesher.test',
    MARKET: 'IL',
    STAFF_JWKS: '{"keys":[{"kty":"EC","crv":"P-256","x":"x","y":"y","kid":"staff"}]}',
    PII_DATA_KEY: randomBytes(32).toString('base64'),
    PII_INDEX_KEY: randomBytes(32).toString('base64'),
    PORT: String(await freePort()),
  };
}, MIGRATED_PGLITE_MS);

afterAll(async () => {
  await server.stop();
  await lite.close();
});

const get = async (port: number, p: string): Promise<{ status: number; type: string; body: unknown }> => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.json() };
};

describe('main (T-0021)', () => {
  it('boots on Postgres and the simulators, answers, and shuts down cleanly', async () => {
    const api = await main(env);
    try {
      expect((await get(api.port, '/v1/status')).status).toBe(200);
      const missing = await get(api.port, '/v1/no-such-route');
      expect(missing).toMatchObject({ status: 404, type: expect.stringContaining('application/problem+json') });
    } finally {
      await api.shutdown();
    }
    await expect(fetch(`http://127.0.0.1:${api.port}/v1/status`)).rejects.toThrow();
    await api.shutdown(); // idempotent
  });

  it('refuses to start without its configuration, naming what is missing and listening on nothing', async () => {
    const { PII_INDEX_KEY: _k, ...partial } = env;
    const err = await main(partial).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).missing).toEqual(['PII_INDEX_KEY']);
    await expect(fetch(`http://127.0.0.1:${env['PORT']}/v1/status`)).rejects.toThrow();
  });
});

describe('drain (T-0021)', () => {
  const serve = async (handler: http.RequestListener): Promise<{ server: http.Server; port: number }> => {
    const s = http.createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return { server: s, port: (s.address() as AddressInfo).port };
  };

  it('lets an in-flight request finish before it resolves', async () => {
    const { server: s, port } = await serve((_req, res) => setTimeout(() => res.end('done'), 300));
    const inFlight = fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    await drain(s, 5_000);
    expect(await inFlight).toBe('done');
  });

  it('cuts a request that outlives the deadline, so shutdown always ends', async () => {
    const { server: s, port } = await serve(() => undefined); // never answers
    const inFlight = fetch(`http://127.0.0.1:${port}/`).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await drain(s, 200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await inFlight).toBeInstanceOf(Error);
  });
});

describe('the entry point under plain Node (T-0021)', () => {
  const run = (childEnv: Record<string, string>) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/index.ts'], { cwd: API_DIR, env: { ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}), ...childEnv } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const waitFor = async (text: string, ms = 20_000): Promise<void> => {
      const until = Date.now() + ms;
      while (!out.includes(text)) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${text}; output so far:\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    return { child, exited, waitFor, output: () => out };
  };

  it('boots from the environment, serves, and exits 0 on SIGTERM', async () => {
    const p = run(env);
    await p.waitFor('"event":"listening"');
    expect((await get(Number(env['PORT']), '/v1/status')).status).toBe(200);
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    expect(p.output()).toContain('"event":"stopped"');
  }, 30_000);

  it('exits 1 on a bad configuration and names the key without printing any secret', async () => {
    const p = run({ ...env, JWT_SIGNING_KEY: '{"kty":"EC","d":"leak-me-not" oops' });
    expect(await p.exited).toBe(1);
    expect(p.output()).toContain('JWT_SIGNING_KEY');
    expect(p.output()).not.toContain('leak-me-not');
    expect(p.output()).not.toContain(env['PII_DATA_KEY']);
  }, 30_000);
});
