// I10 master account and I12 reports (T-0646, REQ-INS-021, REQ-INS-006): the balances, how to fund the account, a
// month's statement checked to add up before it renders, its downloads, and where the other exports are. For finance
// staff and admins; anyone else is sent home.
import { redirect } from 'next/navigation';
import { fmt } from '../../src/allowances.ts';
import { codeOf, institutionApi } from '../../src/api.ts';
import { monthOf } from '../../src/collections.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { allowedMonth, months, reconciles, showsAccount } from '../../src/statement.ts';
import { StatementDownloads } from './Statement.tsx';

export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access || !showsAccount(landing.role)) redirect('/');
  const current = monthOf(new Date());
  const asked = (await searchParams)['month'];
  const month = allowedMonth(typeof asked === 'string' ? asked : undefined, current);
  const currency = landing.institution.market === 'US' ? 'USD' : 'ILS';
  let s;
  try {
    s = await institutionApi(getConfig().CONSOLE_API_URL, access).statement(landing.institution.id, month, currency);
  } catch (e) {
    if (!codeOf(e)) throw e;
    return <div className="card" role="status" data-testid="account-unavailable">{t('dash.unavailable', locale)}</div>;
  }
  return (
    <>
      <h1>{t('account.title', locale)}</h1>
      <div className="card" data-testid="account-fund">
        <p>{t('account.fund', locale, { reference: landing.paymentReference })}</p>
        {landing.institution.market === 'US' ? <p className="muted">{t('account.fund.us', locale)}</p> : null}
      </div>
      <form method="get" className="card row">
        <label>
          {t('account.month', locale)}
          <br />
          <select name="month" defaultValue={month} data-testid="account-month">
            {months(current).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <button type="submit">{t('account.show', locale)}</button>
      </form>
      {!reconciles(s, currency) ? (
        <div className="card error" role="alert" data-testid="account-mismatch">{t('account.mismatch', locale)}</div>
      ) : (
        <div className="card" data-testid="account-statement">
          <p><strong data-testid="account-opening">{t('account.opening', locale, { amount: fmt(s.opening, locale) })}</strong></p>
          {s.rows.length === 0 ? <p className="muted">{t('account.none', locale)}</p> : null}
          <table>
            <tbody>
              {/* Descriptions are text people typed, rendered as text. */}
              {s.rows.map((r) => (
                <tr key={r.journalId}>
                  <td>{r.date}</td>
                  <td>{r.description}</td>
                  <td dir="ltr">{fmt(r.amount, locale)}</td>
                  <td dir="ltr">{fmt(r.balance, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p><strong data-testid="account-closing">{t('account.closing', locale, { amount: fmt(s.closing, locale) })}</strong></p>
          <StatementDownloads month={month} currency={currency} locale={locale} />
        </div>
      )}
      <div className="card" data-testid="reports">
        <h2>{t('reports.title', locale)}</h2>
        <p><a href={`/collections?month=${month}`}>{t('reports.collections', locale)}</a></p>
        <p><a href="/allowances">{t('reports.allowances', locale)}</a></p>
      </div>
    </>
  );
}
