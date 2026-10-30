// One local process for the demo (T-0031): the API, every worker job and the simulators' control panel on
// one provider registry and one advanceable clock. Run separately, each process got its own simulators, so a
// load the API submitted was unknown to the worker's sweep and a panel hook changed neither. Here a panel
// hook reaches the API's vendor, and the panel's clock moves the API's and the jobs' time with it.
//
// Development only: anything but APP_ENV=development exits 1 with one boot_failed line, like main.ts. Keys
// left unset are generated at start, held only in memory and never printed. Every flag in
// config/flags.json is on in this process (in memory; the flag table is untouched), because the demo exists
// to show the gated flows. Never built into an image.
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { createApp, type App } from '@kesher/api/app';
import { PostgresIdentityRepository } from '@kesher/api/auth/pg-repository';
import { importSigningKey } from '@kesher/api/auth/tokens';
import { loadRegistry, StaticFlags } from '@kesher/api/billing/capabilities';
import { loadApiConfig } from '@kesher/api/config';
import { createPiiCipher } from '@kesher/api/crypto/pii';
import type { Database } from '@kesher/api/db';
import { createPgDatabase } from '@kesher/api/pg';
import { createRegistry, systemClock } from '@kesher/api/registry';
import { createServer } from '@kesher/api/server';
import { ConfigError, loadConfig } from '@kesher/domain';
import type { AdvanceableClock } from '@kesher/ports';
import { lookup } from 'node:dns/promises';
import { createServer as createPanel, DemoAssistant, DEMO_ASSISTANT_CLIENT_ID, DEMO_ASSISTANT_HOST, type SimulatorHost } from '@kesher/simulators';
import { z } from 'zod';
import { buildJobs, loadCatalogueConfig, pgRunLog } from '@kesher/worker/jobs';
import { noLock, Scheduler, type Job } from '@kesher/worker/scheduler';

export const DEFAULT_PORT = 3000;
export const DEFAULT_SIMULATOR_PORT = 4010;

const port = z.coerce.number().int().min(1).max(65535);
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;
/** The demo's own keys; the API's are checked by its loader. Only development may boot. */
const demoConfigSchema = z.object({
  APP_ENV: z.literal('development', { error: 'the demo runs only in development' }),
  PORT: port.default(DEFAULT_PORT),
  SIMULATOR_PORT: port.default(DEFAULT_SIMULATOR_PORT),
  /** Where the member app's web build is served (T-0033); comma-separated, loopback http origins only. */
  DEMO_WEB_ORIGINS: z
    .string()
    .default('http://localhost:8081,http://127.0.0.1:8081')
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean))
    .refine((list) => list.every((o) => LOOPBACK_ORIGIN.test(o)), { error: 'every entry must be an http origin on localhost, 127.0.0.1 or [::1]' }),
});

export interface DevOptions {
  /** A database to use instead of DATABASE_URL's pool; tests pass PGlite. The caller closes it. */
  db?: Database;
  /** False leaves the jobs off the scheduler; tests run them one at a time with runJob. */
  schedule?: boolean;
  /** Ports to listen on instead of PORT and SIMULATOR_PORT; 0 picks a free one (tests). */
  ports?: { api: number; panel: number };
}

export interface RunningDev {
  apiPort: number;
  panelPort: number;
  app: App;
  simulators: SimulatorHost;
  clock: AdvanceableClock;
  jobs: string[];
  /** Runs one job now, by name, on the shared clock. */
  runJob(name: string): Promise<unknown>;
  /** The demo assistant on the panel (T-1017): connect a persona at /assistant/start, then call /mcp with its token. */
  assistant: DemoAssistant;
  shutdown(): Promise<void>;
}

export const log = (event: string, fields: Record<string, string | number | boolean> = {}): void => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), service: 'demo', event, ...fields })}\n`);
};

/** The API's config with development defaults; only APP_ENV and DATABASE_URL must be given. */
async function devEnv(env: Record<string, string | undefined>, apiPort: number): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {
    PROVIDER_MODE_DEFAULT: 'sim',
    TEMPORAL_ADDRESS: 'localhost:7233',
    MARKET: 'US',
    TOKEN_ISSUER: `http://localhost:${apiPort}`,
    JWT_SIGNING_KID: 'demo-1',
    ...env,
    PORT: String(apiPort),
  };
  if (!out['JWT_SIGNING_KEY']) out['JWT_SIGNING_KEY'] = JSON.stringify(await privateJwk());
  if (!out['STAFF_JWKS']) {
    const { d: _private, ...pub } = await privateJwk();
    out['STAFF_JWKS'] = JSON.stringify({ keys: [{ ...pub, kid: 'demo-staff-1', alg: 'ES256', use: 'sig' }] });
  }
  if (!out['PII_DATA_KEY']) out['PII_DATA_KEY'] = randomBytes(32).toString('base64');
  if (!out['PII_INDEX_KEY']) out['PII_INDEX_KEY'] = randomBytes(32).toString('base64');
  return out;
}

async function privateJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return exportJWK(privateKey);
}

const listen = (server: http.Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve((server.address() as AddressInfo).port));
  });

/**
 * Development-only CORS in front of the API for the member app's web build (T-0033): only the configured
 * origins, which DEMO_WEB_ORIGINS keeps to this machine, get the API's own headers; preflight ends here.
 */
