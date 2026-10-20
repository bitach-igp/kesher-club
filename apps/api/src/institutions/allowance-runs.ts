// POST /institutions/{id}/allowance-runs (T-0607, REQ-INS-003/004, SEQ-07): an institution's finance staff
// preview a schedule's run for a date, or run it. The run is the allowance workflow (one per schedule and
// date, workflow id allowance:{schedule}:{date}); over ₪5,000 it waits until a second finance member asks
// for the same run. Every payment is an allowance transfer, so the monitoring job and the member's history
// see it, and a rerun pays nobody twice. Institution money is behind `institutions.money`.
// GET /institutions/{id}/allowance-schedules and /allowance-runs (T-0609) are what I07 reads: the active
// schedules with their cohort and next date, and the run history with who asked and who approved, by
// display name only. Both answer 404 to anyone but the institution's own staff.
import { DomainError, toWire, type Currency } from '@kesher/domain';
import type { IdentityRepository } from '../auth/repository.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import { staffNames } from './staff-names.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import { ok, requireIdempotencyKey, requireRole, route, type Handler, type HttpRequest } from '../http.ts';
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
  db: Database;
  identity: Pick<IdentityRepository, 'findUser'>;
  /** A run that moves money takes a passkey step-up younger than 5 minutes (REQ-AUTH-006); a preview does not. */
  stepUp: StepUpService;
}

type Cadence = 'weekly' | 'monthly' | 'once';
type RunStatus = 'preview' | 'awaiting_second_approval' | 'running' | 'completed' | 'failed';
const HISTORY_LIMIT = 100;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number): string => isoDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));
/** One calendar month on, clamped to the month's last day (31 Jan → 28 or 29 Feb). */
function addMonth(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(y, m, Math.min(d, last))));
}

/** Today for a schedule that never ran; a week or a month after its last run, never before today; none for a one-off that ran. */
export function nextRunDate(cadence: Cadence, lastRun: string | undefined, today: string): string | undefined {
  if (!lastRun) return today;
  if (cadence === 'once') return undefined;
  const next = cadence === 'weekly' ? addDays(lastRun, 7) : addMonth(lastRun);
  return next < today ? today : next;
}

/** The staff member's own institution, else 404: another institution's existence is not ours to confirm. */
async function ownInstitution(d: AllowanceRunDeps, req: HttpRequest): Promise<{ institutionId: string; partyId: string }> {
  const p = requireRole(req, 'org_staff', 'org_admin', 'org_finance');
  const institutionId = req.params['id'] ?? '';
  if ((await d.staffInstitution(p.partyId)) !== institutionId) throw new DomainError('NOT_FOUND', 'Institution not found');
  if (!(await d.flags.isOn(INSTITUTIONS_MONEY_FLAG))) throw new DomainError('FEATURE_OFF', 'Institution money is not enabled yet');
  return { institutionId, partyId: p.partyId };
}

