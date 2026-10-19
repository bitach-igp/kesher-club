// POST /institutions/{id}/allowance-runs (T-0607, REQ-INS-003/004, SEQ-07): an institution's finance staff
// preview a schedule's run for a date, or run it. The run is the allowance workflow (one per schedule and
// date, workflow id allowance:{schedule}:{date}); over ₪5,000 it waits until a second finance member asks
// for the same run. Every payment is an allowance transfer, so the monitoring job and the member's history
// see it, and a rerun pays nobody twice. Institution money is behind `institutions.money`.
import { DomainError, toWire } from '@kesher/domain';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { ok, requireIdempotencyKey, requireRole, route, type Handler } from '../http.ts';
import { preview, run, type AllowanceActivities } from './allowance/workflow.ts';

export const INSTITUTIONS_MONEY_FLAG = 'institutions.money';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface RunRequest {
  scheduleId: string;
  date: string;
  dryRun: boolean;
}

function parse(body: unknown): RunRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const scheduleId = typeof b['scheduleId'] === 'string' ? b['scheduleId'] : '';
  const date = typeof b['date'] === 'string' ? b['date'] : '';
  if (!UUID.test(scheduleId)) throw new DomainError('VALIDATION_FAILED', 'scheduleId must be a uuid');
  // A real calendar day: 2026-02-30 parses to March, so round-trip it.
  if (!DATE.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new DomainError('VALIDATION_FAILED', 'date must be a calendar date, YYYY-MM-DD');
  if (typeof b['dryRun'] !== 'boolean') throw new DomainError('VALIDATION_FAILED', 'dryRun must be true or false');
  return { scheduleId, date, dryRun: b['dryRun'] };
}

export interface AllowanceRunDeps {
  activities: AllowanceActivities;
  flags: FeatureFlags;
  /** The institution a staff member belongs to, if any. */
  staffInstitution(partyId: string): Promise<string | undefined>;
}

export function allowanceRunHandlers(d: AllowanceRunDeps): Record<'runAllowance', Handler> {
  return {
    runAllowance: route(async (req) => {
      const p = requireRole(req, 'org_finance');
      requireIdempotencyKey(req);
      if (!(await d.flags.isOn(INSTITUTIONS_MONEY_FLAG))) throw new DomainError('FEATURE_OFF', 'Institution money is not enabled yet');
      const institutionId = req.params['id'] ?? '';
      if ((await d.staffInstitution(p.partyId)) !== institutionId) throw new DomainError('FORBIDDEN', 'Not finance staff of this institution');
      const b = parse(req.body);
      // Another institution's schedule is not found, not forbidden: its existence is not ours to confirm.
      const schedule = await d.activities.loadSchedule(b.scheduleId);
      if (schedule.institutionId !== institutionId) throw new DomainError('NOT_FOUND', 'Schedule not found');

      const planned = await preview(d.activities, b.scheduleId, b.date);
      const view = { workflowId: planned.workflowId, memberCount: planned.memberCount, total: toWire(planned.total) };
      if (b.dryRun) return ok({ ...view, status: 'preview' });
      try {
        const done = await run(d.activities, b.scheduleId, b.date, p.partyId);
        return ok({ ...view, status: done.status, total: toWire(done.total), failures: done.failures });
      } catch (e) {
        if (e instanceof DomainError && e.code === 'FORBIDDEN' && e.extra['workflowId'] === planned.workflowId) return ok({ ...view, status: 'awaiting_second_approval' });
        throw e;
      }
    }),
  };
}
