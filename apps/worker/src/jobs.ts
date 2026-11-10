// The worker's job table (T-0022, T-0023, T-0028): every periodic and nightly job, its scope, its cycle or
// Israel time, and the services it runs on. A job that calls a market's providers about rows carrying
// that market is `market`: each market's worker sweeps its own rows, and together they cover every row.
// A job whose work is not split by market (the club rate, monitoring, the balance proof, and tables with
// no market: payment requests, agent intents, plus ledger-only sweeps) is `club`. The cycles
// are each module's own constant, so a job's SLA and its schedule cannot drift apart. `JOB_EXCLUSIONS`
// names every job-like module that is not here and why; jobs.test.ts fails on one that is in neither.
import fs from 'node:fs';
import type { App } from '@kesher/api/app';
import { cardIssuingProcessor } from '@kesher/api/cards/settlement';
import type { Database } from '@kesher/api/db';
import { US_BANKING_FLAG } from '@kesher/api/institutions/us-banking';
import { FundingError, type BankPort, type EsimPort, type FundingPort, type FundingStatementPort, type FxPort, type InstitutionBankingPort, type InsurancePort, type KybPort, type Market, type NotifyPort, type ProviderRegistry } from '@kesher/ports';
import { guarded, minorToNumber, stdoutMetrics, type Metrics } from '@kesher/domain';
import { z } from 'zod';
import { EXPIRE_INTENTS_CYCLE_MS, ExpireIntentsJob } from './agent/expire-intents.ts';
import { CardHoldReleaseJob, CYCLE_MS as CARD_HOLD_RELEASE_CYCLE_MS } from './cards/release-holds.ts';
import { CYCLE_MS as TOKEN_EVENTS_CYCLE_MS, TokenEventsJob } from './cards/token-events.ts';
import { CatalogueSync } from './catalogue/sync.ts';
import { EsimUsagePoller } from './esim/usage.ts';
import { REFRESH_CYCLE_MS, RefreshRatesJob } from './fx/refresh-rates.ts';
import { VOID_STALE_CYCLE_MS, VoidStaleConversionsJob } from './fx/void-stale.ts';
import { DepositReconcileJob } from './institutions/deposit-reconcile.ts';
import { KybRefresh, KybRescreen } from './institutions/kyb-sweeps.ts';
import { BalanceProof } from './ledger/balance-proof.ts';
import { MonitoringJob } from './monitoring/job.ts';
import { ReconJob } from './recon/recon.ts';
import { FundingStatementSource } from './recon/statement-source.ts';
import { UsBankingRecon } from './recon/us-banking.ts';
import { EXPIRE_CYCLE_MS, ExpireRequestsJob } from './p2p/expire-requests.ts';
import { RELEASE_CYCLE_MS as P2P_RELEASE_CYCLE_MS, P2pReleaseHoldsJob } from './p2p/release-holds.ts';
import { SWEEP_CYCLE_MS as SEND_SWEEP_CYCLE_MS, SendWorkflow } from './p2p/send-workflow.ts';
import { SWEEP_CYCLE_MS as PAYOUT_SWEEP_CYCLE_MS, PayoutWorkflow } from './payouts/payout-workflow.ts';
import { daily, israelClock, type Job, type RunLog } from './scheduler.ts';
import { AUTO_RELOAD_CYCLE_MS, AutoReloadJob } from './wallet/auto-reload-job.ts';
import { SWEEP_CYCLE_MS as LOAD_SWEEP_CYCLE_MS, LoadWorkflow } from './wallet/load-workflow.ts';
import { RELEASE_CYCLE_MS as ACH_RELEASE_CYCLE_MS, ReleaseHoldsJob } from './wallet/release-holds.ts';

/** Webhook replay (RUN-05): re-drives stored events whose processing failed. */
export const WEBHOOK_REPLAY_CYCLE_MS = 60_000;
/** Transaction monitoring looks back over its rule windows each run; hourly keeps alerts same-hour. */
export const MONITORING_CYCLE_MS = 60 * 60_000;
/** eSIM usage: the 20% and 3-day thresholds move slowly; hourly is ahead of either. */
export const ESIM_USAGE_CYCLE_MS = 60 * 60_000;

/** Nightly jobs and their Israel wall-clock times (T-0023). The balance proof runs before reconciliation. The partner
 *  reconciliation (T-0684) reads the funding vendor's statement for yesterday at 05:30, half an hour ahead of REQ-LED-004's 06:00 deadline. The KYB rescreen
 *  and refresh (T-0624) run before the working day, so a payout that morning meets the day's answer. The
 *  deposit reconciliation (T-0618) reads yesterday's bank statement once the bank has closed the day. */
export const NIGHTLY = { 'balance-proof': '02:30', 'catalogue-sync': '03:00', 'kyb-rescreen': '05:00', 'kyb-refresh': '05:15', 'partner-recon': '05:30', 'deposit-reconcile': '06:30', 'us-banking-recon': '03:00' } as const;

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
  /** Where the sweep's gauges go (T-0053); stdout by default. */
  metrics?: Metrics;
}

