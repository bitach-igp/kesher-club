// Institution console shell (T-0608): environment banner; styles come from the token variables and app/styles.css (T-0675). Screens I01-I14 arrive
// card by card; this card lands staff on their institution.
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import '@kesher/tokens/css';
import './styles.css';
import { getConfig } from '../src/config.ts';
import { dirOf, localeFrom, t } from '../src/i18n.ts';
import { showsDeposits } from '../src/deposits.ts';
import { showsUsBanking } from '../src/us-banking.ts';
import { showsAccount } from '../src/statement.ts';
import { decodeLanding, LANDING_HEADER } from '../src/session.ts';

export const metadata = { title: 'Kesher Club institution console' };
// Pages render per request and read config then, never at build.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cfg = getConfig();
  const h = await headers();
  const locale = localeFrom(h.get('accept-language'));
  const landing = decodeLanding(h.get(LANDING_HEADER));
  const signedIn = landing.kind === 'dashboard';
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body>
        <div className={`banner ${cfg.CONSOLE_ENVIRONMENT}`} role="status">
          {cfg.CONSOLE_ENVIRONMENT.toUpperCase()} · Kesher Club institution console
        </div>
        {signedIn ? (
          <nav aria-label="Console">
            <a href="/">{t('nav.home', locale)}</a>
            <a href="/roster">{t('nav.roster', locale)}</a>
            <a href="/cohorts">{t('nav.cohorts', locale)}</a>
            <a href="/allowances">{t('nav.allowances', locale)}</a>
            <a href="/collections">{t('nav.collections', locale)}</a>
            <a href="/payouts">{t('nav.payouts', locale)}</a>
            {showsDeposits(landing) ? <a href="/deposits">{t('nav.deposits', locale)}</a> : null}
            {showsUsBanking(landing) ? <a href="/us-banking">{t('nav.usbank', locale)}</a> : null}
            <a href="/team">{t('nav.team', locale)}</a>
            {landing.kind === 'dashboard' && showsAccount(landing.role) ? <a href="/account">{t('nav.account', locale)}</a> : null}
          </nav>
        ) : null}
        <main>{children}</main>
      </body>
    </html>
  );
}