export function allowanceRunHandlers(d: AllowanceRunDeps): Record<'runAllowance' | 'listAllowanceSchedules' | 'listAllowanceRuns', Handler> {
  return {
    listAllowanceSchedules: route(async (req) => {
      const { institutionId } = await ownInstitution(d, req);
      const r = await d.db.query<{ id: string; name: string; amount_minor: string; currency: Currency; cadence: Cadence; member_filter: string[]; member_count: number; last_run: string | Date | null }>(
        `select s.id, s.name, s.amount_minor::text, s.currency, s.cadence, s.member_filter,
                (select count(*)::int from org.member m where m.institution_id = s.institution_id and m.status = 'active' and m.member_party_id is not null
                   and (jsonb_array_length(s.member_filter) = 0 or s.member_filter ? m.member_party_id::text)) as member_count,
                (select max(run_date) from org.allowance_run r where r.schedule_id = s.id and r.status <> 'preview') as last_run
           from org.allowance_schedule s where s.institution_id = $1 and s.active order by s.created_at, s.id`,
        [institutionId],
      );
      const today = isoDate(req.now);
      return ok({
        items: r.rows.map((x) => {
          const next = nextRunDate(x.cadence, x.last_run ? isoDate(new Date(x.last_run)) : undefined, today);
          return { id: x.id, name: x.name, amount: { minor: x.amount_minor, currency: x.currency }, cadence: x.cadence, cohort: { kind: x.member_filter.length === 0 ? 'all' : 'listed', memberCount: x.member_count }, ...(next ? { nextDate: next } : {}) };
        }),
      });
    }),

    listAllowanceRuns: route(async (req) => {
      const { institutionId, partyId: me } = await ownInstitution(d, req);
      const r = await d.db.query<{ workflow_id: string; schedule_id: string; name: string; run_date: string | Date; status: RunStatus; member_count: number; total_minor: string; currency: Currency; started_at: string | Date | null; completed_at: string | Date | null; paid: number; failed: number; paid_minor: string; requested_by: string | null; approvers: string[] | null }>(
        `select r.workflow_id, r.schedule_id, s.name, r.run_date, r.status, r.member_count, r.total_minor::text, r.currency, r.started_at, r.completed_at,
                (select count(*)::int from org.allowance_payment ap where ap.workflow_id = r.workflow_id and ap.status = 'paid') as paid,
                (select count(*)::int from org.allowance_payment ap where ap.workflow_id = r.workflow_id and ap.status = 'failed') as failed,
                (select coalesce(sum(p.amount_minor), 0)::text from org.allowance_payment ap join ledger.posting p on p.journal_id = ap.journal_id
                  where ap.workflow_id = r.workflow_id and ap.status = 'paid' and p.amount_minor > 0) as paid_minor,
                a.requested_by,
                (select array_agg(dd.decided_by order by dd.at) from ops.approval_decision dd where dd.request_id = a.id and dd.decision = 'approve') as approvers
           from org.allowance_run r
           join org.allowance_schedule s on s.id = r.schedule_id
           left join ops.approval_request a on a.kind = 'allowance_run' and a.subject = r.workflow_id
          where s.institution_id = $1
          order by r.run_date desc, r.created_at desc limit ${HISTORY_LIMIT}`,
        [institutionId],
      );
      const names = await staffNames(d.db, d.identity, r.rows.flatMap((x) => [x.requested_by, ...(x.approvers ?? [])]).filter((x): x is string => !!x));
      return ok({
        items: r.rows.map((x) => ({
          workflowId: x.workflow_id,
          scheduleId: x.schedule_id,
          scheduleName: x.name,
          runDate: isoDate(new Date(x.run_date)),
          status: x.status,
          memberCount: x.member_count,
          total: { minor: x.total_minor, currency: x.currency },
          paidTotal: { minor: x.paid_minor, currency: x.currency },
          paid: x.paid,
          failed: x.failed,
          ...(x.requested_by ? { requestedBy: names.get(x.requested_by)! } : {}),
          // The console offers Approve only to someone other than the requester (REQ-INS-004).
          requestedByMe: x.requested_by === me,
          approvedBy: (x.approvers ?? []).map((id) => names.get(id)!),
          ...(x.started_at ? { startedAt: new Date(x.started_at).toISOString() } : {}),
          ...(x.completed_at ? { completedAt: new Date(x.completed_at).toISOString() } : {}),
        })),
      });
    }),

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

      if (!b.dryRun) requireStepUp(d.stepUp, req);

      const planned = await preview(d.activities, b.scheduleId, b.date);
      const view = { workflowId: planned.workflowId, memberCount: planned.memberCount, total: toWire(planned.total) };
      if (b.dryRun) {
        // One row per member the run would pay, by roster name (staff-entered, untrusted text).
        const names = await d.db.query<{ member_party_id: string; member_name: string }>('select member_party_id, member_name from org.member where institution_id = $1 and member_party_id = any($2::uuid[])', [institutionId, planned.members.map((m) => m.memberPartyId)]);
        const byParty = new Map(names.rows.map((x) => [x.member_party_id, x.member_name]));
        return ok({ ...view, status: 'preview', rows: planned.members.map((m) => ({ memberName: byParty.get(m.memberPartyId) ?? '', amount: toWire(schedule.amount) })) });
      }
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
