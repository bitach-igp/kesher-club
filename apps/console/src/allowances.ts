// I07 Allowances (T-0610, REQ-INS-003/004): what the screen decides, apart from rendering. A preview's rows
// must add up to its total; a run takes a step-up and is retried once with the same key after it; over
// ₪5,000 it waits for a second finance member, and the requester is never offered Approve on their own run;
// a run that already happened shows its result instead of a Run button; FEATURE_OFF is the off state.
import { format, fromWire, type Money } from '@kesher/domain';
import type { Schemas } from '@kesher/sdk';
import { intlLocale, t, type Locale } from './i18n.ts';

export type Schedule = Schemas['AllowanceSchedule'];
export type RunSummary = Schemas['AllowanceRunSummary'];
export type RunResult = Schemas['AllowanceRun'];
export type Role = Schemas['MyInstitution']['role'];

/** A server action's answer: the API's body, or its error code. Server actions do not throw across the wire. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string };

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
  let r = await d.run(scheduleId, date, key);
  if (!r.ok && r.code === 'STEP_UP_REQUIRED') {
    if (!(await d.stepUp())) return { kind: 'cancelled' };
    r = await d.run(scheduleId, date, key);
  }
  if (!r.ok) return r.code === 'FEATURE_OFF' ? { kind: 'off' } : { kind: 'error', code: r.code };
  if (r.value.status === 'awaiting_second_approval') return { kind: 'waiting', run: r.value };
  return { kind: r.value.status === 'failed' ? 'failed' : 'completed', run: r.value };
}
