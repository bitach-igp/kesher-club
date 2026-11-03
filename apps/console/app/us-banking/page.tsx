// The US bank account screen (T-0651, REQ-INS-022, REQ-INS-024): the application's state, the account once approved and funding the
// master account from it. Finance staff and admins only; a switched-off flag (the API's 404) sends the person home.
import { redirect } from 'next/navigation';
import { codeOf, institutionApi } from '../../src/api.ts';
import { fmt } from '../../src/allowances.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { bankingState, canFund, canStart, partyIdOf, showsUsBanking } from '../../src/us-banking.ts';
import { Funding, Start } from './UsBanking.tsx';

export default async function UsBankingPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access || !showsUsBanking(landing)) redirect('/');
  const api = institutionApi(getConfig().CONSOLE_API_URL, access);
  let banking;
  try {
    banking = await api.usBanking(landing.institution.id);
  } catch (e) {
    const code = codeOf(e);
    if (code === 'FEATURE_OFF' || code === 'NOT_FOUND') redirect('/');
    throw e;
  }
  const funding = canFund(banking) ? await api.usFunding(landing.institution.id) : { items: [] };
  return (
    <>
      <h1>{t('usbank.title', locale)}</h1>
      <p className="muted">{t('usbank.intro', locale)}</p>
      <div className="card" data-testid="usbank-state" data-status={banking.status}>
        <strong>{t(bankingState(banking), locale)}</strong>
        {banking.status === 'not_linked' ? <p className="muted">{t('usbank.state.not_linked.explain', locale)}</p> : null}
        {banking.status === 'approved' && banking.last4 ? <p data-testid="usbank-last4">{t('usbank.account.last4', locale, { last4: banking.last4 })}</p> : null}
        {banking.status === 'approved' && banking.balance ? <p data-testid="usbank-balance">{t('usbank.account.balance', locale, { amount: fmt(banking.balance, locale) })}</p> : null}
        {banking.status === 'approved' ? <p className="muted">{t('usbank.account.transactions', locale)}</p> : null}
      </div>
      {canStart(landing, banking) ? <Start locale={locale} resume={banking.status !== 'not_linked'} /> : null}
      {canFund(banking) ? <Funding locale={locale} role={landing.role} me={partyIdOf(access)} items={funding.items} /> : null}
    </>
  );
}