/** The gauges that need a look at the database (T-0053) are read once a minute. */
export const METRICS_SWEEP_CYCLE_MS = 60_000;

/**
 * Open reconciliation breaks (RUN-03: over $50, or aged over 24 h). Open means an `ops.case` of kind `recon_break` that is `open` or
 * `investigating`; breaks come from two writers, the nightly recon (an `ops.recon_break` row with both amounts) and the US banking
 * recon (a case with the amounts only in its payload: `amount`, or `provider` and `recorded`).
 * `recon.break_oldest_h` is the age in hours of the oldest such case, whatever its currency or source (unit `None`: CloudWatch has no hour unit).
 * `recon.break_open_usd` is the sum, in whole dollars as a number made from bigint minor units with `minorToNumber`, of the USD amount of
 * those cases: |partner - ledger| when both sides are USD (a missing side counts as 0), or the payload's USD amount. A break whose two sides
 * are in different currencies, or in another currency, is left out of the USD figure, never subtracted across currencies. It is a monitoring
 * number, never money: nothing reads it back into the ledger. Both are 0 with none open.
 */
export async function reportReconBreaks(db: Database, metrics: Metrics, now: Date): Promise<{ openUsdMinor: bigint; oldestHours: number }> {
  const r = await db.query<{ usd_minor: string; oldest: string | Date | null }>(
    `with open_case as (select id, opened_at, payload from ops.case where kind = 'recon_break' and status in ('open', 'investigating')),
          amounts as (
            select abs(coalesce(b.partner_minor, 0) - coalesce(b.ledger_minor, 0)) as minor
              from ops.recon_break b join open_case c on c.id = b.case_id
             where coalesce(b.partner_currency, b.ledger_currency) = 'USD' and coalesce(b.ledger_currency, b.partner_currency) = 'USD'
            union all
            select abs((c.payload->'provider'->>'minor')::bigint - (c.payload->'recorded'->>'minor')::bigint)
              from open_case c
             where not exists (select 1 from ops.recon_break b where b.case_id = c.id) and c.payload->'provider'->>'currency' = 'USD' and c.payload->'recorded'->>'currency' = 'USD'
            union all
            select (c.payload->'amount'->>'minor')::bigint
              from open_case c
             where not exists (select 1 from ops.recon_break b where b.case_id = c.id) and c.payload->'amount'->>'currency' = 'USD'
          )
     select (select coalesce(sum(minor), 0)::text from amounts) as usd_minor, (select min(opened_at) from open_case) as oldest`,
  );
  const openUsdMinor = BigInt(r.rows[0]?.usd_minor ?? '0');
  const oldest = r.rows[0]?.oldest;
  const oldestHours = oldest ? Math.max(0, now.getTime() - new Date(oldest).getTime()) / 3_600_000 : 0;
  metrics.reconBreakOpenUsd(minorToNumber(openUsdMinor));
  metrics.reconBreakOldestHours(oldestHours);
  return { openUsdMinor, oldestHours };
}

/** US funding (T-0653): approved requests not yet sent are sent, and sent ones the bank has not finished are asked about. */
const US_FUNDING_SWEEP_CYCLE_MS = 5 * 60_000;

