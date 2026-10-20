// Admin shell (T-0901, T-0615): the nine areas in the side nav, environment banner, signed-in admin.
import type { ReactNode } from 'react';
import { theme } from '@kesher/tokens';
import { getConfig } from '../src/config.ts';
import { currentActor } from '../src/ui/actor.ts';

export const metadata = { title: 'Kesher Club admin' };
// Every page renders per request and reads its config then, never at build: one image serves every
// environment and the build needs no settings or secrets (T-0915).
export const dynamic = 'force-dynamic';

const AREAS = [
  ['A01', 'Customer 360', '/customers'],
  ['A02', 'Compliance queues', '/compliance'],
  ['A03', 'Ops queues', '/compliance/complaints'],
  ['A04', 'Ledger explorer', '/ledger'],
  ['A05', 'Catalogue and pricing', '/catalogue'],
  ['A06', 'Plans and niches', '/plans'],
  ['A07', 'Providers and flags', '/providers'],
  ['A08', 'CMS and legal', '/legal'],
  ['A09', 'Institutions', '/institutions'],
] as const;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cfg = getConfig();
  const th = theme.light;
  const actor = await currentActor().catch(() => undefined);
  const css = `
    :root { --bg: ${th.color.bg.canvas}; --surface: ${th.color.bg.surface}; --sunken: ${th.color.bg.sunken}; --text: ${th.color.text.primary}; --muted: ${th.color.text.secondary};
      --border: ${th.color.border.default}; --primary: ${th.color.action.primary}; --on-primary: ${th.color.text.onAction};
      --danger: ${th.color.status.danger}; --danger-bg: ${th.color.status.dangerSubtle}; --warning: ${th.color.status.warning}; --warning-bg: ${th.color.status.warningSubtle};
      --success: ${th.color.status.success}; --success-bg: ${th.color.status.successSubtle}; --radius: ${th.radius.md}px; }
    * { box-sizing: border-box; } body { margin: 0; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); }
    a { color: var(--primary); } .shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
    nav { background: var(--surface); border-right: 1px solid var(--border); padding: 16px; } nav a { display: block; padding: 8px 10px; border-radius: var(--radius); text-decoration: none; color: var(--text); }
    nav a:hover { background: var(--sunken); } nav .code { color: var(--muted); font-size: 12px; margin-right: 6px; }
    main { padding: 24px 32px; max-width: 1200px; } h1 { font-size: 22px; margin: 0 0 16px; } h2 { font-size: 16px; margin: 24px 0 8px; }
    table { border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; } th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
    .banner { padding: 8px 32px; font-size: 13px; } .banner.production { background: var(--danger-bg); color: var(--danger); } .banner.staging { background: var(--warning-bg); } .banner.local, .banner.preview { background: var(--sunken); }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: var(--sunken); } .tag.red, .tag.breached, .tag.critical, .tag.high { background: var(--danger-bg); color: var(--danger); }
    .tag.amber, .tag.medium, .tag.degraded, .tag.blocked { background: var(--warning-bg); } .tag.green, .tag.live, .tag.closed, .tag.ready { background: var(--success-bg); color: var(--success); }
    .button, button { display: inline-block; padding: 6px 12px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; text-decoration: none; }
    .button.primary, button.primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); } button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
    .muted { color: var(--muted); } .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; } form.inline { display: inline; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; } dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; } dt { color: var(--muted); }
  `;
  return (
    <html lang="en">
      <head>
        <style>{css}</style>
      </head>
      <body>
        <div className={`banner ${cfg.ADMIN_ENVIRONMENT}`} role="status">
          {cfg.ADMIN_ENVIRONMENT.toUpperCase()} · {actor ? `signed in as ${actor.subject}` : 'not signed in'}
        </div>
        <div className="shell">
          <nav aria-label="Areas">
            <a href="/">
              <strong>Kesher Club admin</strong>
            </a>
            {AREAS.map(([code, label, href]) => (
              <a key={code} href={href}>
                <span className="code">{code}</span>
                {label}
              </a>
            ))}
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
