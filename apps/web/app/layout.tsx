// The static site's shell (T-0048): no cookies, no analytics, no third-party scripts, no web fonts. The one script is /lang.js, same origin.
import type { ReactNode } from 'react';
import '@kesher/tokens/css';
import './styles.css';
import { COPY } from '../src/copy.ts';

export const metadata = {
  title: 'Kesher Club',
  description: COPY.en.tagline,
  referrer: 'strict-origin-when-cross-origin' as const,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <script src="/lang.js" />
      </head>
      <body>
        <a className="skip" href="#content">
          {COPY.en.skip} · {COPY.he.skip}
        </a>
        <header>
          <a className="brand" href="/">
            {COPY.en.brand}
          </a>
          <nav aria-label="Language">
            <a href="?lang=en" hrefLang="en" lang="en">
              {COPY.en.langName}
            </a>
            <a href="?lang=he" hrefLang="he" lang="he">
              {COPY.he.langName}
            </a>
          </nav>
        </header>
        <main id="content">{children}</main>
        <footer>
          <a href="/support">{COPY.en.support}</a> · <a href="/legal">{COPY.en.legal}</a>
          <br />
          <span lang="he" dir="rtl">
            <a href="/support">{COPY.he.support}</a> · <a href="/legal">{COPY.he.legal}</a>
          </span>
        </footer>
      </body>
    </html>
  );
}
