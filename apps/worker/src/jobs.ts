// The worker's job table (T-0022, T-0023, T-0028): every periodic and nightly job, its scope, its cycle or
// Israel time, and the services it runs on. A job that calls a market's providers about rows carrying
// that market is `market`: each market's worker sweeps its own rows, and together they cover every row.
// A job whose work is not split by market (the club rate, monitoring, the balance proof, and tables with
// no market: payment requests, agent intents, plus ledger-only sweeps) is `club`. The cycles
// are each module's own constant, so a job's SLA and its schedule cannot drift apart. `JOB_EXCLUSIONS`
// names every job-like module that is not here and why; jobs.test.ts fails on one that is in neither.
import fs from 'node:fs';
import type { App } from '@kesher/api/app';
import type { Database } from '@kesher/api/db';
import type { EsimPort, FundingPort, FxPort, InsurancePort, Market, NotifyPort, ProviderRegistry } from '@kesher/ports';
import { z } from 'zod';
import { EXPIRE_INTENTS_CYCLE_MS, ExpireIntentsJob } from './agent/expire-intents.ts';
import { CYCLE_MS as TOKEN_EVENTS_CYCLE_MS, TokenEventsJob } from './cards/token-events.ts';
import { CatalogueSync } from './catalogue/sync.ts';
import { EsimUsagePoller } from './esim/usage.ts';
import { REFRESH_CYCLE_MS, RefreshRatesJob } from './fx/refresh-rates.ts';
import { VOID_STALE_CYCLE_MS, VoidStaleConversionsJob } from './fx/void-stale.ts';
import { BalanceProof } from './ledger/balance-proof.ts';
import { MonitoringJob } from './monitoring/job.ts';
import { EXPIRE_CYCLE_MS, ExpireRequestsJob } from './p2p/expire-requests.ts';
import { RELEASE_CYCLE_MS as P2P_RELEASE_CYCLE_MS, P2pReleaseHoldsJob } from './p2p/release-holds.ts';
import { SWEEP_CYCLE_MS as SEND_SWEEP_CYCLE_MS, SendWorkflow } from './p2p/send-workflow.ts';
import { SWEEP_CYCLE_MS as PAYOUT_SWEEP_CYCLE_MS, PayoutWorkflow } from './payouts/payout-workflow.ts';
import { daily, type Job, type RunLog } from './scheduler.ts';
import { AUTO_RELOAD_CYCLE_MS, AutoReloadJob } from './wallet/auto-reload-job.ts';
import { SWEEP_CYCLE_MS as LOAD_SWEEP_CYCLE_MS, LoadWorkflow } from './wallet/load-workflow.ts';
import { RELEASE_CYCLE_MS as ACH_RELEASE_CYCLE_MS, ReleaseHoldsJob } from './wallet/release-holds.ts';

/** Webhook replay (RUN-05): re-drives stored events whose processing failed. */
export const WEBHOOK_REPLAY_CYCLE_MS = 60_000;
/** Transaction monitoring looks back over its rule windows each run; hourly keeps alerts same-hour. */
export const MONITORING_CYCLE_MS = 60 * 60_000;
/** eSIM usage: the 20% and 3-day thresholds move slowly; hourly is ahead of either. */
export const ESIM_USAGE_CYCLE_MS = 60 * 60_000;

/** Nightly jobs and their Israel wall-clock times (T-0023). The balance proof runs before reconciliation,
 *  which joins at 04:00 with the processor adapter, ahead of REQ-LED-004's 06:00 deadline. */
export const NIGHTLY = { 'balance-proof': '02:30', 'catalogue-sync': '03:00' } as const;

/** What the nightly catalogue sync asks the vendors for: `config/catalogue.json`, so nothing is hard-coded. */
export const catalogueConfigSchema = z
  .object({
    esim: z.object({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1) }).strict(),
    insurance: z.object({ products: z.array(z.object({ vendorSku: z.string().min(1), title: z.string().min(1), days: z.number().int().positive() }).strict()).min(1) }).strict(),
  })
  .strict();
export type CatalogueConfig = z.infer<typeof catalogueConfigSchema>;

export const CATALOGUE_CONFIG = new URL('../../../config/catalogue.json', import.meta.url);

