// T-1022: Appearance (System / Light / Dark), the one per-account preference the app writes too. Plain forms, no client script.
import { redirect } from 'next/navigation';
import { memberApi } from '../../src/api.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import { resolveTheme, THEME_OPTIONS } from '../../src/theme.ts';
import { setTheme } from './actions.ts';

export default async function AppearancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, locale } = await requestContext();
  if (!access) redirect('/sign-in');
  const q = await searchParams;
  const api = memberApi(getConfig().CONSOLE_API_URL, access);
  const current = await resolveTheme((signal) => api.preferences(signal), true);
  const label = THEME_OPTIONS.find((o) => o.value === current)!.key;
  return (
    <>
      <h1>{t('appearance.title', locale)}</h1>
      <p className="muted">{t('appearance.intro', locale)}</p>
      <p data-testid="appearance-current">{t('appearance.current', locale, { choice: t(label, locale) })}</p>
      {q['saved'] === '1' ? <p role="status" data-testid="appearance-saved">{t('appearance.saved', locale)}</p> : null}
      {q['error'] === '1' ? <p className="error" role="alert" data-testid="appearance-error">{t('appearance.error', locale)}</p> : null}
      <form action={setTheme} className="row">
        {THEME_OPTIONS.map((o) => (
          <button key={o.value} type="submit" name="theme" value={o.value} className={o.value === current ? 'primary' : undefined} aria-pressed={o.value === current} data-testid={`appearance-${o.value}`}>
            {t(o.key, locale)}
          </button>
        ))}
      </form>
    </>
  );
}
