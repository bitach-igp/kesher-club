// Admin shell (T-0901, T-0615, T-0931): the areas in the side nav, environment banner, signed-in admin.
import type { ReactNode } from 'react';
import '@kesher/tokens/css';
import './styles.css';
import { getConfig } from '../src/config.ts';
import { currentActor } from '../src/ui/actor.ts';
import { AREAS } from '../src/ui/nav.ts';

export const metadata = { title: 'Kesher Club admin' };
// Every page renders per request and reads its config then, never at build: one image serves every
// environment and the build needs no settings or secrets (T-0915).
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cfg = getConfig();
  const actor = await currentActor().catch(() => undefined);
  return (
    <html lang="en">
      <body>
        <div className={`banner ${cfg.ADMIN_ENVIRONMENT}`} role="status">
          {cfg.ADMIN_ENVIRONMENT.toUpperCase()} · {actor ? `signed in as ${actor.subject}` : 'not signed in'}
        </div>
        <div className="shell">
          <nav aria-label="Areas">
            <a href="/">
              <strong>Kesher Club admin</strong>
            </a>
            {AREAS.map((a) => (
              <a key={a.code} href={a.href}>
                <span className="code">{a.code}</span>
                {a.label}
              </a>
            ))}
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
