// T-0661 (REQ-INS-003, REQ-INS-008): an allowance payment cannot take the institution's account past what it holds plus its approved
// credit, even when money leaves between the run's start check and the payment. ₪10,000.00 and no credit; the run owes ₪8,000.00
// (two members at ₪4,000.00); before the payments a ₪5,000.00 payout reserve takes its money: one member is paid, the other is refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { ApprovalService } from '../../approvals/service.ts';
import { AuditService } from '../../audit/service.ts';
import { AccountService } from '../../ledger/accounts.ts';
import { PostgresLedger } from '../../ledger/post.ts';
import { createTestDatabase, type TestDatabase } from '../../test-db.ts';
import { decideKyb } from '../../test-institution.ts';
import { TransferService } from '../../transfers/service.ts';
import { InstitutionCredit } from '../credit.ts';
import { InstitutionKyb } from '../kyb.ts';
import { KybGate } from '../kyb-gate.ts';
import { PostgresAllowanceActivities } from './activities.ts';
import { workflowId, type Preview } from './workflow.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
let accounts: AccountService;
let activities: PostgresAllowanceActivities;
const now = new Date('2026-11-01T08:00:00Z');
const ILS = 'ILS' as const;

async function institution(limitMinor: bigint, holds: bigint) {
  const id = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [id]);
  await decideKyb(db, id);
  if (limitMinor > 0n) await db.query(`insert into ops.institution_credit_limit (id, institution_id, currency, limit_minor, approval_id, set_at) values ($1, $2, 'ILS', $3, $4, $5)`, [uuidv7(), id, limitMinor.toString(), uuidv7(), now]);
  const master = await accounts.institutionAccount(id, ILS);
  const reserve = await accounts.institutionPayoutReserveAccount(id, ILS);
  const partner = await accounts.systemAccount('partner_settlement', ILS);
  await ledger.post({ idempotencyKey: `fund-${id}`, kind: 'deposit', postings: [{ accountId: partner, currency: ILS, amountMinor: holds }, { accountId: master, currency: ILS, amountMinor: -holds }], metadata: { institutionId: id } });
  const members = [uuidv7(), uuidv7()];
  for (const m of members) await accounts.provisionMember(m);
  const scheduleId = uuidv7();
  await db.query(`insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, member_filter, created_by) values ($1, $2, 'Weekly', 400000, 'ILS', 'weekly', $3, $4)`, [scheduleId, id, JSON.stringify(members), uuidv7()]);
  const p: Preview = { workflowId: workflowId(scheduleId, '2026-11-01'), scheduleId, runDate: '2026-11-01', memberCount: 2, total: money(800_000n, ILS), members: members.map((memberPartyId) => ({ memberPartyId })), requiresSecondApproval: true };
  await activities.recordRun(p, 'preview');
  await activities.startRun(p);
  return { id, master, reserve, members, p };
}

const key = (wf: string, m: string) => `${wf}:${m}`;
const held = async (account: string) => -(await ledger.balance(account, ILS));

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  const approvals = new ApprovalService(db);
  const audit = new AuditService(db);
  activities = new PostgresAllowanceActivities(db, ledger, accounts, approvals, new TransferService(db), new InstitutionCredit(db, approvals, audit, new KybGate(new InstitutionKyb(db, approvals, audit))), () => now);
}, 60_000);
afterAll(async () => db.close());

describe('an allowance payment never overdraws the institution (T-0661)', () => {
  it('money that left after the run started is not paid out again: the second member is refused INSUFFICIENT_FUNDS and nothing posts for them', async () => {
    const i = await institution(0n, 1_000_000n);
    await ledger.post({ idempotencyKey: `res-${i.id}`, kind: 'payout_reserve', postings: [{ accountId: i.master, currency: ILS, amountMinor: 500_000n }, { accountId: i.reserve, currency: ILS, amountMinor: -500_000n }] });
    const [a, b] = i.members as [string, string];
    await expect(activities.payMember(i.p.workflowId, key(i.p.workflowId, a), a, money(400_000n, ILS))).resolves.toHaveProperty('journalId');
    await expect(activities.payMember(i.p.workflowId, key(i.p.workflowId, b), b, money(400_000n, ILS))).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await held(i.master)).toBe(100_000n);
    expect(await ledger.balance(await accounts.memberAccount(b, 'wallet', ILS), ILS)).toBe(0n);
    const journals = await db.query<{ n: string }>(`select count(*)::text as n from ledger.journal where idempotency_key = $1`, [`${key(i.p.workflowId, b)}:settle`]);
    expect(journals.rows[0]?.n).toBe('0');
  });

  it('credit still pays: with a ₪5,000.00 limit the master may go to -₪5,000.00 and no further', async () => {
    const i = await institution(500_000n, 300_000n);
    const [a, b] = i.members as [string, string];
    await activities.payMember(i.p.workflowId, key(i.p.workflowId, a), a, money(400_000n, ILS));
    await expect(activities.payMember(i.p.workflowId, key(i.p.workflowId, b), b, money(400_000n, ILS))).resolves.toHaveProperty('journalId');
    expect(await held(i.master)).toBe(-500_000n);
    const c = uuidv7();
    await accounts.provisionMember(c);
    await expect(activities.payMember(i.p.workflowId, key(i.p.workflowId, c), c, money(1n, ILS))).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('a replayed payment posts once', async () => {
    const i = await institution(0n, 1_000_000n);
    const [a] = i.members as [string, string];
    const first = await activities.payMember(i.p.workflowId, key(i.p.workflowId, a), a, money(400_000n, ILS));
    const again = await activities.payMember(i.p.workflowId, key(i.p.workflowId, a), a, money(400_000n, ILS));
    expect(again.journalId).toBe(first.journalId);
    expect(await held(i.master)).toBe(600_000n);
  });
});
