// T-0022: the job table runs every periodic job, and the next job cannot be forgotten. The coverage test
// reads apps/worker/src: a module exporting a class with a run/sweep/poll/sync… method, or a `run` function, must
// be imported by jobs.ts or named in JOB_EXCLUSIONS with a reason, and every exclusion must still be real.
import { readdirSync, readFileSync } from 'node:fs';
import { createApp } from '@kesher/api/app';
import { generateSigningKey } from '@kesher/api/auth/tokens';
import { createRegistry } from '@kesher/api/registry';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildJobs, CATALOGUE_CONFIG, catalogueConfigSchema, JOB_EXCLUSIONS, loadCatalogueConfig, NIGHTLY, pgRunLog } from './jobs.ts';
import { DAILY_TICK_MS, IDLE, noLock, Scheduler, type Job } from './scheduler.ts';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { money } from '@kesher/domain';

const SRC = new URL('./', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SRC), 'utf8');

/** Exports a class with a run/sweep/poll/sync… method, or a `run` function: something a scheduler would call. */
const isJobLike = (code: string): boolean =>
  (/^export class /m.test(code) && /^ {2}(?:async )?(?:run|sweep|poll|sync\w*)\(/m.test(code)) || /^export (?:async )?function run\(/m.test(code);

const modules = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => f.split('\\').join('/'));

describe('the job table covers every job (T-0022)', () => {
  const table = read('jobs.ts');
  const imported = new Set([...table.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]!));

  it('finds the job-like modules it is meant to police', () => {
    // A detector that matched nothing would pass everything below; these are known jobs.
    for (const m of ['wallet/load-workflow.ts', 'esim/usage.ts', 'recon/recon.ts', 'cards/issue-workflow.ts', 'catalogue/sync.ts']) expect(isJobLike(read(m)), m).toBe(true);
    expect(isJobLike(read('monitoring/rules.ts'))).toBe(false);
  });

  it('registers or excuses, with a reason, every job-like module in apps/worker/src', () => {
    const orphans = modules.filter((m) => isJobLike(read(m)) && !imported.has(m) && !(m in JOB_EXCLUSIONS));
    expect(orphans, 'add these to buildJobs, or to JOB_EXCLUSIONS with the reason they are not periodic').toEqual([]);
  });

  it('excuses only modules that exist, are job-like and are not also in the table', () => {
    for (const [m, reason] of Object.entries(JOB_EXCLUSIONS)) {
      expect(modules, m).toContain(m);
      expect(isJobLike(read(m)), `${m} is no longer job-like: drop its exclusion`).toBe(true);
      expect(imported.has(m), `${m} is both scheduled and excluded`).toBe(false);
      expect(reason.length, m).toBeGreaterThan(10);
    }
  });
});

