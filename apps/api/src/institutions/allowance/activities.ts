// Allowance activities (T-0604, T-0607): the Postgres-backed side effects behind the workflow. Each
// payment is an ops.transfer of kind 'allowance' keyed by the run and the member (so the monitoring job
// and the member's history see it), settled by a ledger journal from the institution's own account (T-0613) → member wallet keyed
// `{key}:settle`; a rerun on the same date finds both and pays nobody twice (REQ-INS-003). A run over
// ₪5,000 needs a second finance approver (REQ-INS-004): the requester's call is the first approval, and the
// same run requested by a different finance member is the second. A run starts only when the institution's
// balance and credit limit cover what it owes (T-0616, REQ-INS-008), checked under the institution's lock.
import { DomainError, type Currency, type Money } from '@kesher/domain';
import type { ApprovalService } from '../../approvals/service.ts';
import type { Database, SqlClient } from '../../db.ts';
import type { AccountService } from '../../ledger/accounts.ts';
import type { PostgresLedger } from '../../ledger/post.ts';
import { enqueue } from '../../transfers/outbox.ts';
import type { TransferService } from '../../transfers/service.ts';
import { owedByRun, type InstitutionCredit } from '../credit.ts';
import type { AllowanceActivities, Preview, RunSummary } from './workflow.ts';

export const ALLOWANCE_JOURNAL_KIND = 'allowance';

export class PostgresAllowanceActivities implements AllowanceActivities {
  private readonly db: Database;
  private readonly ledger: PostgresLedger;
  private readonly accounts: AccountService;
  private readonly approvals: ApprovalService;
  private readonly transfers: TransferService;
  private readonly credit: InstitutionCredit;
  private readonly clock: () => Date;
  constructor(
    db: Database,
    ledger: PostgresLedger,
    accounts: AccountService,
    approvals: ApprovalService,
    transfers: TransferService,
    credit: InstitutionCredit,
    clock: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.ledger = ledger;
    this.accounts = accounts;
    this.approvals = approvals;
    this.transfers = transfers;
    this.credit = credit;
    this.clock = clock;
  }

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
    await this.writeRun(this.db, p, status, extra);
  }

  async startRun(p: Preview) {
    const institutionId = await this.institutionOf(p.workflowId);
    if (!institutionId) throw new DomainError('NOT_FOUND', 'The run names no institution');
    await this.credit.withLock(institutionId, async (tx) => {
      // A rerun owes only the members it has not paid yet.
      await this.credit.requireHeadroom(institutionId, await owedByRun(tx, p), p.workflowId, tx);
      await this.writeRun(tx, p, 'running', {});
    });
  }

  private async writeRun(client: SqlClient, p: Preview, status: 'preview' | 'awaiting_second_approval' | 'running' | 'completed' | 'failed', extra: { failures?: number }) {
    const now = this.clock();
    await client.query(
      `insert into org.allowance_run (workflow_id, schedule_id, run_date, status, member_count, total_minor, currency, failures, started_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 0), case when $4 = 'running' then $9::timestamptz else null end, case when $4 in ('completed','failed') then $9::timestamptz else null end)
       on conflict (workflow_id) do update set status = excluded.status, member_count = excluded.member_count, total_minor = excluded.total_minor,
         failures = coalesce($8, org.allowance_run.failures), started_at = coalesce(org.allowance_run.started_at, excluded.started_at), completed_at = excluded.completed_at
         -- A preview of a date that already ran (or waits for approval) reads; it never turns that run back into a preview.
         where excluded.status <> 'preview' or org.allowance_run.status = 'preview'`,
      [p.workflowId, p.scheduleId, p.runDate, status, p.memberCount, p.total.minor.toString(), p.total.currency, extra.failures ?? null, now],
    );
  }

  async isApproved(wf: string, total: Money, requestedBy: string) {
    const now = this.clock();
    const by = { partyId: requestedBy, role: 'finance' as const };
    const req = await this.approvals.request({ kind: 'allowance_run', subject: wf, scope: (await this.institutionOf(wf)) ?? 'unknown', requestedBy: by, amount: total }, now);
    if (req.status !== 'awaiting_second_approval' || req.requestedBy === requestedBy) return req.status === 'approved';
    // The same run asked for by a different finance member is their approval.
    return (await this.approvals.decide(req.id, by, 'approve', now, 'second finance approver')).status === 'approved';
  }

  async payMember(wf: string, key: string, memberPartyId: string, amount: Money) {
    const now = this.clock();
    let t = await this.transfers.create({ idempotencyKey: key, kind: 'allowance', toPartyId: memberPartyId, amount }, now);
    if (t.state === 'settled' && t.journalId) return { journalId: t.journalId };
    if (t.state === 'created') t = await this.transfers.apply(t.id, 'submit', now, { reason: 'allowance run' });
    const institutionId = await this.institutionOf(wf);
    if (!institutionId) throw new DomainError('NOT_FOUND', 'The run names no institution');
    const master = await this.accounts.institutionAccount(institutionId, amount.currency);
    const wallet = await this.accounts.memberAccount(memberPartyId, 'wallet', amount.currency);
    const j = await this.ledger.post({
      idempotencyKey: `${key}:settle`,
      kind: ALLOWANCE_JOURNAL_KIND,
      transferId: t.id,
      effectiveAt: now,
      postings: [
        { accountId: master, currency: amount.currency, amountMinor: amount.minor },
        { accountId: wallet, currency: amount.currency, amountMinor: -amount.minor },
      ],
      metadata: { institutionId, workflowId: wf },
    });
    await this.transfers.apply(t.id, 'settle', now, { journalId: j.id });
    return { journalId: j.id };
  }

  async recordPayment(wf: string, memberPartyId: string, key: string, status: 'paid' | 'failed', attempts: number, journalId?: string, error?: string) {
    await this.db.query(
      `insert into org.allowance_payment (workflow_id, member_party_id, transfer_key, status, attempts, error, journal_id, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (workflow_id, member_party_id) do update set status = excluded.status, attempts = excluded.attempts, error = excluded.error, journal_id = coalesce(excluded.journal_id, org.allowance_payment.journal_id), updated_at = excluded.updated_at`,
      [wf, memberPartyId, key, status, attempts, error ?? null, journalId ?? null, this.clock()],
    );
  }

  /** One `allowance.run.completed` per run, through the outbox, carrying the institution its webhooks go to. */
  async emitSummary(s: RunSummary) {
    const run = await this.db.query<{ schedule_id: string }>('select schedule_id from org.allowance_run where workflow_id = $1', [s.workflowId]);
    const scheduleId = run.rows[0]?.schedule_id;
    if (!scheduleId) return;
    const sent = await this.db.query(`select 1 from ops.outbox where aggregate = 'allowance_run' and type = 'allowance.run.completed' and payload->>'workflowId' = $1`, [s.workflowId]);
    if (sent.rowCount > 0) return;
    await enqueue(this.db, 'allowance_run', scheduleId, 'allowance.run.completed', { institutionId: await this.institutionOf(s.workflowId), workflowId: s.workflowId, status: s.status, paid: String(s.paid), failures: String(s.failures), total: s.total });
  }

  private async institutionOf(wf: string): Promise<string | undefined> {
    const r = await this.db.query<{ institution_id: string }>('select s.institution_id from org.allowance_run r join org.allowance_schedule s on s.id = r.schedule_id where r.workflow_id = $1', [wf]);
    return r.rows[0]?.institution_id;
  }
}
