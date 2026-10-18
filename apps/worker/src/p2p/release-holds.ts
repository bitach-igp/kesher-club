// P2P hold release (T-0506, REQ-PAY-003): a first send over ₪500 to a new counterparty waits two hours
// in pending_hold; this job runs every cycle and resumes the SendWorkflow for every hold whose time has
// passed, which releases the reserved money to the recipient, settles the send, records the plan's usage
// and tells the recipient. Exactly once: the release journal and the notification are keyed by the
// workflow id and the state machine refuses a second release.
import { runSend, type P2pSendService } from '@kesher/api/p2p/send';
import type { TransferService } from '@kesher/api/transfers/service';

export const RELEASE_CYCLE_MS = 60_000;

export interface ReleaseReport {
  ranAt: string;
  attempted: number;
  released: number;
  errors: { transferId: string; error: string }[];
  /** How far past its time the oldest hold still pending is, in ms; over the cycle pages (RUN-05). */
  lagMs: number;
  withinSla: boolean;
}

export class P2pReleaseHoldsJob {
  constructor(
    private readonly send: P2pSendService,
    private readonly transfers: TransferService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(): Promise<ReleaseReport> {
    const now = this.clock();
    const report: ReleaseReport = { ranAt: now.toISOString(), attempted: 0, released: 0, errors: [], lagMs: 0, withinSla: true };
    for (const t of (await this.transfers.expiredHolds(now)).filter((x) => x.kind === 'p2p')) {
      report.attempted += 1;
      try {
        const r = await runSend(this.send, { fromPartyId: t.fromPartyId!, toPartyId: t.toPartyId!, amount: t.amount, ...(t.note ? { note: t.note } : {}) }, t.idempotencyKey, now);
        if (r.transfer.state === 'settled') report.released += 1;
      } catch (e) {
        report.errors.push({ transferId: t.id, error: (e as Error).message.slice(0, 200) });
      }
    }
    const left = (await this.transfers.expiredHolds(now)).filter((x) => x.kind === 'p2p');
    report.lagMs = left.reduce((max, t) => Math.max(max, now.getTime() - Date.parse(t.holdReleasesAt!)), 0);
    report.withinSla = report.lagMs <= RELEASE_CYCLE_MS;
    return report;
  }
}
