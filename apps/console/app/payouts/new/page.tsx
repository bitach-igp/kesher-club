// A new payout (T-0612, T-0625): a withdrawal to the institution's own verified account, shown masked; the form
// asks for the amount and reference, and the payout takes a passkey step-up. Without a verified account, or
// while a change waits for Kesher compliance, it says so and offers no form. Finance staff only.
import { redirect } from 'next/navigation';
import { fromWire } from '@kesher/domain';
import { institutionApi } from '../../../src/api.ts';
import { fmt } from '../../../src/allowances.ts';
import { getConfig } from '../../../src/config.ts';
import { t } from '../../../src/i18n.ts';
import { destination } from '../../../src/payouts.ts';
import { requestContext } from '../../../src/request.ts';
import { NewPayout } from '../Payouts.tsx';

export default async function NewPayoutPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  if (landing.role !== 'finance') redirect('/payouts');
  const api = institutionApi(getConfig().CONSOLE_API_URL, access);
  const [page, account] = await Promise.all([api.payouts(landing.institution.id), api.payoutAccount(landing.institution.id)]);
  const to = destination(account);
  return (
    <>
      <h1>{t('payouts.new', locale)}</h1>
      <p className="muted" data-testid="payouts-available">{t('payouts.available', locale, { amount: fmt(page.available, locale) })}</p>
      {to.kind === 'own' ? (
        <>
          <p data-testid="payout-destination">{t('payouts.destination', locale, { holder: to.holderName, last4: to.last4 })}</p>
          <NewPayout available={fromWire(page.available).minor.toString()} locale={locale} />
        </>
      ) : (
        <p className="card" role="status" data-testid={`payout-destination-${to.kind}`}>{t(to.kind === 'pending' ? 'payouts.destination.pending' : 'payouts.destination.none', locale)}</p>
      )}
    </>
  );
}
