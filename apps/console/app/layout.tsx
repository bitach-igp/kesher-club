// Institution console shell (T-0608): environment banner and the tokens' palette. Screens I01-I14 arrive
// card by card; this card lands staff on their institution.
import type { ReactNode } from 'react';
import { theme } from '@kesher/tokens';
import { getConfig } from '../src/config.ts';

export const metadata = { title: 'Kesher Club institution console' };
// Pages render per request and read config then, never at build.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  const cfg = getConfig();
  const th = theme.light;
  const css = `
    :root { --bg: ${th.color.bg.canvas}; --surface: ${th.color.bg.surface}; --sunken: ${th.color.bg.sunken}; --text: ${th.color.text.primary}; --muted: ${th.color.text.secondary};
      --border: ${th.color.border.default}; --primary: ${th.color.action.primary}; --on-primary: ${th.color.text.onAction};
      --danger: ${th.color.status.danger}; --danger-bg: ${th.color.status.dangerSubtle}; --warning-bg: ${th.color.status.warningSubtle}; --radius: ${th.radius.md}px; }
    * { box-sizing: border-box; } body { margin: 0; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); }
    main { padding: 24px 32px; max-width: 960px; margin: 0 auto; } h1 { font-size: 22px; margin: 0 0 16px; }
    .banner { padding: 8px 32px; font-size: 13px; background: var(--sunken); } .banner.production { background: var(--danger-bg); color: var(--danger); } .banner.staging { background: var(--warning-bg); }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
    .muted { color: var(--muted); } .error { color: var(--danger); }
    button { padding: 8px 14px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
    button.primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); } button:disabled { opacity: .6; cursor: default; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; } dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; } dt { color: var(--muted); }
  `;
  return (
    <html lang="en">
      <head>
        <style>{css}</style>
      </head>
      <body>
        <div className={`banner ${cfg.CONSOLE_ENVIRONMENT}`} role="status">
          {cfg.CONSOLE_ENVIRONMENT.toUpperCase()} · Kesher Club institution console
        </div>
        <main>{children}</main>
      </body>
    </html>
  );
}
