// I03 cohorts (T-0637, REQ-INS-018): the institution's cohorts, current first, each opening I04 filtered to it, and
// the form for a new one. Cohort names are staff text, shown as written.
import { redirect } from 'next/navigation';
import { codeOf, institutionApi } from '../../src/api.ts';
import { ordered, rosterHref } from '../../src/cohorts.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { NewCohort } from './Cohorts.tsx';

export default async function CohortsPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  let items;
  try {
    items = (await institutionApi(getConfig().CONSOLE_API_URL, access).cohorts(landing.institution.id)).items;
  } catch (e) {
    if (!codeOf(e)) throw e;
    return <div className="card" role="status" data-testid="cohorts-unavailable">{t('dash.unavailable', locale)}</div>;
  }
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <h1>{t('cohorts.title', locale)}</h1>
      <NewCohort locale={locale} />
      {items.length === 0 ? <p className="muted">{t('cohorts.none', locale)}</p> : null}
      {ordered(items, today).map((c) => (
        <div className="card" key={c.id} data-testid={`cohort-${c.id}`}>
          <strong>{c.name}</strong> <span className="muted">· {t(`cohorts.when.${c.when}`, locale)}</span>
          <div>{t('cohorts.line', locale, { start: c.startsOn, end: c.endsOn, count: c.memberCount })}</div>
          <a href={rosterHref(c)} data-testid={`cohort-open-${c.id}`}>{t('cohorts.open', locale)}</a>
        </div>
      ))}
    </>
  );
}
