// I07 Allowances (T-0610, REQ-INS-003/004): what the screen decides, apart from rendering. A preview's rows
// must add up to its total; a run takes a step-up and is retried once with the same key after it; over
// ₪5,000 it waits for a second finance member, and the requester is never offered Approve on their own run;
// a run that already happened shows its result instead of a Run button; FEATURE_OFF is the off state.
// A new schedule (T-0627) is checked before the call (a name, an amount above zero and at most 10,000.00 a
// member) and shows the dates it would run; it pays every active member.
import { format, fromWire, type Money } from '@kesher/domain';
import type { Schemas } from '@kesher/sdk';
import type { Result } from './api.ts';
import { intlLocale, t, type Locale } from './i18n.ts';
import { parseShekels } from './payouts.ts';
import { withStepUp } from './step-up.ts';

export type Schedule = Schemas['AllowanceSchedule'];
export type RunSummary = Schemas['AllowanceRunSummary'];
export type RunResult = Schemas['AllowanceRun'];
export type Role = Schemas['MyInstitution']['role'];
export type ScheduleRequest = Schemas['AllowanceScheduleRequest'];
export type Cadence = ScheduleRequest['cadence'];

export type { Result };

export const fmt = (m: Schemas['Money'], locale: Locale): string => format(fromWire(m), intlLocale(locale));

/** "Every active member (12)" or "3 listed members". */
export const cohortText = (s: Schedule, locale: Locale): string => t(s.cohort.kind === 'all' ? 'allowances.cohort.all' : 'allowances.cohort.listed', locale, { count: s.cohort.memberCount });

/** The preview's rows, summed in minor units. */
export const rowsTotal = (rows: readonly { amount: Schemas['Money'] }[]): bigint => rows.reduce((n, r) => n + BigInt(r.amount.minor), 0n);

/** Approve is for a different finance member, on a run waiting for them. */
export const canApprove = (run: RunSummary, role: Role): boolean => run.status === 'awaiting_second_approval' && !run.requestedByMe && role === 'finance';

/** The run already made for this schedule and date, if any: a preview is not a run. */
export const earlierRun = (runs: readonly RunSummary[], scheduleId: string, date: string): RunSummary | undefined =>
  runs.find((r) => r.scheduleId === scheduleId && r.runDate === date && r.status !== 'preview');

export type PreviewView = { kind: 'preview'; run: RunResult; total: Money } | { kind: 'off' } | { kind: 'error'; code: string };

export type RunView =
  | { kind: 'completed' | 'failed'; run: RunResult }
  | { kind: 'waiting'; run: RunResult }
  | { kind: 'cancelled' }
  | { kind: 'off' }
  | { kind: 'error'; code: string };

export interface RunDeps {
  preview(scheduleId: string, date: string): Promise<Result<RunResult>>;
  run(scheduleId: string, date: string, idempotencyKey: string): Promise<Result<RunResult>>;
  /** The passkey step-up ceremony; false when the person cancelled or it failed. */
  stepUp(): Promise<boolean>;
  newKey(): string;
}

export async function previewRun(d: RunDeps, scheduleId: string, date: string): Promise<PreviewView> {
  const r = await d.preview(scheduleId, date);
  if (!r.ok) return r.code === 'FEATURE_OFF' ? { kind: 'off' } : { kind: 'error', code: r.code };
  const total = fromWire(r.value.total);
  // The rows are what the person checks; a total that is not their sum is not shown as a preview.
  if (rowsTotal(r.value.rows ?? []) !== total.minor) return { kind: 'error', code: 'PREVIEW_MISMATCH' };
  return { kind: 'preview', run: r.value, total };
}

/** Runs (or, for the second finance member, approves) once per key; one step-up and one retry when the API asks. */
export async function executeRun(d: RunDeps, scheduleId: string, date: string): Promise<RunView> {
  const key = d.newKey();
  const r = await withStepUp(() => d.run(scheduleId, date, key), d.stepUp);
  if (!r.ok) return r.code === 'STEP_UP_CANCELLED' ? { kind: 'cancelled' } : r.code === 'FEATURE_OFF' ? { kind: 'off' } : { kind: 'error', code: r.code };
  if (r.value.status === 'awaiting_second_approval') return { kind: 'waiting', run: r.value };
  return { kind: r.value.status === 'failed' ? 'failed' : 'completed', run: r.value };
}

/** The API's ceiling, a typo guard: 10,000.00 a member a run. */
export const MAX_ALLOWANCE_MINOR = 1_000_000n;
const NAME_MAX = 80;

export interface ScheduleDraft {
  name: string;
  /** Major units as typed: "150" or "1,250.50". */
  amountText: string;
  cadence: Cadence;
}

export type ScheduleProblem = 'name' | 'amount' | 'over_max';

/** Everything the console can know before the call; the institution's currency follows its market. */
export function checkSchedule(d: ScheduleDraft, market: 'IL' | 'US'): { ok: true; body: ScheduleRequest } | { ok: false; problems: ScheduleProblem[] } {
  const problems: ScheduleProblem[] = [];
  const name = d.name.trim();
  if (!name || name.length > NAME_MAX) problems.push('name');
  const minor = parseShekels(d.amountText);
  if (minor === undefined) problems.push('amount');
  else if (minor > MAX_ALLOWANCE_MINOR) problems.push('over_max');
  if (problems.length || minor === undefined) return { ok: false, problems };
  return { ok: true, body: { name, amount: { minor: minor.toString(), currency: market === 'US' ? 'USD' : 'ILS' }, cadence: d.cadence, cohort: { kind: 'all' } } };
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** A new schedule runs first today (as the list shows it), then a week or a calendar month on, clamped to the month's end. */
export function runDates(cadence: Cadence, today: string): string[] {
  if (cadence === 'once') return [today];
  if (cadence === 'weekly') return [today, isoDate(new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000))];
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return [today, isoDate(new Date(Date.UTC(y, m, Math.min(d, last))))];
}

export type ScheduleOutcome = { kind: 'done'; schedule: Schedule } | { kind: 'invalid'; problems: ScheduleProblem[] } | { kind: 'off' } | { kind: 'error'; code: string };

export interface ScheduleDeps {
  create(body: ScheduleRequest, idempotencyKey: string): Promise<Result<Schedule>>;
  newKey(): string;
}

/** Checks the draft, then creates the schedule once per attempt key. */
export async function createSchedule(d: ScheduleDeps, draft: ScheduleDraft, market: 'IL' | 'US'): Promise<ScheduleOutcome> {
  const checked = checkSchedule(draft, market);
  if (!checked.ok) return { kind: 'invalid', problems: checked.problems };
  const r = await d.create(checked.body, d.newKey());
  if (r.ok) return { kind: 'done', schedule: r.value };
  return r.code === 'FEATURE_OFF' ? { kind: 'off' } : { kind: 'error', code: r.code };
}

