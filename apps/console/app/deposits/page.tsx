// Deposits by ACH (T-0630, REQ-INS-009): a US institution's finance staff see what the bank still holds apart
// from what the institution can spend, the latest pulls with where each stands, and pull more with a passkey.
// Anyone else is sent home: IL institutions fund by recorded transfer (T-0614).
import { redirect } from 'next/navigation';
import { codeOf, institutionApi } from '../../src/api.ts';
import { fmt } from '../../src/allowances.ts';
import { getConfig } from '../../src/config.ts';
import { errorKey, showsDeposits, stateLine } from '../../src/deposits.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { NewPull } from './Deposits.tsx';

export default async function DepositsPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access || !showsDeposits(landing)) redirect('/');
  let page;
  try {
    page = await institutionApi(getConfig().CONSOLE_API_URL, access).achPulls(landing.institution.id);
  } catch (e) {
    const code = codeOf(e);
    if (code !== 'NOT_FOUND' && code !== 'FORBIDDEN' && code !== 'FEATURE_OFF') throw e;
    return <div className="card" role="status" data-testid="deposits-unavailable">{t(errorKey(code), locale)}</div>;
  }
  return (
    <>
      <h1>{t('deposits.title', locale)}</h1>
      <p className="muted">{t('deposits.intro', locale)}</p>
      <p className="row">
        <strong data-testid="deposits-available">{t('deposits.available', locale, { amount: fmt(page.available, locale) })}</strong>
        <span data-testid="deposits-held">{t('deposits.held', locale, { amount: fmt(page.held, locale) })}</span>
      </p>
      <NewPull locale={locale} />
      {page.items.length === 0 ? <p className="muted">{t('deposits.none', locale)}</p> : null}
      {page.items.map((p) => {
        const line = stateLine(p);
        return (
          <div className="card" key={p.id} data-testid={`pull-${p.id}`}>
            <strong>{fmt(p.amount, locale)}</strong>
            <div data-testid="pull-state" className={p.state === 'failed' ? 'error' : undefined}>{t(line.key, locale, line.vars)}</div>
          </div>
        );
      })}
    </>
  );
}
