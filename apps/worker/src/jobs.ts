// The worker's job table (T-0022): every periodic job, its cycle, and the services it runs on. The cycles
// are each module's own constant, so a job's SLA and its schedule cannot drift apart. `JOB_EXCLUSIONS`
// names every job-like module that is not here and why; jobs.test.ts fails on one that is in neither.
import type { App } from '@kesher/api/app';
import type { Database } from '@kesher/api/db';
import type { EsimPort, FundingPort, FxPort, Market, NotifyPort, ProviderRegistry } from '@kesher/ports';
import { EXPIRE_INTENTS_CYCLE_MS, ExpireIntentsJob } from './agent/expire-intents.ts';
import { CYCLE_MS as TOKEN_EVENTS_CYCLE_MS, TokenEventsJob } from './cards/token-events.ts';
import { EsimUsagePoller } from './esim/usage.ts';
import { REFRESH_CYCLE_MS, RefreshRatesJob } from './fx/refresh-rates.ts';
import { VOID_STALE_CYCLE_MS, VoidStaleConversionsJob } from './fx/void-stale.ts';
import { MonitoringJob } from './monitoring/job.ts';
import { EXPIRE_CYCLE_MS, ExpireRequestsJob } from './p2p/expire-requests.ts';
import { RELEASE_CYCLE_MS as P2P_RELEASE_CYCLE_MS, P2pReleaseHoldsJob } from './p2p/release-holds.ts';
import { SWEEP_CYCLE_MS as SEND_SWEEP_CYCLE_MS, SendWorkflow } from './p2p/send-workflow.ts';
import { SWEEP_CYCLE_MS as PAYOUT_SWEEP_CYCLE_MS, PayoutWorkflow } from './payouts/payout-workflow.ts';
import type { Job } from './scheduler.ts';
import { AUTO_RELOAD_CYCLE_MS, AutoReloadJob } from './wallet/auto-reload-job.ts';
import { SWEEP_CYCLE_MS as LOAD_SWEEP_CYCLE_MS, LoadWorkflow } from './wallet/load-workflow.ts';
import { RELEASE_CYCLE_MS as ACH_RELEASE_CYCLE_MS, ReleaseHoldsJob } from './wallet/release-holds.ts';

/** Webhook replay (RUN-05): re-drives stored events whose processing failed. */
export const WEBHOOK_REPLAY_CYCLE_MS = 60_000;
/** Transaction monitoring looks back over its rule windows each run; hourly keeps alerts same-hour. */
export const MONITORING_CYCLE_MS = 60 * 60_000;
/** eSIM usage: the 20% and 3-day thresholds move slowly; hourly is ahead of either. */
export const ESIM_USAGE_CYCLE_MS = 60 * 60_000;

export interface JobDeps {
  app: App;
  db: Database;
  registry: ProviderRegistry;
  market: Market;
  clock: () => Date;
}

export function buildJobs({ app, db, registry, market, clock }: JobDeps): Job[] {
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
  });

  return [
    { name: 'card-token-events', everyMs: TOKEN_EVENTS_CYCLE_MS, run: () => tokenEvents.run() },
    { name: 'load-sweep', everyMs: LOAD_SWEEP_CYCLE_MS, run: () => loads.sweep() },
    { name: 'send-sweep', everyMs: SEND_SWEEP_CYCLE_MS, run: () => sends.sweep() },
    { name: 'payout-sweep', everyMs: PAYOUT_SWEEP_CYCLE_MS, run: () => payouts.sweep() },
    { name: 'p2p-release-holds', everyMs: P2P_RELEASE_CYCLE_MS, run: () => p2pHolds.run() },
    { name: 'fx-void-stale', everyMs: VOID_STALE_CYCLE_MS, run: () => voidStale.run() },
    { name: 'webhook-replay', everyMs: WEBHOOK_REPLAY_CYCLE_MS, run: () => s.webhooks.replay({ now: clock() }) },
    { name: 'fx-refresh-rates', everyMs: REFRESH_CYCLE_MS, run: () => rates.run() },
    { name: 'ach-release-holds', everyMs: ACH_RELEASE_CYCLE_MS, run: () => achHolds.run() },
    { name: 'p2p-expire-requests', everyMs: EXPIRE_CYCLE_MS, run: () => requests.run() },
    { name: 'auto-reload', everyMs: AUTO_RELOAD_CYCLE_MS, run: () => autoReload.run() },
    { name: 'agent-expire-intents', everyMs: EXPIRE_INTENTS_CYCLE_MS, run: () => intents.run() },
    { name: 'monitoring', everyMs: MONITORING_CYCLE_MS, run: () => monitoring.run() },
    { name: 'esim-usage', everyMs: ESIM_USAGE_CYCLE_MS, run: () => esim.poll(clock()) },
  ];
}

/** Job-like modules the table leaves out, each with the reason. A path is relative to `apps/worker/src`. */
export const JOB_EXCLUSIONS: Readonly<Record<string, string>> = {
  'allowance/workflow.ts': 'started per schedule by the funder endpoint (T-0607), not on a cycle',
  'cards/issue-workflow.ts': 'started by a KYC approval, not on a cycle',
  'catalogue/sync.ts': 'nightly (T-0023)',
  'ledger/balance-proof.ts': 'nightly (T-0023)',
  'recon/recon.ts': 'nightly against a statement source (T-0023)',
};
