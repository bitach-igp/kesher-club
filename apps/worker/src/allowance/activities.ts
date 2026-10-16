// Allowance activities (T-0604): the Postgres-backed side effects behind the workflow. Payment is a
// ledger journal institution_master → member wallet with the deterministic transfer key, so a
// rerun on the same date returns the original journal instead of paying again (REQ-INS-003).
import { DomainError, type Currency, type Money } from '@kesher/domain';
import type { Database } from '@kesher/api/db';
import type { AccountService } from '@kesher/api/ledger/accounts';
import type { PostgresLedger } from '@kesher/api/ledger/post';
import type { ApprovalService } from '@kesher/api/approvals/service';
import type { OutboxSink } from '@kesher/api/transfers/outbox';
import type { AllowanceActivities, Preview, RunSummary } from './workflow.ts';

export class PostgresAllowanceActivities implements AllowanceActivities {
  constructor(
    private readonly db: Database,
    private readonly ledger: PostgresLedger,
    private readonly accounts: AccountService,
    private readonly approvals: ApprovalService,
    private readonly events: OutboxSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async loadSchedule(scheduleId: string) {
    const r = await this.db.query<{ institution_id: string; amount_minor: string; currency: Currency; member_filter: string[]; active: boolean }>('select institution_id, amount_minor::text as amount_minor, currency, member_filter, active from org.allowance_schedule where id = $1', [scheduleId]);
    const s = r.rows[0];
    if (!s) throw new DomainError('NOT_FOUND', 'Schedule not found');
    return { institutionId: s.institution_id, amount: { minor: BigInt(s.amount_minor), currency: s.currency }, memberFilter: s.member_filter, active: s.active };
  }

  async listMembers(institutionId: string, filter: readonly string[]) {
    const r = await this.db.query<{ member_party_id: string }>(
      `select member_party_id from org.member where institution_id = $1 and status = 'active' and member_party_id is not null and ($2::int = 0 or member_party_id = any($3::uuid[])) order by member_party_id`,
      [institutionId, filter.length, filter],
    );
    return r.rows.map((x) => ({ memberPartyId: x.member_party_id }));
  }

  async recordRun(p: Preview, status: 'preview' | 'awaiting_second_approval' | 'running' | 'completed' | 'failed', extra: { failures?: number } = {}) {
    const now = this.clock();
    await this.db.query(
      `insert into org.allowance_run (workflow_id, schedule_id, run_date, status, member_count, total_minor, currency, failures, started_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 0), case when $4 = 'running' then $9::timestamptz else null end, case when $4 in ('completed','failed') then $9::timestamptz else null end)
       on conflict (workflow_id) do update set status = excluded.status, member_count = excluded.member_count, total_minor = excluded.total_minor,
         failures = coalesce($8, org.allowance_run.failures), started_at = coalesce(org.allowance_run.started_at, excluded.started_at), completed_at = excluded.completed_at`,
      [p.workflowId, p.scheduleId, p.runDate, status, p.memberCount, p.total.minor.toString(), p.total.currency, extra.failures ?? null, now],
    );
  }

  async isApproved(wf: string, total: Money, requestedBy: string) {
    const run = await this.db.query<{ schedule_id: string }>('select schedule_id from org.allowance_run where workflow_id = $1', [wf]);
    const inst = await this.db.query<{ institution_id: string }>('select institution_id from org.allowance_schedule where id = $1', [run.rows[0]?.schedule_id]);
    const req = await this.approvals.request({ kind: 'allowance_run', subject: wf, scope: inst.rows[0]?.institution_id ?? 'unknown', requestedBy: { partyId: requestedBy, role: 'finance' }, amount: total }, this.clock());
    return req.status === 'approved';
  }

  async payMember(wf: string, key: string, memberPartyId: string, amount: Money) {
    const run = await this.db.query<{ schedule_id: string }>('select schedule_id from org.allowance_run where workflow_id = $1', [wf]);
    const inst = await this.db.query<{ institution_id: string }>('select institution_id from org.allowance_schedule where id = $1', [run.rows[0]?.schedule_id]);
    const master = await this.accounts.systemAccount('institution_master', amount.currency);
    const wallet = await this.accounts.memberAccount(memberPartyId, 'wallet', amount.currency);
    const j = await this.ledger.post({ idempotencyKey: key, kind: 'allowance', postings: [{ accountId: master, currency: amount.currency, amountMinor: amount.minor }, { accountId: wallet, currency: amount.currency, amountMinor: -amount.minor }], metadata: { institutionId: inst.rows[0]?.institution_id, workflowId: wf } });
    return { journalId: j.id };
  }

  async recordPayment(wf: string, memberPartyId: string, key: string, status: 'paid' | 'failed', attempts: number, journalId?: string, error?: string) {
    await this.db.query(
      `insert into org.allowance_payment (workflow_id, member_party_id, transfer_key, status, attempts, error, journal_id, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (workflow_id, member_party_id) do update set status = excluded.status, attempts = excluded.attempts, error = excluded.error, journal_id = coalesce(excluded.journal_id, org.allowance_payment.journal_id), updated_at = excluded.updated_at`,
      [wf, memberPartyId, key, status, attempts, error ?? null, journalId ?? null, this.clock()],
    );
  }

  async emitSummary(s: RunSummary) {
    await this.events.publish({ id: s.workflowId, aggregate: 'allowance_run', aggregateId: s.workflowId, type: 'allowance.run.completed', payload: { paid: s.paid, failures: s.failures, totalMinor: s.total.minor.toString(), currency: s.total.currency }, createdAt: this.clock().toISOString() });
  }
}
