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
import { DAILY_TICK_MS, type Job } from './scheduler.ts';

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
      'webhook-replay': 60,
      'fx-refresh-rates': 300,
      'ach-release-holds': 300,
      'p2p-expire-requests': 900,
      'auto-reload': 900,
      'agent-expire-intents': 900,
      monitoring: 3600,
      'esim-usage': 3600,
      'card-release-holds': 3600,
      ...Object.fromEntries(Object.keys(NIGHTLY).map((n) => [n, DAILY_TICK_MS / 1000])),
    });
    // The nightly jobs tick every minute and run once a day at their Israel time.
    expect(NIGHTLY).toEqual({ 'balance-proof': '02:30', 'catalogue-sync': '03:00', 'kyb-rescreen': '05:00', 'kyb-refresh': '05:15', 'deposit-reconcile': '06:30' });
  });

  it('gives every job a scope: market jobs sweep their own market\'s rows, club jobs run one at a time in the club (T-0028)', () => {
    const byScope = (scope: string) => jobs.filter((j) => j.scope === scope).map((j) => j.name).sort();
    expect(byScope('market')).toEqual(['ach-release-holds', 'auto-reload', 'card-token-events', 'catalogue-sync', 'deposit-reconcile', 'esim-usage', 'kyb-rescreen', 'load-sweep', 'p2p-release-holds', 'payout-sweep', 'webhook-replay']);
    expect(byScope('club')).toEqual(['agent-expire-intents', 'balance-proof', 'card-release-holds', 'fx-refresh-rates', 'fx-void-stale', 'kyb-refresh', 'monitoring', 'p2p-expire-requests', 'send-sweep']);
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
