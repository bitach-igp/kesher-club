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
