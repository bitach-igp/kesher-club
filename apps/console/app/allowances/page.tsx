// I07 Allowances (T-0610, REQ-INS-003/004): the institution's schedules and its run history, with who
// asked and who approved each run, and Approve for a second finance member on a run waiting for them.
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { codeOf, institutionApi } from '../../src/api.ts';
import { canApprove, cohortText, fmt, type RunSummary, type Schedule } from '../../src/allowances.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { ApproveButton } from './RunPanel.tsx';

export default async function AllowancesPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  const api = institutionApi(getConfig().CONSOLE_API_URL, access);
  let schedules: readonly Schedule[];
  let runs: readonly RunSummary[];
  try {
    [schedules, runs] = await Promise.all([api.schedules(landing.institution.id).then((r) => r.items), api.runs(landing.institution.id).then((r) => r.items)]);
  } catch (e) {
    if (codeOf(e) !== 'FEATURE_OFF') throw e;
    return (
      <>
        <h1>{t('allowances.title', locale)}</h1>
        <div className="card" data-testid="allowances-off">{t('allowances.off', locale)}</div>
      </>
    );
  }
  return (
    <>
      <h1>{t('allowances.title', locale)}</h1>
      <h2>{t('allowances.schedules', locale)}</h2>
      {landing.role === 'finance' ? (
        <p>
          <Link href="/allowances/new" data-testid="schedule-new">{t('allowances.new', locale)}</Link>
        </p>
      ) : null}
      {schedules.length === 0 ? <p className="muted" data-testid="schedules-none">{t('allowances.schedules.none', locale)}</p> : null}
      {schedules.map((s) => (
        <div className="card" key={s.id} data-testid={`schedule-${s.id}`}>
          <strong>{s.name}</strong> · {fmt(s.amount, locale)} · {t(`allowances.cadence.${s.cadence}`, locale)} · {cohortText(s, locale)}
          {s.nextDate ? <span className="muted"> · {t('allowances.next', locale, { date: s.nextDate })}</span> : null}
          <div>
            <Link href={`/allowances/${s.id}`}>{t('allowances.open', locale)}</Link>
          </div>
        </div>
      ))}
      <h2>{t('allowances.history', locale)}</h2>
      {runs.length === 0 ? <p className="muted" data-testid="runs-none">{t('allowances.history.none', locale)}</p> : null}
      {runs.map((r) => (
        <div className="card" key={r.workflowId} data-testid={`run-${r.scheduleId}-${r.runDate}`}>
          <strong>{r.runDate}</strong> · {r.scheduleName} · <span data-testid="run-status">{t(`allowances.status.${r.status}`, locale)}</span>
          <div className="muted">{t('allowances.paid', locale, { paid: r.paid, failed: r.failed, paidTotal: fmt(r.paidTotal, locale), total: fmt(r.total, locale) })}</div>
          {r.requestedBy ? <div className="muted">{t('allowances.requestedBy', locale, { name: r.requestedBy.displayName })}</div> : null}
          {r.approvedBy.length ? <div className="muted">{t('allowances.approvedBy', locale, { names: r.approvedBy.map((a) => a.displayName).join(', ') })}</div> : null}
          {canApprove(r, landing.role) ? <ApproveButton scheduleId={r.scheduleId} runDate={r.runDate} locale={locale} /> : null}
        </div>
      ))}
    </>
  );
}
