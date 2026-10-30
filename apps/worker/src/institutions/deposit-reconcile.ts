// Daily deposit reconciliation (T-0618, REQ-INS-007): Kesher's bank statement for yesterday (Israel time) against
// the institution deposits. Every credit on the statement is applied as its notification would have been, so a
// notification that never came still posts, once, or opens its suspense case (the deposits service decides). Every
// deposit recorded for that day that the statement does not show opens a `deposit_not_on_statement` case: a typo,
// or money that never came. Runs only while the bank feed is on; a bank outage fails the run, and the daily
// scheduler retries it on its next tick because nothing was recorded.
import type { InstitutionDeposits } from '@kesher/api/institutions/deposits';
import type { BankPort } from '@kesher/ports';
import { israelClock } from '../scheduler.ts';

export interface DepositReconcileReport {
  valueDate: string;
  skipped?: 'feed_off';
  credits: number;
  /** Credits that posted now: their notification was lost or never processed. */
  posted: number;
  alreadyRecorded: number;
  suspense: number;
  notOnStatement: number;
}

export class DepositReconcileJob {
  private readonly deposits: InstitutionDeposits;
  private readonly port: () => BankPort;
  private readonly provider: string;
  constructor(deposits: InstitutionDeposits, port: () => BankPort, provider: string) {
    this.deposits = deposits;
    this.port = port;
    this.provider = provider;
  }

  async run(now: Date): Promise<DepositReconcileReport> {
    const valueDate = israelClock(new Date(now.getTime() - 24 * 3_600_000)).day;
    const report: DepositReconcileReport = { valueDate, credits: 0, posted: 0, alreadyRecorded: 0, suspense: 0, notOnStatement: 0 };
    if (!(await this.deposits.bankFeedOn())) return { ...report, skipped: 'feed_off' };
    const statement = await this.port().statement({ valueDate });
    report.credits = statement.length;
    for (const credit of statement) {
      const outcome = await this.deposits.applyBankCredit(credit, this.provider, now);
      if (outcome.kind === 'posted') report.posted += 1;
      else if (outcome.kind === 'already_recorded') report.alreadyRecorded += 1;
      else if (outcome.kind === 'suspense') report.suspense += 1;
    }
    report.notOnStatement = await this.deposits.notOnStatement(valueDate, statement, now);
    return report;
  }
}
