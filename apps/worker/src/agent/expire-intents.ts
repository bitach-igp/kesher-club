// Intent expiry (T-1010, REQ-AGT-006): an agent's pending intent waits 24 h for the member's passkey; this
// job runs every cycle and expires the ones past their time, so the member's list and the approve path
// agree. An intent whose money already started under `intent:{id}` (an approval that crashed before its
// status write) is the member's approval and is marked so, never expired. A repeat finds nothing left to
// do; the API also hides and refuses intents past their time, so a lost cycle only delays the record.
import type { IntentService } from '@kesher/api/intents/service';

export const EXPIRE_INTENTS_CYCLE_MS = 15 * 60_000;

export interface ExpireIntentsReport {
  ranAt: string;
  expired: number;
  /** Intents whose money had started: finished as approved. */
  approved: number;
}

export class ExpireIntentsJob {
  constructor(
    private readonly intents: Pick<IntentService, 'expire'>,
    private readonly clock: () => Date = () => new Date(),
    private readonly batch = 500,
  ) {}

  async run(): Promise<ExpireIntentsReport> {
    const now = this.clock();
    let expired = 0;
    let approved = 0;
    for (;;) {
      const r = await this.intents.expire(now, this.batch);
      expired += r.expired;
      approved += r.approved;
      if (r.expired + r.approved < this.batch) break;
    }
    return { ranAt: now.toISOString(), expired, approved };
  }
}
