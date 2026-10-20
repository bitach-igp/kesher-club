// Allowance runs (T-0604, REQ-INS-003/004, SEQ-07): dry-run preview, approval(s), then one
// workflow keyed allowance:{schedule}:{date} that fans out one payment per member (max 20 in
// flight), retries a failed child 3× and reports it, and never pays anyone twice on a rerun.
//
// The workflow logic is deterministic over an `activities` interface so it can be hosted by
// Temporal (ADR-002) unchanged: Temporal's proxyActivities() supplies the same shape.
import { DomainError, money, type Money } from '@kesher/domain';

export interface AllowanceMember {
  memberPartyId: string;
}

export interface Preview {
  workflowId: string;
  scheduleId: string;
  runDate: string;
  memberCount: number;
  total: Money;
  members: readonly AllowanceMember[];
  requiresSecondApproval: boolean;
}

export interface RunSummary {
  workflowId: string;
  status: 'completed' | 'failed';
  paid: number;
  failures: number;
  total: Money;
}

/** The side effects, each idempotent by the ids it receives. */
export interface AllowanceActivities {
  loadSchedule(scheduleId: string): Promise<{ institutionId: string; amount: Money; memberFilter: readonly string[]; active: boolean }>;
  listMembers(institutionId: string, filter: readonly string[]): Promise<readonly AllowanceMember[]>;
  recordRun(preview: Preview, status: 'preview' | 'awaiting_second_approval' | 'running' | 'completed' | 'failed', extra?: { failures?: number }): Promise<void>;
  isApproved(workflowId: string, total: Money, requestedBy: string): Promise<boolean>;
  /** Posts the institution's account → member wallet with `transferKey` as the idempotency key. Throws on failure. */
  payMember(workflowId: string, transferKey: string, memberPartyId: string, amount: Money): Promise<{ journalId: string }>;
  recordPayment(workflowId: string, memberPartyId: string, transferKey: string, status: 'paid' | 'failed', attempts: number, journalId?: string, error?: string): Promise<void>;
  emitSummary(summary: RunSummary): Promise<void>;
}

export const MAX_PARALLEL = 20;
export const CHILD_RETRIES = 3;
export const SECOND_APPROVER_THRESHOLD_ILS_MINOR = 500_000n;

export const workflowId = (scheduleId: string, runDate: string): string => `allowance:${scheduleId}:${runDate}`;
export const transferKey = (wf: string, memberPartyId: string): string => `${wf}:${memberPartyId}`;

export async function preview(a: AllowanceActivities, scheduleId: string, runDate: string): Promise<Preview> {
  const s = await a.loadSchedule(scheduleId);
  if (!s.active) throw new DomainError('VALIDATION_FAILED', 'Schedule is not active');
  const members = await a.listMembers(s.institutionId, s.memberFilter);
  const total = money(s.amount.minor * BigInt(members.length), s.amount.currency);
  const p: Preview = { workflowId: workflowId(scheduleId, runDate), scheduleId, runDate, memberCount: members.length, total, members, requiresSecondApproval: total.currency === 'ILS' && total.minor > SECOND_APPROVER_THRESHOLD_ILS_MINOR };
  await a.recordRun(p, 'preview');
  return p;
}

/** The workflow body. Deterministic: every effect goes through `a`; concurrency is bounded; results are idempotent. */
export async function run(a: AllowanceActivities, scheduleId: string, runDate: string, requestedBy: string): Promise<RunSummary> {
  const p = await preview(a, scheduleId, runDate);
  const s = await a.loadSchedule(scheduleId);
  if (!(await a.isApproved(p.workflowId, p.total, requestedBy))) {
    await a.recordRun(p, 'awaiting_second_approval');
    throw new DomainError('FORBIDDEN', 'Awaiting second approval', { workflowId: p.workflowId });
  }
  await a.recordRun(p, 'running');
  let paid = 0;
  let failures = 0;
  const queue = [...p.members];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const key = transferKey(p.workflowId, m.memberPartyId);
      let attempts = 0;
      let lastError = '';
      while (attempts < CHILD_RETRIES) {
        attempts += 1;
        try {
          const { journalId } = await a.payMember(p.workflowId, key, m.memberPartyId, s.amount);
          await a.recordPayment(p.workflowId, m.memberPartyId, key, 'paid', attempts, journalId);
          paid += 1;
          lastError = '';
          break;
        } catch (e) {
          lastError = (e as Error).message;
        }
      }
      if (lastError) {
        failures += 1;
        await a.recordPayment(p.workflowId, m.memberPartyId, key, 'failed', attempts, undefined, lastError);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, Math.max(1, p.members.length)) }, worker));
  const summary: RunSummary = { workflowId: p.workflowId, status: failures === 0 ? 'completed' : 'failed', paid, failures, total: money(s.amount.minor * BigInt(paid), s.amount.currency) };
  await a.recordRun(p, summary.status, { failures });
  await a.emitSummary(summary);
  return summary;
}
