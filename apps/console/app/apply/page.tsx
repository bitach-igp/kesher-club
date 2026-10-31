// I01 org onboarding (T-0633, REQ-INS-016): the person's own application, or the form to start one while
// self-serve applications are open. Staff of an institution who never applied are sent home.
import { redirect } from 'next/navigation';
import { codeOf, memberApi } from '../../src/api.ts';
import type { Application } from '../../src/apply.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { Apply } from './Apply.tsx';

export default async function ApplyPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind === 'signed_out' || !access) redirect('/sign-in');
  const api = memberApi(getConfig().CONSOLE_API_URL, access);
  let application: Application | undefined;
  try {
    application = await api.myApplication();
  } catch (e) {
    if (codeOf(e) !== 'NOT_FOUND') throw e;
  }
  if (!application) {
    if (landing.kind === 'dashboard') redirect('/');
    const open = (await api.capabilities()).features['institutions.selfServe'] === true;
    if (!open) return <div className="card" role="status" data-testid="apply-off">{t('apply.off', locale)}</div>;
  }
  return (
    <>
      <h1>{t('apply.title', locale)}</h1>
      <p className="muted">{t('apply.intro', locale)}</p>
      <Apply locale={locale} initial={application} />
    </>
  );
}
