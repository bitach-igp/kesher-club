// I04 roster (T-0639, REQ-INS-019): the roster with status and cohort filters and paging; rows can be selected
// across pages and placed in a cohort. Names are roster text, shown as written; no row carries spend.
import { redirect } from 'next/navigation';
import { codeOf, institutionApi } from '../../src/api.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { filterFrom, nextHref, STATUSES, toQuery } from '../../src/roster.ts';
import { RosterTable } from './Roster.tsx';

export default async function RosterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  const filter = filterFrom(await searchParams);
  const api = institutionApi(getConfig().CONSOLE_API_URL, access);
  let page;
  let cohorts;
  try {
    [page, cohorts] = await Promise.all([api.roster(landing.institution.id, toQuery(filter)), api.cohorts(landing.institution.id)]);
  } catch (e) {
    if (!codeOf(e)) throw e;
    return <div className="card" role="status" data-testid="roster-unavailable">{t('dash.unavailable', locale)}</div>;
  }
  const next = nextHref(filter, page.nextCursor);
  return (
    <>
      <h1>{t('roster.title', locale)}</h1>
      <form method="get" className="row card">
        <label>
          {t('roster.filter.status', locale)}
          <br />
          <select name="status" defaultValue={filter.status ?? ''} data-testid="roster-status">
            <option value="">{t('roster.filter.any', locale)}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`roster.status.${s}`, locale)}</option>)}
          </select>
        </label>
        <label>
          {t('roster.filter.cohort', locale)}
          <br />
          <select name="cohort" defaultValue={filter.cohort ?? ''} data-testid="roster-cohort">
            <option value="">{t('roster.filter.any', locale)}</option>
            {cohorts.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button type="submit" data-testid="roster-filter">{t('roster.filter.apply', locale)}</button>
      </form>
      {page.items.length === 0 ? <p className="muted">{t('roster.none', locale)}</p> : <RosterTable locale={locale} rows={page.items} cohorts={cohorts.items.map((c) => ({ id: c.id, name: c.name }))} />}
      {next ? <p><a href={next} data-testid="roster-next">{t('roster.next', locale)}</a></p> : null}
    </>
  );
}
