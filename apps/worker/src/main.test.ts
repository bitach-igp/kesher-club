// T-0022: the worker as a process. `main()` boots the real composition root on node-postgres against
// PGlite's wire server and runs one cycle of every job; the real entry point runs as a child process
// under plain `node --experimental-strip-types`, the way the container starts it.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createMigratedPGlite } from '@kesher/api/test-db';
import { ConfigError } from '@kesher/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Migrating a fresh PGlite takes seconds, and well over vitest's 10 s hook default when every package tests at once. */
const MIGRATED_PGLITE_MS = 60_000;
let lite: PGlite;
let server: PGLiteSocketServer;
let env: Record<string, string>;

beforeAll(async () => {
  lite = await createMigratedPGlite();
  // The job pool and the lock pool each hold a connection; the rest is room for a pool that just closed.
  server = new PGLiteSocketServer({ db: lite, host: '127.0.0.1', port: 0, maxConnections: 6 });
  await server.start();
  env = {
    APP_ENV: 'test',
    DATABASE_URL: `postgres://postgres@${server.getServerConn()}/postgres?sslmode=disable`,
    DATABASE_POOL_MAX: '1',
    TEMPORAL_ADDRESS: 'localhost:7233',
    PROVIDER_MODE_DEFAULT: 'sim',
    JWT_SIGNING_KEY: JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })),
    JWT_SIGNING_KID: 'test-key',
    TOKEN_ISSUER: 'https://api.kesher.test',
    MARKET: 'IL',
    STAFF_JWKS: '{"keys":[{"kty":"EC","crv":"P-256","x":"x","y":"y","kid":"staff"}]}',
    PII_DATA_KEY: randomBytes(32).toString('base64'),
    PII_INDEX_KEY: randomBytes(32).toString('base64'),
  };
}, MIGRATED_PGLITE_MS);

afterAll(async () => {
  await server.stop();
  await lite.close();
});

type Line = { event: string; fields: Record<string, string | number | boolean> };
const until = async (done: () => boolean, ms: number, what: () => string): Promise<void> => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('main (T-0022)', () => {
  it('boots on Postgres and the simulators, runs one cycle of every job, and stops cleanly', async () => {
    const lines: Line[] = [];
    // Noon in Israel: past every nightly slot, whatever the time CI runs at.
    const worker = await main(env, { log: (event, fields) => lines.push({ event, fields }), clock: () => new Date('2026-10-19T09:00:00Z') });
    const ran = () => new Set(lines.filter((l) => l.event === 'job_ran').map((l) => l.fields['job']));
    try {
      expect(worker.jobs).toHaveLength(20);
      await until(() => ran().size === worker.jobs.length || lines.some((l) => l.event === 'job_failed'), 30_000, () => JSON.stringify(lines));
      expect(lines.filter((l) => l.event === 'job_failed' || l.event === 'job_skipped')).toEqual([]);
      expect([...ran()].sort()).toEqual([...worker.jobs].sort());
    } finally {
      await worker.shutdown();
    }
    expect(lines.at(-1)).toEqual({ event: 'stopped', fields: {} });
    await worker.shutdown(); // idempotent
  }, 60_000);

  it('gives up waiting at the drain deadline instead of hanging on a job that never ends', async () => {
    const lines: Line[] = [];
    const worker = await main(env, {
      log: (event, fields) => lines.push({ event, fields }),
      drainMs: 200,
      buildJobs: () => [{ name: 'stuck', scope: 'market', everyMs: 60_000, run: () => new Promise(() => undefined) }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await worker.shutdown();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(lines.map((l) => l.event)).toEqual(['started', 'draining', 'drain_timeout']);
  });

  it('refuses to start without its configuration, naming what is missing', async () => {
    const { PII_INDEX_KEY: _k, ...partial } = env;
    const err = await main(partial).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).missing).toEqual(['PII_INDEX_KEY']);
  });
});

describe('the entry point under plain Node (T-0022)', () => {
  const run = (childEnv: Record<string, string>) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/index.ts'], { cwd: WORKER_DIR, env: { ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}), ...childEnv } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    return { child, exited, output: () => out };
  };

  it('boots from the environment, runs its jobs, and exits 0 on SIGTERM', async () => {
    const p = run(env);
    await until(() => p.output().includes('"event":"job_ran"'), 30_000, p.output);
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    expect(p.output()).toContain('"event":"stopped"');
    expect(p.output()).not.toContain('"event":"job_failed"');
  }, 60_000);

  it('exits 1 on a bad configuration and names the key without printing any secret', async () => {
    const p = run({ ...env, JWT_SIGNING_KEY: '{"kty":"EC","d":"leak-me-not" oops' });
    expect(await p.exited).toBe(1);
    expect(p.output()).toContain('JWT_SIGNING_KEY');
    expect(p.output()).not.toContain('leak-me-not');
    expect(p.output()).not.toContain(env['PII_DATA_KEY']);
  }, 30_000);
});
