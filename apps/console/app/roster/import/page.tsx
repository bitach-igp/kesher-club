// I05 import roster (T-0640, REQ-INS-001): upload a CSV, match its columns, read the validation report, and import
// only when every row passes. The file is read in the browser; its text is untrusted and shown as text.
import { redirect } from 'next/navigation';
import { t } from '../../../src/i18n.ts';
import { requestContext } from '../../../src/request.ts';
import { RosterImport } from './Import.tsx';

export default async function ImportPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  return (
    <>
      <h1>{t('import.title', locale)}</h1>
      <p className="muted">{t('import.intro', locale)}</p>
      <RosterImport locale={locale} />
    </>
  );
}
