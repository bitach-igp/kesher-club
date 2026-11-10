// T-0022: the worker as a process. `main()` boots the real composition root on node-postgres against
// PGlite's wire server and runs one cycle of every job; the real entry point runs as a child process
// under plain `node --experimental-strip-types`, the way the container starts it.
import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createPgDatabase } from '@kesher/api/pg';
import { dispatch } from '@kesher/api/server';
import { createMigratedPGlite } from '@kesher/api/test-db';
import { ConfigError } from '@kesher/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobDeps } from './jobs.ts';
import { main } from './main.ts';

// A pass-through spy: the real pool is still created, and a test can assert that a refused start never reached it.
vi.mock('@kesher/api/pg', async (importOriginal) => {
  const original = await importOriginal<{ createPgDatabase: typeof createPgDatabase }>();
  return { ...original, createPgDatabase: vi.fn(original.createPgDatabase) };
});

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

// T-0042: the start-up log names all five overridable ports; the new four stay on the simulator unless chosen.
const ALL_SIM = { 'institution-banking': 'sim', esim: 'sim', insurance: 'sim', 'org-idp': 'sim', 'federated-idp': 'sim', funding: 'sim', 'notify-sms': 'sim', 'notify-email': 'sim', 'notify-push': 'sim' };

describe('main (T-0022)', () => {
  it('boots on Postgres and the simulators, runs one cycle of every job, and stops cleanly', async () => {
    const lines: Line[] = [];
    // Noon in Israel: past every nightly slot, whatever the time CI runs at.
    const worker = await main(env, { log: (event, fields) => lines.push({ event, fields }), clock: () => new Date('2026-10-19T09:00:00Z') });
    const ran = () => new Set(lines.filter((l) => l.event === 'job_ran').map((l) => l.fields['job']));
    try {
      expect(worker.jobs).toHaveLength(26);
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

// T-0659 (REQ-INS-022): the worker takes the same per-port provider choice as the API, and logs it at start-up.
describe('Crowded wiring (T-0659)', () => {
  const TOKEN = 'crowded-api-token-do-not-print';
  const CURRENT = 'whsec-current-do-not-print';
  const PREVIOUS = 'whsec-previous-do-not-print';
  const crowdedEnv = (extra: Record<string, string> = {}) => ({
    ...env,
    PROVIDER_INSTITUTION_BANKING: 'crowded',
    CROWDED_BASE_URL: 'https://crowded.test/api/v1',
    CROWDED_API_TOKEN: TOKEN,
    CROWDED_WEBHOOK_SECRETS: `${CURRENT},${PREVIOUS}`,
    ...extra,
  });
  /** Boots the worker with no jobs, keeps the registry it was built on, and stops it. */
  const boot = async (e: Record<string, string>) => {
    const lines: Line[] = [];
    let registry: JobDeps['registry'] | undefined;
    const worker = await main(e, {
      log: (event, fields) => lines.push({ event, fields }),
      buildJobs: (deps) => {
        registry = deps.registry;
        return [];
      },
    });
    await worker.shutdown();
    return { lines, registry: registry! };
  };
  const started = (lines: Line[]) => lines.find((l) => l.event === 'started')!.fields;

  it('binds the banking port to Crowded when configured, and every other port stays on its simulator', async () => {
    const { registry } = await boot(crowdedEnv());
    for (const market of ['IL', 'US'] as const) {
      expect(registry.bindingFor('institution-banking', market)).toMatchObject({ provider: 'crowded', mode: 'sandbox' });
      expect(registry.bindingFor('funding', market)).toMatchObject({ provider: 'simulator', mode: 'sim' });
    }
  });

  it('on the simulator (the default) the banking port stays on its simulator', async () => {
    const { registry, lines } = await boot(env);
    expect(registry.bindingFor('institution-banking', 'US')).toMatchObject({ provider: 'simulator', mode: 'sim' });
    expect(started(lines)).toMatchObject({ mode: 'sim', providers: JSON.stringify(ALL_SIM) });
  });

  it('logs the mode and the provider per port at start-up, and never the token or a secret', async () => {
    const { lines } = await boot(crowdedEnv());
    expect(started(lines)).toMatchObject({ market: 'IL', mode: 'sim', providers: JSON.stringify({ ...ALL_SIM, 'institution-banking': 'crowded' }), jobs: 0 });
    expect(JSON.parse(String(started(lines)['providers']))).toEqual({ ...ALL_SIM, 'institution-banking': 'crowded' });
    for (const s of [TOKEN, CURRENT, PREVIOUS]) expect(JSON.stringify(lines)).not.toContain(s);
    expect(lines.filter((l) => l.event === 'warning')).toEqual([]);
  });

  it('binds live only with CROWDED_BINDING=live, and then warns that the approval is not applied by an env switch', async () => {
    const { registry, lines } = await boot(crowdedEnv({ CROWDED_BINDING: 'live' }));
    expect(registry.bindingFor('institution-banking', 'US')).toMatchObject({ provider: 'crowded', mode: 'live' });
    const warning = lines.find((l) => l.event === 'warning');
    expect(String(warning?.fields['message'])).toMatch(/provider_binding approval in ops\.approval_request is not applied by an env switch/);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('refuses a partial Crowded environment before opening anything', async () => {
    const { CROWDED_API_TOKEN: _t, ...partial } = crowdedEnv();
    const lines: Line[] = [];
    vi.mocked(createPgDatabase).mockClear();
    const err = await main(partial, { log: (event, fields) => lines.push({ event, fields }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).missing).toEqual(['CROWDED_API_TOKEN']);
    // Nothing was opened: no Postgres pool was created and no lifecycle line was written.
    expect(createPgDatabase).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  describe('the webhook receiver the worker builds', () => {
    const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const batch = (eventId: string) => JSON.stringify({ events: [{ eventId, eventType: 'platform.ping', version: '1.0', timestamp: '2026-11-03T09:59:00Z', context: { partnerId: 'p1' }, data: {} }] });
    const post = async (app: JobDeps['app'], body: string, signature: string) => (await dispatch(app, { method: 'POST', url: '/v1/webhooks/crowded', headers: { 'content-type': 'application/json', 'x-webhook-signature': signature }, rawBody: body })).status;
    /** Boots the worker, runs use against the app it built while its pool is open, and stops it. */
    const withApp = async (e: Record<string, string>, use: (app: JobDeps['app']) => Promise<void>) => {
      let app: JobDeps['app'] | undefined;
      const worker = await main(e, { log: () => undefined, buildJobs: (deps) => ((app = deps.app), []) });
      try {
        await use(app!);
      } finally {
        await worker.shutdown();
      }
    };

    beforeAll(async () => {
      // The receiver answers 404 until institutions.usBanking is on; the flag's approval and audit rows are not what is under test.
      await lite.exec(`set session_replication_role = replica;
        insert into ops.flag_state (key, value, changed_at, approval_id, audit_id) values ('institutions.usBanking', true, now(), gen_random_uuid(), gen_random_uuid());
        reset session_replication_role;`);
    });
    afterAll(async () => {
      await lite.exec(`delete from ops.flag_state where key = 'institutions.usBanking'`);
    });

    it('is given the configured secrets: the current and the previous one verify, the simulator\'s signature does not', async () => {
      await withApp(crowdedEnv(), async (app) => {
        const a = batch('worker-current');
        expect(await post(app, a, sign(CURRENT, a))).toBe(200);
        const b = batch('worker-previous');
        expect(await post(app, b, sign(PREVIOUS, b))).toBe(200);
        const c = batch('worker-sim');
        expect(await post(app, c, 'sha256=sim')).toBe(401);
        expect(await post(app, c, sign('whsec-the-simulators-own', c))).toBe(401);
      });
    });

    it('on the simulator (the default) no secret is configured, so every delivery is refused', async () => {
      await withApp(env, async (app) => {
        const body = batch('worker-default');
        expect(await post(app, body, sign(CURRENT, body))).toBe(401);
      });
    });
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

// T-0043: the worker applies the same prod guard as the API.
describe('simulators in production (T-0043)', () => {
  it('refuses to start in prod while a simulator port has a flag on', async () => {
    const err = await main({ ...env, APP_ENV: 'prod' }, { log: () => undefined }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/port billing is a simulator but flag billing\.stripe is on/);
  });
});
