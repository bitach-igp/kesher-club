// The worker as a process (T-0022). Config first, so a missing value exits before anything opens; then
// the Postgres pool, a one-connection pool for the job locks, the PII cipher, the identity repository,
// the provider registry and createApp (the worker builds the API's services and never serves HTTP), then
// every job on the scheduler. SIGTERM schedules nothing more, lets running jobs finish (up to DRAIN_MS)
// and closes the pools. Lines go to stdout as JSON with no member data, payloads or config values.
import { ApprovalService } from '@kesher/api/approvals/service';
import { AuditService } from '@kesher/api/audit/service';
import { assertProdSimulatorsSafe, FlagService } from '@kesher/api/flags/service';
import { createApp } from '@kesher/api/app';
import { PostgresIdentityRepository } from '@kesher/api/auth/pg-repository';
import { importSigningKey } from '@kesher/api/auth/tokens';
import { loadWorkerConfig } from '@kesher/api/config';
import { createLogger, stdoutMetrics, type LogFields } from '@kesher/domain';
import { createPiiCipher } from '@kesher/api/crypto/pii';
import { createPgDatabase } from '@kesher/api/pg';
import { createRegistry, crowdedWebhookSecrets, overridesFromConfig } from '@kesher/api/registry';
import { buildJobs as defaultJobs, type JobDeps, loadCatalogueConfig, pgRunLog } from './jobs.ts';
import { advisoryLock } from './lock.ts';
import { type Job, type Log, Scheduler } from './scheduler.ts';

/** How long SIGTERM waits for running jobs; ECS sends SIGKILL at 30 s. A job cut off is re-run next cycle. */
export const DRAIN_MS = 20_000;

export interface RunningWorker {
  /** The jobs scheduled, by name. */
  jobs: string[];
  /** Schedules nothing more, waits for running jobs (up to the drain deadline), closes the pools. Idempotent. */
  shutdown(): Promise<void>;
}

export interface WorkerOptions {
  log?: Log;
  drainMs?: number;
  /** The job table; tests swap it to reach the drain deadline. */
  buildJobs?: (deps: JobDeps) => Job[];
  /** The jobs' clock; tests fix it so a nightly job's slot does not depend on when they run. */
  clock?: () => Date;
}

/**
 * The worker's sink takes flat fields (the scheduler's `Log`); the shared logger behind it keeps only the fields it knows and
 * scrubs their text (T-0052), so an unexpected field is dropped by name, never printed.
 */
const sink = (logger: ReturnType<typeof createLogger>): Log => (event, fields) => logger(event, fields as LogFields);

/** The process logger before the config is known (boot failures, signals); once it is, `main` logs with its market. */
export const log: Log = sink(createLogger({ service: 'worker' }));

export async function main(env: Record<string, string | undefined>, opts: WorkerOptions = {}): Promise<RunningWorker> {
  const drainMs = opts.drainMs ?? DRAIN_MS;
  const config = loadWorkerConfig(env); // throws ConfigError, naming every problem, before anything opens
  const emit = opts.log ?? sink(createLogger({ service: 'worker', market: config.MARKET }));
  const catalogue = loadCatalogueConfig(); // config/catalogue.json: missing or malformed throws here too
  const db = createPgDatabase(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
  // The locks' own session: one connection, never reaped while idle (lock.ts).
  const locks = createPgDatabase(config.DATABASE_URL, { max: 1, idleTimeoutMs: 0 });
  const closePools = () => Promise.all([db.close(), locks.close()]).then(() => undefined);
  try {
    const pii = createPiiCipher({ dataKey: config.PII_DATA_KEY, indexKey: config.PII_INDEX_KEY });
    // createApp wires the token service too; the worker never mints a token, but builds the same graph.
    const signingKey = await importSigningKey(JSON.parse(config.JWT_SIGNING_KEY.reveal()) as Parameters<typeof importSigningKey>[0], config.JWT_SIGNING_KID);
    // Same provider choice as the API (T-0659): the worker replays webhook events and reads provider state through the same adapter.
    const { registry, providers } = createRegistry(config.PROVIDER_MODE_DEFAULT, undefined, overridesFromConfig(config, db, (message) => emit('warning', { message })), stdoutMetrics);
    const clock = opts.clock ?? (() => new Date());
    // T-0043: prod may leave a port on its simulator only while every flag it gates is off (registry default and store).
    await assertProdSimulatorsSafe(config.APP_ENV, registry, config.MARKET, new FlagService(db, new ApprovalService(db), new AuditService(db)));
    const app = createApp({
      refuseFlagsOnSimulators: config.APP_ENV === 'prod', db, registry, market: config.MARKET, signingKey, issuer: config.TOKEN_ISSUER, identity: new PostgresIdentityRepository(db, pii), clock, crowdedWebhookSecrets: crowdedWebhookSecrets(config) });
    const jobs = (opts.buildJobs ?? defaultJobs)({ app, db, registry, market: config.MARKET, clock, runs: pgRunLog(db), catalogue });
    const scheduler = new Scheduler(jobs, advisoryLock(locks, config.MARKET), emit);
    scheduler.start();
    // The worker's Log takes flat fields: the per-port providers go as one JSON string.
    emit('started', { market: config.MARKET, mode: config.PROVIDER_MODE_DEFAULT, providers: JSON.stringify(providers), jobs: jobs.length });

    let closing: Promise<void> | undefined;
    return {
      jobs: jobs.map((j) => j.name),
      shutdown: () =>
        (closing ??= (async () => {
          emit('draining', { drainMs });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const drained = await Promise.race([
            scheduler.stop().then(() => true),
            new Promise<false>((r) => (timer = setTimeout(() => r(false), drainMs))),
          ]);
          clearTimeout(timer);
          if (!drained) {
            // A pool cannot close under a running query; the process exits and Postgres frees the locks.
            emit('drain_timeout', { drainMs });
            return;
          }
          await closePools();
          emit('stopped', {});
        })()),
    };
  } catch (e) {
    await closePools();
    throw e;
  }
}
