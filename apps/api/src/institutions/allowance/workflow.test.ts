// TST-INS-003: allowance runs show a dry-run preview, then execute as one workflow keyed
// allowance:{schedule}:{date}; a rerun on the same date makes no second payment. TST-INS-004 at
// the workflow boundary: a run over ₪5,000 waits for a second finance approver.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { AccountService } from '../../ledger/accounts.ts';
import { PostgresLedger } from '../../ledger/post.ts';
import { ApprovalService } from '../../approvals/service.ts';
import { createTestDatabase, type TestDatabase } from '../../test-db.ts';
import { TransferService } from '../../transfers/service.ts';
import { PostgresAllowanceActivities } from './activities.ts';
import { MAX_PARALLEL, preview, run, workflowId, type AllowanceActivities } from './workflow.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
let accounts: AccountService;
let approvals: ApprovalService;
let activities: PostgresAllowanceActivities;
let institutionId: string;
const finance1 = uuidv7();
const finance2 = uuidv7();
const now = new Date('2026-11-01T08:00:00Z');

/** A schedule scoped (member_filter) to freshly created members, so tests do not pay each other's students. */
async function schedule(amountMinor: bigint, memberCount: number): Promise<string> {
  const id = uuidv7();
  const parties: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const party = uuidv7();
    parties.push(party);
    await accounts.provisionMember(party);
    await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, $3, $4, 'active')`, [uuidv7(), institutionId, `Student ${i}`, party]);
  }
  await db.query(`insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, member_filter, created_by) values ($1, $2, 'Weekly', $3, 'ILS', 'weekly', $4, $5)`, [id, institutionId, amountMinor.toString(), JSON.stringify(parties), finance1]);
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  approvals = new ApprovalService(db);
  activities = new PostgresAllowanceActivities(db, ledger, accounts, approvals, new TransferService(db), () => now);
  institutionId = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [institutionId]);
}, 60_000);
afterAll(async () => db.close());

describe('allowance workflow (REQ-INS-003)', () => {
  it('dry run previews members and total without moving money', async () => {
    const sched = await schedule(20_000n, 3);
    const p = await preview(activities, sched, '2026-11-01');
    expect(p).toMatchObject({ workflowId: workflowId(sched, '2026-11-01'), memberCount: 3, total: money(60_000n, 'ILS'), requiresSecondApproval: false });
    expect((await db.query(`select status from org.allowance_run where workflow_id = $1`, [p.workflowId])).rows[0]).toEqual({ status: 'preview' });
    expect((await db.query(`select count(*)::int as n from ledger.journal where kind = 'allowance'`)).rows[0]).toEqual({ n: 0 });
  });

  it('executes once per date: each payment is an allowance transfer, and a rerun pays nobody twice (T-0607)', async () => {
    const sched = await schedule(20_000n, 3);
    const first = await run(activities, sched, '2026-11-02', finance1);
    expect(first).toMatchObject({ status: 'completed', paid: 3, failures: 0, total: money(60_000n, 'ILS') });
    const journalsBefore = (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where kind = 'allowance'`)).rows[0]!.n;
    const second = await run(activities, sched, '2026-11-02', finance1);
    expect(second.paid).toBe(3);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal where kind = 'allowance'`)).rows[0]!.n).toBe(journalsBefore);
    // The run paid out of this institution's own account (T-0613): ₪600 out, so it holds −₪600.
    const master = await accounts.institutionAccount(institutionId, 'ILS');
    expect(await ledger.balance(master, 'ILS')).toBe(60_000n);
    expect(await accounts.institutionBalance(institutionId, 'ILS')).toEqual(money(-60_000n, 'ILS'));
    expect(await ledger.balance(await accounts.systemAccount('institution_master', 'ILS'), 'ILS')).toBe(0n);
    // Each payment is an ops.transfer of kind allowance keyed by the run and the member, settled by its journal.
    const wf = workflowId(sched, '2026-11-02');
    const transfers = await db.query<{ state: string; n: number }>(`select state, count(*)::int as n from ops.transfer where kind = 'allowance' and idempotency_key like $1 group by state`, [`${wf}:%`]);
    expect(transfers.rows).toEqual([{ state: 'settled', n: 3 }]);
    const unlinked = await db.query(`select 1 from ops.transfer t where t.kind = 'allowance' and t.idempotency_key like $1 and not exists (select 1 from ledger.journal j where j.id = t.journal_id and j.transfer_id = t.id)`, [`${wf}:%`]);
    expect(unlinked.rowCount).toBe(0);
    // One completion event for the run, through the outbox, addressed to the institution.
    const events = await db.query<{ payload: Record<string, string> }>(`select payload from ops.outbox where type = 'allowance.run.completed' and payload->>'workflowId' = $1`, [wf]);
    expect(events.rows).toEqual([{ payload: expect.objectContaining({ institutionId, workflowId: wf, status: 'completed', paid: '3', failures: '0' }) }]);
    expect((await db.query(`select status from org.allowance_payment where workflow_id = $1`, [workflowId(sched, '2026-11-02')])).rows).toEqual([{ status: 'paid' }, { status: 'paid' }, { status: 'paid' }]);
  });

  it('over ₪5,000 the run waits for a second finance approver (REQ-INS-004), then completes', async () => {
    const sched = await schedule(300_000n, 2); // ₪6,000
    await expect(run(activities, sched, '2026-11-03', finance1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const wf = workflowId(sched, '2026-11-03');
    expect((await db.query(`select status from org.allowance_run where workflow_id = $1`, [wf])).rows[0]).toEqual({ status: 'awaiting_second_approval' });
    // The requester asking again is not a second approver.
    await expect(run(activities, sched, '2026-11-03', finance1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await approvals.find('allowance_run', wf))!.status).toBe('awaiting_second_approval');
    // A different finance member running the same request is (T-0607).
    const done = await run(activities, sched, '2026-11-03', finance2);
    expect(done.status).toBe('completed');
    expect(done.paid).toBe(2);
  });

  it('a failing child is retried 3× then reported; the others still get paid; parallelism is capped at 20', async () => {
    const members = Array.from({ length: 45 }, () => ({ memberPartyId: uuidv7() }));
    let inFlight = 0;
    let peak = 0;
    const attempts = new Map<string, number>();
    const fake: AllowanceActivities = {
      loadSchedule: async () => ({ institutionId: 'org', amount: money(100n, 'ILS'), memberFilter: [], active: true }),
      listMembers: async () => members,
      recordRun: async () => undefined,
      isApproved: async () => true,
      payMember: async (_wf, _key, memberPartyId) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        attempts.set(memberPartyId, (attempts.get(memberPartyId) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        if (memberPartyId === members[7]!.memberPartyId) throw new Error('processor timeout');
        return { journalId: 'j' };
      },
      recordPayment: async () => undefined,
      emitSummary: async () => undefined,
    };
    const summary = await run(fake, 's', '2026-11-04', 'f');
    expect(summary).toMatchObject({ status: 'failed', paid: 44, failures: 1, total: money(4_400n, 'ILS') });
    expect(attempts.get(members[7]!.memberPartyId)).toBe(3);
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL);
    expect(peak).toBeGreaterThan(1);
  });
});
