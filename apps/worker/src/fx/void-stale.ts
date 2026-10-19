// Void stale conversions (T-0520, SEQ-08, ADR-014 decision 7): a conversion whose vendor call failed with
// an outage stays submitted so the member's retry with the same key can finish it while the quote lives.
// Once no quote can still be alive for it, this sweep fails it with QUOTE_EXPIRED and posts nothing, so no
// conversion stays submitted for ever. Runs every minute; idempotent across runs.
import type { FxService } from '@kesher/api/fx/service';

export const VOID_STALE_CYCLE_MS = 60_000;

export interface VoidStaleReport {
  ranAt: string;
  voided: string[];
}

export class VoidStaleConversionsJob {
  private readonly fx: Pick<FxService, 'voidStale'>;
  private readonly clock: () => Date;
  constructor(
    fx: Pick<FxService, 'voidStale'>,
    clock: () => Date = () => new Date(),
  ) {
    this.fx = fx;
    this.clock = clock;
  }

  async run(): Promise<VoidStaleReport> {
    const now = this.clock();
    const voided = await this.fx.voidStale(now);
    return { ranAt: now.toISOString(), voided: voided.map((t) => t.id) };
  }
}
