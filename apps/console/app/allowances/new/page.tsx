// A new allowance schedule (T-0627, REQ-INS-003): a name, an amount a member, a cadence; it pays every active
// member and shows the dates it would run. Finance staff only, like the run itself.
import { redirect } from 'next/navigation';
import { t } from '../../../src/i18n.ts';
import { requestContext } from '../../../src/request.ts';
import { NewSchedule } from '../Allowances.tsx';

export default async function NewSchedulePage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  if (landing.role !== 'finance') redirect('/allowances');
  return (
    <>
      <h1>{t('allowances.new', locale)}</h1>
      <NewSchedule market={landing.institution.market} today={new Date().toISOString().slice(0, 10)} locale={locale} />
    </>
  );
}
