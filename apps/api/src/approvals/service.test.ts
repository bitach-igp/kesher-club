// TST-INS-004: payouts and allowance schedules over ₪5,000 need approval by a second finance-role
// user (given one approver, status awaiting_second_approval). TST-ADM-002: flipping a money flag
// or provider binding needs two distinct admins (given one approval, the flag is unchanged).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { ApprovalService, approversRequired } from './service.ts';

let db: TestDatabase;
let approvals: ApprovalService;
const now = new Date('2026-11-01T10:00:00Z');
const finance1 = { partyId: uuidv7(), role: 'finance' };
const finance2 = { partyId: uuidv7(), role: 'finance' };
const staff = { partyId: uuidv7(), role: 'staff' };
const admin1 = { partyId: uuidv7(), role: 'admin' };
const admin2 = { partyId: uuidv7(), role: 'admin' };

beforeAll(async () => {
  db = await createTestDatabase();
  approvals = new ApprovalService(db);
}, 60_000);
afterAll(async () => db.close());

describe('approversRequired', () => {
  it('two for money flags and bindings; two for institution money over ₪5,000; one otherwise', () => {
    expect(approversRequired('flag_flip')).toBe(2);
    expect(approversRequired('provider_binding')).toBe(2);
    expect(approversRequired('allowance_run', money(500_000n, 'ILS'))).toBe(1);
    expect(approversRequired('allowance_run', money(500_001n, 'ILS'))).toBe(2);
    expect(approversRequired('payout', money(300_000n, 'ILS'))).toBe(1);
  });
});

