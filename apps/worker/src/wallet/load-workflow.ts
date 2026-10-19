// LoadWorkflow host (T-0501, REQ-WAL-002, SEQ-02): one run per Idempotency-Key, which is the workflow
// id, the transfer's key and the key of the vendor pull, so however often it runs there is one pull
// and one settlement journal. The deterministic body is `runLoad` (apps/api/src/wallet/loads.ts); this
// side hosts it for Temporal (ADR-002) and adds what only the worker does: the sweep that asks the
// vendor about loads whose webhook never came, so a member's money is never stuck on a lost event.
import { applyVendorState, runLoad, type LoadInput, type LoadRun, type LoadService } from '@kesher/api/wallet/loads';
import type { Transfer } from '@kesher/api/transfers/service';
import type { FundingPort } from '@kesher/ports';

export const SWEEP_CYCLE_MS = 60_000;
/** A load the vendor has not confirmed within this long is asked about directly. */
export const STALE_AFTER_MS = 10 * 60_000;

export interface SweepReport {
  ranAt: string;
  attempted: number;
  settled: number;
  failed: number;
  held: number;
  /** Still with the vendor after the run (processing or awaiting the member). */
  open: number;
  errors: { transferId: string; error: string }[];
}

export class LoadWorkflow {
  private readonly loads: LoadService;
  private readonly port: FundingPort;
  private readonly clock: () => Date;
  constructor(
    loads: LoadService,
    port: FundingPort,
    clock: () => Date = () => new Date(),
  ) {
    this.loads = loads;
    this.port = port;
    this.clock = clock;
  }

  /** Starts, or resumes, the run whose id is `workflowId`. */
  run(input: LoadInput, workflowId: string): Promise<LoadRun> {
    return runLoad(this.loads, input, workflowId, this.clock());
  }

  /** Loads left submitted past STALE_AFTER_MS: the vendor's view of each is applied; a repeat is a no-op. */
  async sweep(olderThanMs = STALE_AFTER_MS, limit = 100): Promise<SweepReport> {
    const now = this.clock();
    const report: SweepReport = { ranAt: now.toISOString(), attempted: 0, settled: 0, failed: 0, held: 0, open: 0, errors: [] };
    for (const t of await this.loads.stale(now, olderThanMs, limit)) {
      report.attempted += 1;
      try {
        const after = await this.resume(t, now);
        if (after.state === 'settled') report.settled += 1;
        else if (after.state === 'failed') report.failed += 1;
        else if (after.state === 'pending_hold') report.held += 1;
        else report.open += 1;
      } catch (e) {
        report.errors.push({ transferId: t.id, error: (e as Error).message.slice(0, 200) });
      }
    }
    return report;
  }

  private async resume(t: Transfer, now: Date): Promise<Transfer> {
    const loadId = await this.loads.vendorLoadOf(t.id);
    if (!loadId) return t; // submitted but the pull never returned: the member's rerun with the same key completes it
    const load = await this.port.getLoad(loadId);
    return (await applyVendorState(this.loads, t, load, t.idempotencyKey, now)).transfer;
  }
}
