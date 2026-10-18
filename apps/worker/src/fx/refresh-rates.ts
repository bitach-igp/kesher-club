// Refresh rates job (T-0513, REQ-FX-003/004, ADR-007): every five minutes, asks the FX port for its mid
// on each pair and publishes it as the club rate for the next fifteen, so three refreshes fit inside
// one window and a single missed one still leaves a valid rate. An active manual rate wins: the service
// publishes nothing while one stands. A port outage publishes nothing and is reported; the previous rate
// runs out on its own and quotes refuse until the port is back (REQ-FX-004), which is the safe failure.
import { money, type Currency } from '@kesher/domain';
import type { FxPort } from '@kesher/ports';
import { PAIRS, type ClubRate, type RatePair, type RateService } from '@kesher/api/fx/rates';

export const REFRESH_CYCLE_MS = 5 * 60_000;
/** One unit of the base currency: the port's rate for it is the mid, markup 0. */
const ONE_UNIT_MINOR = 100n;

export interface RefreshReport {
  ranAt: string;
  published: { pair: RatePair; version: number; mid: string }[];
  /** Pairs skipped because a manual rate is active. */
  manual: RatePair[];
  errors: { pair: RatePair; error: string }[];
}

const base = (pair: RatePair): { from: Currency; to: Currency } => {
  const [from, to] = pair.split('/') as [Currency, Currency];
  return { from, to };
};

export class RefreshRatesJob {
  constructor(
    private readonly port: FxPort,
    private readonly rates: RateService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(): Promise<RefreshReport> {
    const now = this.clock();
    const report: RefreshReport = { ranAt: now.toISOString(), published: [], manual: [], errors: [] };
    for (const pair of PAIRS) {
      try {
        const { from, to } = base(pair);
        const q = await this.port.quote({ from: money(ONE_UNIT_MINOR, from), to, markupBps: 0n });
        const r: ClubRate | undefined = await this.rates.publishFromPort(pair, q.rateScaled, now);
        if (r) report.published.push({ pair, version: r.version, mid: `${r.midScaled / 1_000_000n}.${(r.midScaled % 1_000_000n).toString().padStart(6, '0')}` });
        else report.manual.push(pair);
      } catch (e) {
        report.errors.push({ pair, error: (e as Error).message.slice(0, 200) });
      }
    }
    return report;
  }
}
