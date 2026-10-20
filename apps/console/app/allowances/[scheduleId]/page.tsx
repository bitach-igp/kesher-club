// One schedule's run (T-0610): preview its members and total for a date, run it with a passkey, or see the
// run that date already has. Finance staff run; other staff see the preview only.
import { notFound, redirect } from 'next/navigation';
import { codeOf, institutionApi } from '../../../src/api.ts';
import { cohortText, fmt } from '../../../src/allowances.ts';
import { getConfig } from '../../../src/config.ts';
import { t } from '../../../src/i18n.ts';
import { requestContext } from '../../../src/request.ts';
import { RunPanel } from '../RunPanel.tsx';

export default async function SchedulePage({ params }: { params: Promise<{ scheduleId: string }> }) {
  const { scheduleId } = await params;
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  const api = institutionApi(getConfig().CONSOLE_API_URL, access);
  let found;
  try {
    const [schedules, runs] = await Promise.all([api.schedules(landing.institution.id), api.runs(landing.institution.id)]);
    found = { schedule: schedules.items.find((s) => s.id === scheduleId), runs: runs.items };
  } catch (e) {
    if (codeOf(e) !== 'FEATURE_OFF') throw e;
    return <div className="card" data-testid="allowances-off">{t('allowances.off', locale)}</div>;
  }
  const { schedule, runs } = found;
  if (!schedule) notFound();
  const date = schedule.nextDate ?? new Date().toISOString().slice(0, 10);
  return (
    <>
      <h1>{schedule.name}</h1>
      <p className="muted">
        {fmt(schedule.amount, locale)} · {t(`allowances.cadence.${schedule.cadence}`, locale)} · {cohortText(schedule, locale)}
      </p>
      <RunPanel scheduleId={scheduleId} defaultDate={date} locale={locale} canRun={landing.role === 'finance'} runs={runs.filter((r) => r.scheduleId === scheduleId)} />
    </>
  );
}
