// Request expiry (T-0507, REQ-PAY-004): a payment request is payable for 14 days; this job runs every
// cycle and marks open requests past their time expired, so the inbox and the pay path agree. A repeat
// finds nothing left to do. The API also expires on read, so a lost cycle only delays the inbox view.
import type { PaymentRequestService } from '@kesher/api/p2p/requests';

export const EXPIRE_CYCLE_MS = 15 * 60_000;

export interface ExpireReport {
  ranAt: string;
  expired: number;
}

export class ExpireRequestsJob {
  private readonly requests: PaymentRequestService;
  private readonly clock: () => Date;
  private readonly batch: number;
  constructor(
    requests: PaymentRequestService,
    clock: () => Date = () => new Date(),
    batch = 500,
  ) {
    this.requests = requests;
    this.clock = clock;
    this.batch = batch;
  }

  async run(): Promise<ExpireReport> {
    const now = this.clock();
    let expired = 0;
    for (;;) {
      const n = await this.requests.expireDue(now, this.batch);
      expired += n;
      if (n < this.batch) break;
    }
    return { ranAt: now.toISOString(), expired };
  }
}
