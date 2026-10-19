// PayoutWorkflow host (T-0510, REQ-PO-001/002, SEQ-09): one run per Idempotency-Key, which is the workflow
// id, the transfer's key, the journal's key and the vendor pull's key. The deterministic body is
// `runPayout` (apps/api/src/payouts/service.ts); this side hosts it for Temporal (ADR-002) and adds the
// sweep that resumes payouts whose 24 h cooling-off ended or whose second approval landed, so a payout
// never waits on a lost timer. Settlement and failure arrive by webhook and are applied by the API.
import { runPayout, type PayoutInput, type PayoutRun, type PayoutService } from '@kesher/api/payouts/service';

export const SWEEP_CYCLE_MS = 60_000;

export interface SweepReport {
  ranAt: string;
  attempted: number;
  submitted: number;
  stillWaiting: number;
  errors: { transferId: string; error: string }[];
}

export class PayoutWorkflow {
  private readonly payouts: PayoutService;
  private readonly clock: () => Date;
  constructor(
    payouts: PayoutService,
    clock: () => Date = () => new Date(),
  ) {
    this.payouts = payouts;
    this.clock = clock;
  }

  /** Starts, or resumes, the run whose id is `workflowId`. */
  run(input: PayoutInput, workflowId: string): Promise<PayoutRun> {
    return runPayout(this.payouts, input, workflowId, this.clock());
  }

  /** Resumes every payout whose wait is over; a repeat changes nothing. */
  async sweep(limit = 100): Promise<SweepReport> {
    const now = this.clock();
    const report: SweepReport = { ranAt: now.toISOString(), attempted: 0, submitted: 0, stillWaiting: 0, errors: [] };
    for (const t of await this.payouts.resumable(now, limit)) {
      report.attempted += 1;
      try {
        const r = await runPayout(this.payouts, await this.payouts.inputFor(t), t.idempotencyKey, now);
        if (r.waiting) report.stillWaiting += 1;
        else report.submitted += 1;
      } catch (e) {
        report.errors.push({ transferId: t.id, error: (e as Error).message.slice(0, 200) });
      }
    }
    return report;
  }
}
