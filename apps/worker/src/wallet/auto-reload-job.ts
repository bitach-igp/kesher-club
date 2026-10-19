// Auto-reload job (T-0503, REQ-WAL-004): every cycle, each enabled rule whose 24 h window has passed is
// evaluated against the member's available balance; below the threshold, one load to the target runs
// through the LoadWorkflow. The service claims the attempt before the pull, so two overlapping runs, or
// a rerun after a crash, never charge a member twice in a window, and a failed load waits the window out.
import type { AttemptOutcome, AutoReloadService } from '@kesher/api/wallet/auto-reload';

export const AUTO_RELOAD_CYCLE_MS = 15 * 60_000;

export interface AutoReloadReport {
  ranAt: string;
  checked: number;
  loaded: number;
  failed: number;
  aboveThreshold: number;
  inWindow: number;
  errors: { ruleId: string; error: string }[];
}

export class AutoReloadJob {
  private readonly rules: AutoReloadService;
  private readonly clock: () => Date;
  private readonly batch: number;
  constructor(
    rules: AutoReloadService,
    clock: () => Date = () => new Date(),
    batch = 500,
  ) {
    this.rules = rules;
    this.clock = clock;
    this.batch = batch;
  }

  async run(): Promise<AutoReloadReport> {
    const now = this.clock();
    const report: AutoReloadReport = { ranAt: now.toISOString(), checked: 0, loaded: 0, failed: 0, aboveThreshold: 0, inWindow: 0, errors: [] };
    for (const rule of await this.rules.due(now, this.batch)) {
      report.checked += 1;
      try {
        const a = await this.rules.attempt(rule, now);
        report[counter(a.outcome)] += 1;
      } catch (e) {
        report.errors.push({ ruleId: rule.id, error: (e as Error).message.slice(0, 200) });
      }
    }
    return report;
  }
}

function counter(o: AttemptOutcome): 'loaded' | 'failed' | 'aboveThreshold' | 'inWindow' {
  switch (o) {
    case 'loaded':
      return 'loaded';
    case 'failed':
      return 'failed';
    case 'above_threshold':
      return 'aboveThreshold';
    case 'in_window':
    case 'disabled':
      return 'inWindow';
  }
}
