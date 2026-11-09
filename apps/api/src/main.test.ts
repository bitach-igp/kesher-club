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
import { computeCrowdedSignature } from '@kesher/adapters';
import { ConfigError } from '@kesher/domain';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drain, main } from './main.ts';
import { createPgDatabase } from './pg.ts';
import { createMigratedPGlite } from './test-db.ts';

// A pass-through spy: the real pool is still created, and a test can assert that a refused start never reached it.
vi.mock('./pg.ts', async (importOriginal) => {
  const original = await importOriginal<{ createPgDatabase: typeof createPgDatabase }>();
  return { ...original, createPgDatabase: vi.fn(original.createPgDatabase) };
});

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

// T-0659 (REQ-INS-022, REQ-INS-025): the configured Crowded secrets reach the webhook receiver, so it verifies for real.
describe('Crowded wiring (T-0659)', () => {
  const TOKEN = 'crowded-api-token-do-not-print';
  const CURRENT = 'whsec-current-do-not-print';
  const PREVIOUS = 'whsec-previous-do-not-print';
  const SIMULATOR = 'whsec-the-simulators-own';
  const crowdedEnv = () => ({ ...env, PROVIDER_INSTITUTION_BANKING: 'crowded', CROWDED_BASE_URL: 'https://crowded.test/api/v1', CROWDED_API_TOKEN: TOKEN, CROWDED_WEBHOOK_SECRETS: `${CURRENT},${PREVIOUS}` });
  const batch = (eventId: string) => JSON.stringify({ events: [{ eventId, eventType: 'platform.ping', version: '1.0', timestamp: '2026-11-03T09:59:00Z', context: { partnerId: 'p1' }, data: {} }] });
  const deliver = async (port: number, body: string, signature: string): Promise<number> =>
    (await fetch(`http://127.0.0.1:${port}/v1/webhooks/crowded`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': signature }, body })).status;
  const stored = async (eventId: string): Promise<number> => (await lite.query(`select 1 from ops.inbound_event where provider = 'crowded' and event_id = $1`, [eventId])).rows.length;

  beforeAll(async () => {
    // The receiver answers 404 until institutions.usBanking is on; the flag's approval and audit rows are not what is under test.
    await lite.exec(`set session_replication_role = replica;
      insert into ops.flag_state (key, value, changed_at, approval_id, audit_id) values ('institutions.usBanking', true, now(), gen_random_uuid(), gen_random_uuid());
      reset session_replication_role;`);
  });
  afterAll(async () => {
    await lite.exec(`delete from ops.flag_state where key = 'institutions.usBanking'`);
  });

  it('accepts a delivery signed with the configured secret, or the previous one, and stores it', async () => {
    const api = await main({ ...crowdedEnv(), PORT: String(await freePort()) });
    try {
      const a = batch('wire-current');
      expect(await deliver(api.port, a, computeCrowdedSignature(CURRENT, a))).toBe(200);
      expect(await stored('wire-current')).toBe(1);
      const b = batch('wire-previous');
      expect(await deliver(api.port, b, computeCrowdedSignature(PREVIOUS, b))).toBe(200);
      expect(await stored('wire-previous')).toBe(1);
    } finally {
      await api.shutdown();
    }
  });

  it('refuses a delivery signed with the simulator\'s secret or signature, and stores nothing', async () => {
    const api = await main({ ...crowdedEnv(), PORT: String(await freePort()) });
    try {
      const body = batch('wire-sim');
      expect(await deliver(api.port, body, computeCrowdedSignature(SIMULATOR, body))).toBe(401);
      expect(await deliver(api.port, body, 'sha256=sim')).toBe(401);
      expect(await stored('wire-sim')).toBe(0);
    } finally {
      await api.shutdown();
    }
  });

  it('on the simulator (the default) no secret is configured, so every delivery is refused, as before', async () => {
    const api = await main({ ...env, PORT: String(await freePort()) });
    try {
      const body = batch('wire-default');
      for (const secret of [CURRENT, SIMULATOR]) expect(await deliver(api.port, body, computeCrowdedSignature(secret, body))).toBe(401);
      expect(await stored('wire-default')).toBe(0);
    } finally {
      await api.shutdown();
    }
  });

  it('logs the provider chosen per port at start-up and never the token or a secret', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let out: string;
    try {
      for (const e of [crowdedEnv(), env]) {
        const api = await main({ ...e, PORT: String(await freePort()) });
        await api.shutdown();
      }
      out = write.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      write.mockRestore();
    }
    const listening = out.split('\n').filter((l) => l.includes('"event":"listening"')).map((l) => JSON.parse(l) as { providers: Record<string, string> });
    expect(listening.map((l) => l.providers['institution-banking'])).toEqual(['crowded', 'sim']);
    for (const s of [TOKEN, CURRENT, PREVIOUS]) expect(out).not.toContain(s);
  });

  it('refuses a partial Crowded environment before opening anything', async () => {
    const { CROWDED_API_TOKEN: _t, ...partial } = crowdedEnv();
    const port = await freePort();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.mocked(createPgDatabase).mockClear();
    let err: unknown;
    let out: string;
    try {
      err = await main({ ...partial, PORT: String(port) }).catch((e: unknown) => e);
      out = write.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      write.mockRestore();
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).missing).toEqual(['CROWDED_API_TOKEN']);
    expect((err as ConfigError).message).not.toContain(CURRENT);
    // Nothing was opened: no Postgres pool was created, nothing listens on the port, and no lifecycle line was written.
    expect(createPgDatabase).not.toHaveBeenCalled();
    await expect(fetch(`http://127.0.0.1:${port}/v1/status`)).rejects.toThrow();
    expect(out).toBe('');
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

// T-0043: prod boots on simulators only for ports whose flags are off.
describe('simulators in production (T-0043)', () => {
  const GATED_ON_BY_DEFAULT = ['billing.stripe', 'billing.applePay', 'billing.googlePay'];
  const setFlags = async (value: boolean, keys: readonly string[]) => {
    await lite.exec(`set session_replication_role = replica;
      ${keys.map((k) => `insert into ops.flag_state (key, value, changed_at, approval_id, audit_id) values ('${k}', ${value}, now(), gen_random_uuid(), gen_random_uuid()) on conflict (key) do update set value = ${value};`).join('\n')}
      reset session_replication_role;`);
  };
  afterAll(async () => {
    await lite.exec(`delete from ops.flag_state where key in ('billing.stripe','billing.applePay','billing.googlePay','card.virtual')`);
  });

  it('refuses to start while a simulator port has a flag on, naming both, and listens on nothing', async () => {
    const port = String(await freePort());
    const err = await main({ ...env, APP_ENV: 'prod', PORT: port }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/port billing is a simulator but flag billing\.stripe is on/);
    await expect(fetch(`http://127.0.0.1:${port}/v1/status`)).rejects.toThrow();
  });

  it('boots with those flags off, and refuses a later flip of a card flag while the card port is a simulator', async () => {
    await new Promise((r) => setTimeout(r, 250)); // the wire server serves one client at a time; let the closed one go
    await setFlags(false, GATED_ON_BY_DEFAULT);
    const api = await main({ ...env, APP_ENV: 'prod', PORT: String(await freePort()) });
    try {
      expect((await get(api.port, '/v1/status')).status).toBe(200);
    } finally {
      await api.shutdown();
    }
    await new Promise((r) => setTimeout(r, 250)); // the wire server serves one client at a time; let the closed one go
    await setFlags(true, ['card.virtual']);
    const err = await main({ ...env, APP_ENV: 'prod', PORT: String(await freePort()) }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/port card-issuing is a simulator but flag card\.virtual is on/);
  });
});