describe('ApprovalService (REQ-INS-004)', () => {
  it('an allowance run over ₪5,000 is awaiting_second_approval after the requester, approved after a distinct finance user', async () => {
    const r = await approvals.request({ kind: 'allowance_run', subject: 'allowance:sched-1:2026-11-01', scope: 'org_1', requestedBy: finance1, amount: money(900_000n, 'ILS') }, now);
    expect(r).toMatchObject({ status: 'awaiting_second_approval', required: 2, approvals: 1 });
    expect(await approvals.isApproved('allowance_run', 'allowance:sched-1:2026-11-01')).toBe(false);
    await expect(approvals.decide(r.id, finance1, 'approve', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' }); // one person decides once
    await expect(approvals.decide(r.id, staff, 'approve', now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const done = await approvals.decide(r.id, finance2, 'approve', now);
    expect(done).toMatchObject({ status: 'approved', approvals: 2 });
    expect(await approvals.isApproved('allowance_run', 'allowance:sched-1:2026-11-01')).toBe(true);
    await expect(approvals.decide(r.id, finance2, 'approve', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('a run under ₪5,000 is approved by the requester alone; the request is idempotent per subject', async () => {
    const r = await approvals.request({ kind: 'allowance_run', subject: 'allowance:sched-2:2026-11-01', scope: 'org_1', requestedBy: finance1, amount: money(100_000n, 'ILS') }, now);
    expect(r.status).toBe('approved');
    const again = await approvals.request({ kind: 'allowance_run', subject: 'allowance:sched-2:2026-11-01', scope: 'org_1', requestedBy: finance2, amount: money(100_000n, 'ILS') }, now);
    expect(again.id).toBe(r.id);
  });

  it('a rejection ends the request; an expired request cannot be decided', async () => {
    const r = await approvals.request({ kind: 'payout', subject: 'payout:1', scope: 'org_1', requestedBy: finance1, amount: money(800_000n, 'ILS') }, now);
    expect((await approvals.decide(r.id, finance2, 'reject', now, 'wrong payee')).status).toBe('rejected');
    const e = await approvals.request({ kind: 'payout', subject: 'payout:2', scope: 'org_1', requestedBy: finance1, amount: money(800_000n, 'ILS'), ttlMs: 1000 }, now);
    await expect(approvals.decide(e.id, finance2, 'approve', new Date(now.getTime() + 1001))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await approvals.get(e.id))!.status).toBe('expired');
  });
});

describe('an institution cannot split a payout to stay under the threshold (T-0545, F43)', () => {
  const inst = uuidv7();
  const other = uuidv7();
  const payout = (scope: string, subject: string, minor: bigint, at: Date) => approvals.request({ kind: 'payout', subject, scope, requestedBy: finance1, amount: money(minor, 'ILS') }, at);

  it('payouts under the threshold alone need one approver, until the day\'s total passes it: then each further one needs a second, different person', async () => {
    const first = await payout(inst, 'payout:split-1', 300_000n, now);
    expect(first).toMatchObject({ required: 1, status: 'approved' });
    // 300,000 + 200,000 is exactly the threshold: not over it.
    expect(await payout(inst, 'payout:split-2', 200_000n, now)).toMatchObject({ required: 1, status: 'approved' });
    const third = await payout(inst, 'payout:split-3', 499_900n, now);
    expect(third).toMatchObject({ required: 2, status: 'awaiting_second_approval', approvals: 1 });
    await expect(approvals.decide(third.id, finance1, 'approve', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await approvals.decide(third.id, finance2, 'approve', now)).toMatchObject({ status: 'approved', approvals: 2 });
  });

  it('twenty payouts of ₪4,999 by one person: the first one is alone, the rest need a second approver', async () => {
    const scope = uuidv7();
    const results = [];
    for (let i = 0; i < 20; i++) results.push(await payout(scope, `payout:twenty-${i}`, 499_900n, now));
    expect(results[0]).toMatchObject({ required: 1 });
    expect(results.slice(1).every((r) => r.required === 2 && r.status === 'awaiting_second_approval')).toBe(true);
  });

  it('another institution\'s payouts, a rejected or expired one, and one older than a day do not count; a replay is the same request', async () => {
    const scope = uuidv7();
    expect(await payout(other, 'payout:o-1', 450_000n, now)).toMatchObject({ required: 1 });
    expect(await payout(scope, 'payout:c-1', 450_000n, new Date(now.getTime() - 25 * 3_600_000))).toMatchObject({ required: 1 });
    const gone = await payout(scope, 'payout:c-2', 600_000n, new Date(now.getTime() - 3_600_000));
    expect(gone).toMatchObject({ required: 2, status: 'awaiting_second_approval' });
    await approvals.decide(gone.id, finance2, 'reject', now, 'wrong payee');
    expect(await payout(scope, 'payout:c-3', 400_000n, now)).toMatchObject({ required: 1 });
    const again = await payout(scope, 'payout:c-3', 400_000n, now);
    expect(again.required).toBe(1);
    expect(await payout(scope, 'payout:c-4', 200_000n, now)).toMatchObject({ required: 2 });
  });
});

describe('ApprovalService.expire (T-0549)', () => {
  it('marks an open request expired once and leaves a decided one as it is', async () => {
    const open = await approvals.request({ kind: 'payout', subject: 'payout:exp-1', scope: 'org_2', requestedBy: finance1, amount: money(800_000n, 'ILS') }, now);
    await approvals.expire(open.id, now);
    expect((await approvals.get(open.id))!.status).toBe('expired');
    await approvals.expire(open.id, new Date(now.getTime() + 1000));
    expect((await approvals.get(open.id))!.status).toBe('expired');
    const done = await approvals.request({ kind: 'payout', subject: 'payout:exp-2', scope: 'org_2', requestedBy: finance1, amount: money(100_000n, 'ILS') }, now);
    expect(done.status).toBe('approved');
    await approvals.expire(done.id, now);
    expect((await approvals.get(done.id))!.status).toBe('approved');
  });
});

describe('ApprovalService (REQ-ADM-002)', () => {
  it('a money flag flip needs two distinct admins; with one approval the flag stays unchanged', async () => {
    const r = await approvals.request({ kind: 'flag_flip', subject: 'wallet.enabled', scope: 'platform', requestedBy: admin1, payload: { from: false, to: true } }, now);
    expect(r).toMatchObject({ status: 'awaiting_second_approval', required: 2, approvals: 0 });
    const one = await approvals.decide(r.id, admin1, 'approve', now);
    expect(one.status).toBe('awaiting_second_approval');
    expect(await approvals.isApproved('flag_flip', 'wallet.enabled')).toBe(false);
    await expect(approvals.decide(r.id, admin1, 'approve', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(approvals.decide(r.id, finance1, 'approve', now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await approvals.decide(r.id, admin2, 'approve', now)).status).toBe('approved');
    expect(await approvals.isApproved('flag_flip', 'wallet.enabled')).toBe(true);
  });

  it('decisions are insert-only for the app role', async () => {
    await db.asRole('club_app', async (app) => {
      await expect(app.query(`update ops.approval_decision set decision = 'approve'`)).rejects.toMatchObject({ code: '42501' });
    });
  });
});
