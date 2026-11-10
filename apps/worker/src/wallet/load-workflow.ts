// LoadWorkflow host (T-0501, REQ-WAL-002, SEQ-02): one run per Idempotency-Key, which is the workflow
// id, the transfer's key and the key of the vendor pull, so however often it runs there is one pull
// and one settlement journal. The deterministic body is `runLoad` (apps/api/src/wallet/loads.ts); this
// side hosts it for Temporal (ADR-002) and adds what only the worker does: the sweep that asks the
// vendor about loads whose webhook never came, so a member's money is never stuck on a lost event.
import { applyVendorState, runLoad, type LoadInput, type LoadRun, type LoadService } from '@kesher/api/wallet/loads';
import type { Transfer } from '@kesher/api/transfers/service';
import { FundingError, type FundingPort } from '@kesher/ports';

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
  /** How many times the sweep asked the vendor about a load, counting a failed read and the read inside `release` (T-0681). */
  vendorReads: number;
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
    const report: SweepReport = { ranAt: now.toISOString(), attempted: 0, settled: 0, failed: 0, held: 0, open: 0, vendorReads: 0, errors: [] };
    // Reads made by this sweep's own call plus the release step's (a `pending` load resumed here is read again inside `release`).
    const releaseReadsBefore = this.loads.vendorReads;
    for (const t of await this.loads.stale(now, olderThanMs, limit)) {
      report.attempted += 1;
      try {
        const after = await this.resume(t, now, () => void (report.vendorReads += 1));
        if (after.state === 'settled') report.settled += 1;
        else if (after.state === 'failed') report.failed += 1;
        else if (after.state === 'pending_hold') report.held += 1;
        else report.open += 1;
      } catch (e) {
        report.errors.push({ transferId: t.id, error: (e as Error).message.slice(0, 200) });
      }
    }
    report.vendorReads += this.loads.vendorReads - releaseReadsBefore;
    return report;
  }

  private async resume(t: Transfer, now: Date, asked: () => void): Promise<Transfer> {
    const loadId = await this.loads.vendorLoadOf(t.id);
    if (!loadId) return t; // submitted but the pull never returned: the member's rerun with the same key completes it
    asked();
    let load;
    try {
      load = await this.port.getLoad(loadId);
    } catch (e) {
      // A held load the vendor does not know is a case for people, with its marker, as in `release` (T-0558); any other load keeps throwing.
      if (t.state === 'pending_hold' && e instanceof FundingError && e.code === 'UNKNOWN_LOAD') {
        await this.loads.holdUnknown(t, loadId, now);
        return t;
      }
      throw e;
    }
    // A held load is asked about once per HELD_RECHECK_MS (T-0558): note this read so the next sweeps leave it alone.
    // Not a `failed` answer: if failing the load then throws, it must be asked again next cycle.
    if (t.state === 'pending_hold' && load.status !== 'failed') await this.loads.recordAsked(t.id, now);
    return (await applyVendorState(this.loads, t, load, t.idempotencyKey, now)).transfer;
  }
}