export function buildJobs({ app, db, registry, market, clock, runs, catalogue, metrics: injected }: JobDeps): Job[] {
  const s = app.services;
  const metrics = guarded(injected ?? stdoutMetrics);
  const tokenEvents = new TokenEventsJob(s.inbound, cardIssuingProcessor({ provisioning: s.provisioning, settlement: s.settlement }), clock);
  const cardHolds = new CardHoldReleaseJob(s.settlement, clock);
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
  const rescreen = new KybRescreen(db, s.institutionKyb, s.flags, registry.resolve<KybPort>('kyb', market), providerOf('kyb'), market, clock);
  const refresh = new KybRefresh(s.institutionKyb, clock);
  // Resolved when it runs: a market with no bank bound yet (ADR-006) keeps the feed off and never asks.
  const depositRecon = new DepositReconcileJob(s.deposits, () => registry.resolve<BankPort>('bank', market), providerOf('bank'));
  // The US accounts' payments and transactions for yesterday against our records (T-0654); resolved when it runs.
  const usRecon = new UsBankingRecon(db, s.flags, s.usCollections, () => registry.resolve<InstitutionBankingPort>('institution-banking', market), market, clock);
  // The funding vendor's statement for yesterday against our ledger (T-0684, REQ-LED-004). The port and its provider name are
  // resolved when it runs (the provider is the key space of ops.external_ref, as in the load and closure services); a funding
  // port with no statement listing fails the run, so it is logged and retried rather than reconciling nothing.
  const fundingStatement = (): FundingStatementPort => {
    const port = registry.resolve<FundingPort & Partial<FundingStatementPort>>('funding', market);
    if (typeof port.listSettled !== 'function') throw new FundingError('VALIDATION_FAILED', 'The funding port lists no statement');
    return { listSettled: (input) => port.listSettled!(input) };
  };
  const partnerRecon = async (now: Date): Promise<unknown> => {
    const provider = providerOf('funding');
    const today = israelClock(now).day;
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const report = await new ReconJob(db, new FundingStatementSource({ provider, port: fundingStatement() }), clock).run(provider, today, yesterday);
    // Counts only: the breaks themselves are the cases (and their amounts), not the log line.
    return { runDate: report.runDate, statementDate: report.statementDate, matched: report.matched, breaks: report.breaks.length, withinDeadline: report.withinDeadline };
  };
  // A market job's nightly run is recorded per market, so the US sync is not skipped because IL ran.
  const marketRuns: RunLog = {
    ranOn: (job, day) => runs.ranOn(`${market}:${job}`, day),
    record: (job, day, startedAt, finishedAt) => runs.record(`${market}:${job}`, day, startedAt, finishedAt),
  };

  return [
    // The periodic gauges the runbooks alert on (T-0053): webhook lag and stuck transfers per market, reconciliation breaks for the club.
    { name: 'metrics-market', scope: 'market', everyMs: METRICS_SWEEP_CYCLE_MS, run: async () => ({ lagMs: await s.inbound.reportLag(clock()), stuck: (await s.transfers.reportStuck(clock())).length }) },
    { name: 'metrics-recon', scope: 'club', everyMs: METRICS_SWEEP_CYCLE_MS, run: () => reportReconBreaks(db, metrics, clock()) },
    { name: 'card-token-events', scope: 'market', everyMs: TOKEN_EVENTS_CYCLE_MS, run: () => tokenEvents.run() },
    { name: 'load-sweep', scope: 'market', everyMs: LOAD_SWEEP_CYCLE_MS, run: () => loads.sweep() },
    { name: 'send-sweep', scope: 'club', everyMs: SEND_SWEEP_CYCLE_MS, run: () => sends.sweep() },
    { name: 'payout-sweep', scope: 'market', everyMs: PAYOUT_SWEEP_CYCLE_MS, run: () => payouts.sweep() },
    { name: 'p2p-release-holds', scope: 'market', everyMs: P2P_RELEASE_CYCLE_MS, run: () => p2pHolds.run() },
    { name: 'fx-void-stale', scope: 'club', everyMs: VOID_STALE_CYCLE_MS, run: () => voidStale.run() },
    { name: 'webhook-replay', scope: 'market', everyMs: WEBHOOK_REPLAY_CYCLE_MS, run: () => s.webhooks.replay({ now: clock() }) },
    { name: 'fx-refresh-rates', scope: 'club', everyMs: REFRESH_CYCLE_MS, run: () => rates.run() },
    { name: 'ach-release-holds', scope: 'market', everyMs: ACH_RELEASE_CYCLE_MS, run: () => achHolds.run() },
    { name: 'us-funding-sweep', scope: 'market', everyMs: US_FUNDING_SWEEP_CYCLE_MS, run: async () => ((await s.flags.isOn(US_BANKING_FLAG)) ? s.usFunding.sweep(market, clock()) : { sent: 0, polled: 0, errors: 0, blocked: 0, errorClasses: [] }) },
    { name: 'p2p-expire-requests', scope: 'club', everyMs: EXPIRE_CYCLE_MS, run: () => requests.run() },
    { name: 'auto-reload', scope: 'market', everyMs: AUTO_RELOAD_CYCLE_MS, run: () => autoReload.run() },
    { name: 'agent-expire-intents', scope: 'club', everyMs: EXPIRE_INTENTS_CYCLE_MS, run: () => intents.run() },
    { name: 'monitoring', scope: 'club', everyMs: MONITORING_CYCLE_MS, run: () => monitoring.run() },
    { name: 'card-release-holds', scope: 'club', everyMs: CARD_HOLD_RELEASE_CYCLE_MS, run: () => cardHolds.run() },
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
    daily({ name: 'kyb-rescreen', scope: 'market', at: NIGHTLY['kyb-rescreen'], run: () => rescreen.run() }, marketRuns, clock),
    daily({ name: 'kyb-refresh', scope: 'club', at: NIGHTLY['kyb-refresh'], run: (now) => refresh.run(now) }, runs, clock),
    daily({ name: 'partner-recon', scope: 'market', at: NIGHTLY['partner-recon'], run: partnerRecon }, marketRuns, clock),
    daily({ name: 'deposit-reconcile', scope: 'market', at: NIGHTLY['deposit-reconcile'], run: (now) => depositRecon.run(now) }, marketRuns, clock),
    daily({ name: 'us-banking-recon', scope: 'market', at: NIGHTLY['us-banking-recon'], run: (now) => usRecon.run(now) }, marketRuns, clock),
  ];
}

/** Job-like modules the table leaves out, each with the reason. A path is relative to `apps/worker/src`. */
export const JOB_EXCLUSIONS: Readonly<Record<string, string>> = {
  'cards/issue-workflow.ts': 'started by a KYC approval, not on a cycle',
};
