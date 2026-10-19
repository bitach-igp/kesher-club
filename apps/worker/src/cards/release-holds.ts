// Card hold release (T-0410, REQ-CRD-003, ADR-014 decision 9): an approved authorisation holds money in
// the member's pending purse until the processor clears it. This job runs every hour and releases every
// hold nobody cleared within 7 days back to the purse that paid it. Exactly once: the release and a
// clearing share the key `jit:{authId}:end`, so whichever posts first ends the hold.
import { HOLD_RELEASE_MS, type CardSettlementService } from '@kesher/api/cards/settlement';

export const CYCLE_MS = 3_600_000;

export interface CardHoldReleaseReport {
  ranAt: string;
  released: number;
  errors: { authId: string; error: string }[];
  /** How far past its 7 days the oldest hold still open is, in ms; over a cycle pages (RUN-05). */
  lagMs: number;
  withinSla: boolean;
}

export class CardHoldReleaseJob {
  private readonly settlement: Pick<CardSettlementService, 'releaseExpired'>;
  private readonly clock: () => Date;
  constructor(settlement: Pick<CardSettlementService, 'releaseExpired'>, clock: () => Date = () => new Date()) {
    this.settlement = settlement;
    this.clock = clock;
  }

  async run(): Promise<CardHoldReleaseReport> {
    const now = this.clock();
    const r = await this.settlement.releaseExpired(now);
    const lagMs = Math.max(0, r.oldestOpenMs - HOLD_RELEASE_MS);
    return { ranAt: now.toISOString(), released: r.released, errors: r.errors, lagMs, withinSla: lagMs <= CYCLE_MS };
  }
}