describe('buildJobs (T-0022)', () => {
  const NOW = new Date('2026-10-19T09:00:00Z');
  let db: TestDatabase;
  let jobs: Job[];
  const results = new Map<string, unknown>();

  beforeAll(async () => {
    db = await createTestDatabase();
    const { registry } = createRegistry('sim');
    const app = createApp({ db, registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW });
    jobs = buildJobs({ app, db, registry, market: 'IL', clock: () => NOW, runs: pgRunLog(db), catalogue: loadCatalogueConfig() });
  }, 60_000);
  afterAll(async () => db.close());

  it('schedules each job on the cycle its module declares', () => {
    expect(Object.fromEntries(jobs.map((j) => [j.name, j.everyMs / 1000]))).toEqual({
      'card-token-events': 30,
      'load-sweep': 60,
      'send-sweep': 60,
      'payout-sweep': 60,
      'p2p-release-holds': 60,
      'fx-void-stale': 60,
      'metrics-market': 60,
      'metrics-recon': 60,
      'webhook-replay': 60,
      'fx-refresh-rates': 300,
      'ach-release-holds': 300,
      'us-funding-sweep': 300,
      'p2p-expire-requests': 900,
      'auto-reload': 900,
      'agent-expire-intents': 900,
      monitoring: 3600,
      'esim-usage': 3600,
      'card-release-holds': 3600,
      ...Object.fromEntries(Object.keys(NIGHTLY).map((n) => [n, DAILY_TICK_MS / 1000])),
    });
    // The nightly jobs tick every minute and run once a day at their Israel time.
    expect(NIGHTLY).toEqual({ 'balance-proof': '02:30', 'catalogue-sync': '03:00', 'kyb-rescreen': '05:00', 'kyb-refresh': '05:15', 'partner-recon': '05:30', 'deposit-reconcile': '06:30', 'us-banking-recon': '03:00' });
  });

  it('gives every job a scope: market jobs sweep their own market\'s rows, club jobs run one at a time in the club (T-0028)', () => {
    const byScope = (scope: string) => jobs.filter((j) => j.scope === scope).map((j) => j.name).sort();
    expect(byScope('market')).toEqual(['ach-release-holds', 'auto-reload', 'card-token-events', 'catalogue-sync', 'deposit-reconcile', 'esim-usage', 'kyb-rescreen', 'load-sweep', 'metrics-market', 'p2p-release-holds', 'partner-recon', 'payout-sweep', 'us-banking-recon', 'us-funding-sweep', 'webhook-replay']);
    expect(byScope('club')).toEqual(['agent-expire-intents', 'balance-proof', 'card-release-holds', 'fx-refresh-rates', 'fx-void-stale', 'kyb-refresh', 'metrics-recon', 'monitoring', 'p2p-expire-requests', 'send-sweep']);
    expect(jobs.every((j) => j.scope === 'market' || j.scope === 'club')).toBe(true);
  });

  it('runs one cycle of every job against a fresh schema without an error', async () => {
    const failed: string[] = [];
    for (const j of jobs) {
      await j
        .run()
        .then((v) => results.set(j.name, v))
        .catch((e: unknown) => failed.push(`${j.name}: ${e instanceof Error ? e.message : String(e)}`));
    }
    expect(failed).toEqual([]);
  });

  it('records each nightly run in ops.job_run for its Israel day, so a second tick that day does nothing', async () => {
    const r = await db.query<{ job: string; run_date: string }>(`select job, to_char(run_date, 'YYYY-MM-DD') as run_date from ops.job_run order by job`);
    // The balance proof and the KYB refresh are the club's; the catalogue sync, the KYB rescreen and the deposit
    // reconciliation ask this market's providers, so their runs are keyed by market.
    expect(r.rows).toEqual([
      { job: 'IL:catalogue-sync', run_date: '2026-10-19' },
      { job: 'IL:deposit-reconcile', run_date: '2026-10-19' },
      { job: 'IL:kyb-rescreen', run_date: '2026-10-19' },
      { job: 'IL:partner-recon', run_date: '2026-10-19' },
      { job: 'IL:us-banking-recon', run_date: '2026-10-19' },
      { job: 'balance-proof', run_date: '2026-10-19' },
      { job: 'kyb-refresh', run_date: '2026-10-19' },
    ]);
    const proof = jobs.find((j) => j.name === 'balance-proof')!;
    expect(typeof (await proof.run())).toBe('symbol'); // IDLE: already ran today
    expect((await db.query(`select 1 from ops.case where kind = 'balance_break'`)).rowCount).toBe(0);
  });

  it('asks the market\'s vendors for what config/catalogue.json lists', () => {
    // A fresh schema has no price rules, so the sync sees every package and prices none (REQ-MKT-002).
    expect(results.get('catalogue-sync')).toMatchObject({
      esim: { provider: 'simulator', kind: 'esim', seen: 4, priced: 0 },
      insurance: { provider: 'simulator', kind: 'insurance', seen: 2, priced: 0 },
    });
  });

  it('refuses a catalogue config that is missing, malformed or carries unknown keys', () => {
    expect(() => loadCatalogueConfig(new URL('./no-such.json', CATALOGUE_CONFIG))).toThrow(/ENOENT/);
    const good = loadCatalogueConfig();
    expect(catalogueConfigSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(catalogueConfigSchema.safeParse({ ...good, esim: { countries: ['israel'] } }).success).toBe(false);
    expect(catalogueConfigSchema.safeParse({ ...good, insurance: { products: [] } }).success).toBe(false);
  });
});

// T-0684 (REQ-LED-004): the partner reconciliation rides the nightly loop at 05:30 Israel time, reads yesterday's statement from the
// funding vendor (here the simulator) and opens one case per break before the 06:00 deadline.
describe('partner-recon (T-0684)', () => {
  let rdb: TestDatabase;
  let job: Job;
  let sim: ReturnType<typeof createRegistry>['simulators']['simulators']['funding'];
  let now = new Date('2026-11-10T03:29:00Z'); // 05:29 in Israel
  const runCases = async () => (await rdb.query<{ dedupe_key: string; payload: Record<string, string> }>(`select dedupe_key, payload from ops.case where kind = 'recon_break' order by dedupe_key`)).rows;
  const charge = (minor: bigint, key: string) => sim.createLoad({ customerId: 'c', method: 'card', amount: money(minor, 'USD'), paymentMethodId: 'pm_ok' }, key);

  beforeAll(async () => {
    rdb = await createTestDatabase();
    const simClock = fixedClock('2026-11-09T10:00:00Z') as AdvanceableClock; // the 9th: the day the 10th's run reconciles
    const { registry, simulators } = createRegistry('sim', simClock);
    sim = simulators.simulators.funding;
    const app = createApp({ db: rdb, registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => now });
    job = buildJobs({ app, db: rdb, registry, market: 'IL', clock: () => now, runs: pgRunLog(rdb), catalogue: loadCatalogueConfig() }).find((j) => j.name === 'partner-recon')!;
  }, 60_000);
  afterAll(async () => rdb.close());

  it('waits for 05:30 Israel time, then runs once for the day and opens one case per break', async () => {
    const ghost = await charge(1_234n, 'partner-recon-ghost-1'); // the vendor settled it; we never journaled it
    expect(await job.run()).toBe(IDLE); // 05:29
    now = new Date('2026-11-10T03:30:00Z'); // 05:30
    expect(await job.run()).toMatchObject({ runDate: '2026-11-10', statementDate: '2026-11-09', matched: 0, breaks: 1, withinDeadline: true });
    expect(await runCases()).toEqual([{ dedupe_key: `recon:simulator:${ghost.loadId}:2026-11-10`, payload: expect.objectContaining({ reason: 'missing_journal', externalId: ghost.loadId, partnerMinor: '1234' }) }]);
    now = new Date('2026-11-10T03:45:00Z');
    expect(await job.run()).toBe(IDLE); // a second tick the same day does nothing
    expect(await runCases()).toHaveLength(1);
    expect((await rdb.query(`select 1 from ops.job_run where job = 'IL:partner-recon' and run_date = '2026-11-10'`)).rowCount).toBe(1);
  });

  it('a run that ends after 06:00 reports withinDeadline false and raises the RUN-03 alert', async () => {
    now = new Date('2026-11-11T04:30:00Z'); // 06:30 in Israel: the worker booted late
    expect(await job.run()).toMatchObject({ runDate: '2026-11-11', withinDeadline: false });
    const alert = (await runCases()).filter((c) => c.payload['reason'] === 'deadline_missed');
    expect(alert).toEqual([{ dedupe_key: 'recon:deadline:simulator:2026-11-11', payload: expect.objectContaining({ provider: 'simulator', runDate: '2026-11-11' }) }]);
  });

  it('a statement outage is logged as job_failed, opens no case, records no run, and the next tick retries', async () => {
    const before = (await runCases()).length;
    now = new Date('2026-11-12T03:30:00Z');
    sim.outageAfterPages = 0;
    const logs: { event: string; fields: Record<string, string | number | boolean> }[] = [];
    const scheduler = new Scheduler([job], noLock, (event, fields) => logs.push({ event, fields }));
    scheduler.start();
    await new Promise((r) => setTimeout(r, 200));
    await scheduler.stop();
    expect(logs).toEqual([{ event: 'job_failed', fields: expect.objectContaining({ job: 'partner-recon', error: 'FundingError', code: 'PROVIDER_UNAVAILABLE' }) }]);
    expect(await runCases()).toHaveLength(before);
    expect((await rdb.query(`select 1 from ops.job_run where job = 'IL:partner-recon' and run_date = '2026-11-12'`)).rowCount).toBe(0);
    sim.outageAfterPages = undefined;
    now = new Date('2026-11-12T03:31:00Z');
    expect(await job.run()).toMatchObject({ runDate: '2026-11-12', breaks: 0 });
    expect((await rdb.query(`select 1 from ops.job_run where job = 'IL:partner-recon' and run_date = '2026-11-12'`)).rowCount).toBe(1);
  });
});
