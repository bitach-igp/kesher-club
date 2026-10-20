// A new payout (T-0612): payee name and IBAN, amount and reference; the IBAN is checked before the call,
// and the payout takes a passkey step-up. Finance staff only.
import { redirect } from 'next/navigation';
import { fromWire } from '@kesher/domain';
import { institutionApi } from '../../../src/api.ts';
import { fmt } from '../../../src/allowances.ts';
import { getConfig } from '../../../src/config.ts';
import { t } from '../../../src/i18n.ts';
import { requestContext } from '../../../src/request.ts';
import { NewPayout } from '../Payouts.tsx';

export default async function NewPayoutPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  if (landing.role !== 'finance') redirect('/payouts');
  const page = await institutionApi(getConfig().CONSOLE_API_URL, access).payouts(landing.institution.id);
  return (
    <>
      <h1>{t('payouts.new', locale)}</h1>
      <p className="muted" data-testid="payouts-available">{t('payouts.available', locale, { amount: fmt(page.available, locale) })}</p>
      <NewPayout available={fromWire(page.available).minor.toString()} locale={locale} />
    </>
  );
}
