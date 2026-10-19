// SendWorkflow host (T-0505, REQ-PAY-001/005): one run per Idempotency-Key, which is the workflow id,
// the transfer's key and the journal's key, so however often it runs there is one transfer and one
// journal. The deterministic body is `runSend` (apps/api/src/p2p/send.ts); this side hosts it for
// Temporal (ADR-002) and adds the sweep: a send left submitted (the process died between the journal
// and the settle, or before the recipient was told) is finished on the next cycle, with the same keys.
import { runSend, type P2pSendService, type SendInput, type SendRun } from '@kesher/api/p2p/send';

export const SWEEP_CYCLE_MS = 60_000;
/** A send still submitted after this long is finished by the sweep. */
export const STALE_AFTER_MS = 60_000;

export interface SweepReport {
  ranAt: string;
  attempted: number;
  settled: number;
  errors: { transferId: string; error: string }[];
}

export class SendWorkflow {
  private readonly send: P2pSendService;
  private readonly clock: () => Date;
  constructor(
    send: P2pSendService,
    clock: () => Date = () => new Date(),
  ) {
    this.send = send;
    this.clock = clock;
  }

  /** Starts, or resumes, the run whose id is `workflowId`. */
  run(input: SendInput, workflowId: string): Promise<SendRun> {
    return runSend(this.send, input, workflowId, this.clock());
  }

  /** Finishes P2P sends left submitted past STALE_AFTER_MS; every step is keyed, so a repeat changes nothing. */
  async sweep(olderThanMs = STALE_AFTER_MS, limit = 100): Promise<SweepReport> {
    const now = this.clock();
    const report: SweepReport = { ranAt: now.toISOString(), attempted: 0, settled: 0, errors: [] };
    for (const t of await this.send.stale(now, olderThanMs, limit)) {
      report.attempted += 1;
      try {
        const r = await runSend(this.send, { fromPartyId: t.fromPartyId!, toPartyId: t.toPartyId!, amount: t.amount, ...(t.note ? { note: t.note } : {}) }, t.idempotencyKey, now);
        if (r.transfer.state === 'settled') report.settled += 1;
      } catch (e) {
        report.errors.push({ transferId: t.id, error: (e as Error).message.slice(0, 200) });
      }
    }
    return report;
  }
}