export function withLoopbackCors(server: http.Server, origins: readonly string[]): http.Server {
  const [inner] = server.listeners('request') as ((req: http.IncomingMessage, res: http.ServerResponse) => void)[];
  if (!inner) throw new Error('The API server has no request listener');
  server.removeAllListeners('request');
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const allowed = origins.find((o) => o === req.headers.origin);
    if (allowed) {
      res.setHeader('access-control-allow-origin', allowed);
      res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-step-up, traceparent');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE');
      res.setHeader('access-control-expose-headers', 'x-trace-id');
    }
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    inner(req, res);
  });
  return server;
}

const close = (server: http.Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

export async function startDev(env: Record<string, string | undefined>, opts: DevOptions = {}): Promise<RunningDev> {
  const demo = loadConfig(demoConfigSchema, env); // APP_ENV first: nothing else is read outside development
  const config = loadApiConfig(await devEnv(env, demo.PORT)); // throws ConfigError naming every problem, before anything opens
  // A pool this process opened is closed by it; an injected database belongs to the caller.
  const pool = opts.db ? undefined : createPgDatabase(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
  const db: Database = opts.db ?? pool!;
  try {
    const pii = createPiiCipher({ dataKey: config.PII_DATA_KEY, indexKey: config.PII_INDEX_KEY });
    const signingKey = await importSigningKey(JSON.parse(config.JWT_SIGNING_KEY.reveal()) as JWK, config.JWT_SIGNING_KID);
    const clock = systemClock();
    const now = () => clock.now();
    const { registry, simulators } = createRegistry(config.PROVIDER_MODE_DEFAULT, clock);
    const flags = new StaticFlags(undefined, Object.fromEntries(loadRegistry().map((f) => [f.key, true])));
    // The demo assistant (T-1017): an OAuth client on the panel. Its client id sits on a reserved .test host that
    // this process answers itself, so the API's SSRF guard (T-1003) stays as strict as anywhere else: it sees a
    // public address and an https document, and no other host is answered this way. Development only.
    let ports = { api: 0, panel: 0 };
    const assistant = new DemoAssistant({ apiUrl: () => `http://localhost:${ports.api}`, issuer: () => config.TOKEN_ISSUER, panelUrl: () => `http://localhost:${ports.panel}` });
    const cimd = {
      resolve: async (host: string) => (host === DEMO_ASSISTANT_HOST ? ['93.184.216.34'] : (await lookup(host, { all: true })).map((a) => a.address)),
      fetch: async (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => {
        if (url !== DEMO_ASSISTANT_CLIENT_ID) return fetch(url, init);
        const body = JSON.stringify(assistant.document());
        return { status: 200, headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null) }, text: async () => body };
      },
    };
    const app = createApp({ db, registry, market: config.MARKET, signingKey, issuer: config.TOKEN_ISSUER, identity: new PostgresIdentityRepository(db, pii), pii, staffJwks: config.STAFF_JWKS, clock: now, flags, cimd, oauth: { consentUrl: `${demo.DEMO_WEB_ORIGINS[0]}/connect` } });
    const jobs: Job[] = buildJobs({ app, db, registry, market: config.MARKET, clock: now, runs: pgRunLog(db), catalogue: loadCatalogueConfig() });
    const scheduler = new Scheduler(jobs, noLock, (event, fields) => log(event, fields));

    // Asked for by a person (the panel, a test): a daily job runs now, not only at its hour once a day (T-0929).
    const runJob = (name: string): Promise<unknown> => {
      const job = jobs.find((j) => j.name === name);
      if (!job) throw new Error(`No job named ${name}`);
      return job.runNow ? job.runNow() : job.run();
    };

    // The panel moved the clock: every job ticks now, in order, as the scheduler would on its next cycle (a daily
    // job's tick stays idle unless the jump crossed its hour). A failure is logged like the scheduler's own.
    const onClockAdvanced = async (): Promise<void> => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          await job.run();
        } catch (e) {
          log('job_failed', { job: job.name, ms: Date.now() - started, error: (e as Error).name });
        }
      }
    };

    const api = withLoopbackCors(createServer(app), demo.DEMO_WEB_ORIGINS);
    const panel = createPanel(simulators, { jobs: { names: jobs.map((j) => j.name), run: runJob, onClockAdvanced }, assistant });
    const apiPort = await listen(api, opts.ports?.api ?? config.PORT);
    const panelPort = await listen(panel, opts.ports?.panel ?? demo.SIMULATOR_PORT);
    ports = { api: apiPort, panel: panelPort };
    if (opts.schedule !== false) scheduler.start();
    log('listening', { api: apiPort, panel: panelPort, market: config.MARKET, jobs: jobs.length, flags: 'all on' });

    let closing: Promise<void> | undefined;
    return {
      apiPort,
      panelPort,
      app,
      simulators,
      clock,
      jobs: jobs.map((j) => j.name),
      runJob,
      assistant,
      shutdown: () =>
        (closing ??= (async () => {
          await scheduler.stop();
          await Promise.all([close(api), close(panel)]);
          await pool?.close();
          log('stopped');
        })()),
    };
  } catch (e) {
    await pool?.close();
    throw e;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const dev = await startDev(process.env);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log('signal', { signal });
        void dev.shutdown().then(() => process.exit(0));
      });
    }
  } catch (e) {
    // A ConfigError's message names keys only; anything else prints its name and message, never a stack.
    log('boot_failed', e instanceof ConfigError ? { error: 'ConfigError', message: e.message } : { error: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}