/** Reads and checks the catalogue config; a missing or malformed file throws at boot (constitution art. 6). */
export function loadCatalogueConfig(file: URL | string = CATALOGUE_CONFIG): CatalogueConfig {
  return catalogueConfigSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** `ops.job_run`: one row per nightly job and Israel day, written when the run finishes. */
export function pgRunLog(db: Database): RunLog {
  return {
    ranOn: async (job, day) => (await db.query('select 1 from ops.job_run where job = $1 and run_date = $2', [job, day])).rowCount > 0,
    record: async (job, day, startedAt, finishedAt) => {
      await db.query('insert into ops.job_run (job, run_date, started_at, finished_at) values ($1, $2, $3, $4) on conflict do nothing', [job, day, startedAt, finishedAt]);
    },
  };
}

export interface JobDeps {
  app: App;
  db: Database;
  registry: ProviderRegistry;
  market: Market;
  clock: () => Date;
  runs: RunLog;
  catalogue: CatalogueConfig;
}

export function buildJobs({ app, db, registry, market, clock, runs, catalogue }: JobDeps): Job[] {
  const s = app.services;
  const tokenEvents = new TokenEventsJob(s.inbound, (e, now) => s.provisioning.applyTokenEvent(e, now), clock);
  const loads = new LoadWorkflow(s.loads, registry.resolve<FundingPort>('funding', market), clock);
  const sends = new SendWorkflow(s.p2p, clock);
  const payouts = new PayoutWorkflow(s.payouts, clock);
  const p2pHolds = new P2pReleaseHoldsJob(s.p2p, s.transfers, clock);
  const voidStale = new VoidStaleConversionsJob(s.fx, clock);
  const rates = new RefreshRatesJob(registry.resolve<FxPort>('fx', market), s.rates, clock);
  const achHolds = new ReleaseHoldsJob(s.transfers, s.loads, clock);
  const requests = new ExpireRequestsJob(s.requests, clock);
  const autoReload = new AutoReloadJob(s.autoReload, clock);
  const intents = new ExpireIntentsJob(s.intents, clock);
  const monitoring = new MonitoringJob(db, s.flags, clock);
  // One eSIM binding per market; the alert goes to the member's most recently seen device with a push token.
  const esim = new EsimUsagePoller(db, () => registry.resolve<EsimPort>('esim', market), registry.resolve<NotifyPort>('notify', market), async (partyId) => {
    const devices = await s.identity.listDevices(partyId);
    return devices.filter((d) => d.pushToken).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0]?.pushToken;
  }, market);
  const proof = new BalanceProof(db);
  const sync = new CatalogueSync(db, clock);
  const providerOf = (capability: string): string => registry.bindingFor(capability, market)?.provider ?? 'simulator';
  // A market job's nightly run is recorded per market, so the US sync is not skipped because IL ran.
  const marketRuns: RunLog = {
    ranOn: (job, day) => runs.ranOn(`${market}:${job}`, day),
    record: (job, day, startedAt, finishedAt) => runs.record(`${market}:${job}`, day, startedAt, finishedAt),
  };

  return [
    { name: 'card-token-events', scope: 'market', everyMs: TOKEN_EVENTS_CYCLE_MS, run: () => tokenEvents.run() },
    { name: 'load-sweep', scope: 'market', everyMs: LOAD_SWEEP_CYCLE_MS, run: () => loads.sweep() },
    { name: 'send-sweep', scope: 'club', everyMs: SEND_SWEEP_CYCLE_MS, run: () => sends.sweep() },
    { name: 'payout-sweep', scope: 'market', everyMs: PAYOUT_SWEEP_CYCLE_MS, run: () => payouts.sweep() },
    { name: 'p2p-release-holds', scope: 'market', everyMs: P2P_RELEASE_CYCLE_MS, run: () => p2pHolds.run() },
    { name: 'fx-void-stale', scope: 'club', everyMs: VOID_STALE_CYCLE_MS, run: () => voidStale.run() },
    { name: 'webhook-replay', scope: 'market', everyMs: WEBHOOK_REPLAY_CYCLE_MS, run: () => s.webhooks.replay({ now: clock() }) },
    { name: 'fx-refresh-rates', scope: 'club', everyMs: REFRESH_CYCLE_MS, run: () => rates.run() },
    { name: 'ach-release-holds', scope: 'market', everyMs: ACH_RELEASE_CYCLE_MS, run: () => achHolds.run() },
    { name: 'p2p-expire-requests', scope: 'club', everyMs: EXPIRE_CYCLE_MS, run: () => requests.run() },
    { name: 'auto-reload', scope: 'market', everyMs: AUTO_RELOAD_CYCLE_MS, run: () => autoReload.run() },
    { name: 'agent-expire-intents', scope: 'club', everyMs: EXPIRE_INTENTS_CYCLE_MS, run: () => intents.run() },
    { name: 'monitoring', scope: 'club', everyMs: MONITORING_CYCLE_MS, run: () => monitoring.run() },
    { name: 'esim-usage', scope: 'market', everyMs: ESIM_USAGE_CYCLE_MS, run: () => esim.poll(clock()) },
    daily({ name: 'balance-proof', scope: 'club', at: NIGHTLY['balance-proof'], run: (now) => proof.run(now) }, runs, clock),
    daily(
      {
        name: 'catalogue-sync',
        scope: 'market',
        at: NIGHTLY['catalogue-sync'],
        run: async () => ({
          esim: await sync.syncEsim(providerOf('esim'), registry.resolve<EsimPort>('esim', market), catalogue.esim.countries),
          insurance: await sync.syncInsurance(providerOf('insurance'), registry.resolve<InsurancePort>('insurance', market), catalogue.insurance.products),
        }),
      },
      marketRuns,
      clock,
    ),
  ];
}

/** Job-like modules the table leaves out, each with the reason. A path is relative to `apps/worker/src`. */
export const JOB_EXCLUSIONS: Readonly<Record<string, string>> = {
  'cards/issue-workflow.ts': 'started by a KYC approval, not on a cycle',
  'recon/recon.ts': 'nightly at 04:00 once the processor adapter (ADR-006) brings a partner statement source',
};
