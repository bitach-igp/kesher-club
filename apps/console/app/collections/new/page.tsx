// Bill members a fee (T-0629, REQ-INS-006): a description, an amount a member and a due date; every active
// member gets one fee item, which they pay from their purse. Finance staff only.
import { redirect } from 'next/navigation';
import { t } from '../../../src/i18n.ts';
import { requestContext } from '../../../src/request.ts';
import { BillMembers } from '../Bill.tsx';

export default async function BillPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  if (landing.role !== 'finance') redirect('/collections');
  return (
    <>
      <h1>{t('collections.bill', locale)}</h1>
      <BillMembers market={landing.institution.market} today={new Date().toISOString().slice(0, 10)} locale={locale} />
    </>
  );
}
