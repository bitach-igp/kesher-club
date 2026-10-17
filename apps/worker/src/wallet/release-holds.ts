// Hold release (T-0502, REQ-WAL-003): an ACH load sits in the member's pending purse for the bank's
// hold days; on the release date this job moves it to the wallet, pending → wallet under
// `{workflowId}:release`, and settles the transfer. Exactly once: the journal key is idempotent and the
// state machine refuses a second release. Runs every cycle; a hold is late when it is still pending
// past its date by more than the cycle.
import type { LoadService } from '@kesher/api/wallet/loads';
import type { TransferService } from '@kesher/api/transfers/service';

export const RELEASE_CYCLE_MS = 5 * 60_000;

export interface ReleaseReport {
  ranAt: string;
  attempted: number;
  released: number;
  errors: { transferId: string; error: string }[];
  /** How far past its date the oldest hold still pending is, in ms; over the cycle pages (RUN-05). */
  lagMs: number;
  withinSla: boolean;
}

export class ReleaseHoldsJob {
  constructor(
    private readonly transfers: TransferService,
    private readonly loads: LoadService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(): Promise<ReleaseReport> {
    const now = this.clock();
    const report: ReleaseReport = { ranAt: now.toISOString(), attempted: 0, released: 0, errors: [], lagMs: 0, withinSla: true };
    const due = (await this.transfers.expiredHolds(now)).filter((t) => t.kind === 'load');
    for (const t of due) {
      report.attempted += 1;
      try {
        await this.loads.release(t, now);
        report.released += 1;
      } catch (e) {
        report.errors.push({ transferId: t.id, error: (e as Error).message.slice(0, 200) });
      }
    }
    const left = (await this.transfers.expiredHolds(now)).filter((t) => t.kind === 'load');
    report.lagMs = left.reduce((max, t) => Math.max(max, now.getTime() - Date.parse(t.holdReleasesAt!)), 0);
    report.withinSla = report.lagMs <= RELEASE_CYCLE_MS;
    return report;
  }
}
