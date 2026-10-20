// Shared steps of the recorded walkthroughs (T-0920). Each recording is one harness page, recorded by the
// browser itself: a caption bar, the member app (T-0033) on the left, the simulator panel (the vendor's
// side and the clock) in the middle, and the admin console's Customer 360 (T-0919) on the right for the
// booked result. The console cannot be framed (it answers X-Frame-Options: DENY), so its pane is a
// capture of the real console page, taken by a second, unrecorded browser signed in as staff.
// Steps with no member screen are API calls shown as captions ("API: POST …"), never as screens.
import { rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Browser, type BrowserContext, type FrameLocator, type Page } from '@playwright/test';
import { importJWK, SignJWT, type JWK } from 'jose';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.resolve(here, '../../out');

export const URLS = {
  api: 'http://localhost:3000/v1',
  panel: 'http://localhost:4010',
  member: 'http://localhost:8081',
  console: 'http://localhost:3100',
} as const;

const SIZE = { width: 1600, height: 900 };

/** "$1,234.50", "₪367.22", "−$3.00" → minor units. The money on a screen, as the ledger would count it. */
export function minorOf(text: string): bigint {
  const m = /([−-])?\s*[$₪]\s*([\d,]+)(?:\.(\d{2}))?/.exec(text);
  if (!m) throw new Error(`No amount in "${text}"`);
  const minor = BigInt(m[2]!.replace(/,/g, '')) * 100n + BigInt(m[3] ?? '0');
  return m[1] ? -minor : minor;
}

export type Balances = Record<'USD' | 'ILS', { available: bigint; holds: bigint }>;

export interface Recording {
  page: Page;
  member: FrameLocator;
  /** The caption bar: what the viewer is looking at, in words. */
  caption(text: string): Promise<void>;
  /** Customer 360 in the console, captured into the right pane; its balances as the console shows them. */
  console360(partyId: string, note: string): Promise<Balances>;
  /** The right pane as text, for a booked result read through the staff API (see `customerByApi`). */
  consoleText(title: string, lines: readonly string[]): Promise<void>;
  /** Reloads the panel pane, so its clock shows the time the API now runs on. */
  refreshPanel(): Promise<void>;
  /** Closes the recording and names its video `REC-NN-<name>.webm` under out/. */
  finish(): Promise<string>;
}

const harnessHtml = (title: string, persona: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;background:#0f172a;color:#f8fafc;font:15px/1.4 system-ui,sans-serif;height:100vh;display:flex;flex-direction:column}
#cap{padding:10px 16px;min-height:52px;border-bottom:1px solid #334155}#cap b{color:#fbbf24;margin-right:8px}
main{flex:1;display:flex;gap:8px;padding:8px;min-height:0}section{display:flex;flex-direction:column;min-width:0}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;margin:0 0 6px}
iframe,#c360{flex:1;border:0;border-radius:8px;background:#fff}#c360{overflow:auto;color:#0f172a;padding:0}
#c360 img{width:100%;display:block}#c360 pre{margin:12px;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap}</style></head>
<body><div id="cap"><b>${title}</b><span id="text">Starting…</span></div>
<main><section style="width:420px"><h2>Member app (T-0033)</h2><iframe id="member" src="${URLS.member}/?persona=${persona}"></iframe></section>
<section style="flex:1"><h2>Simulator panel: the vendor's side and the clock</h2><iframe id="panel" src="${URLS.panel}/"></iframe></section>
<section style="width:560px"><h2>Console · Customer 360 (T-0919) <span id="note"></span></h2><div id="c360"><pre>Not read yet.</pre></div></section></main></body></html>`;

/** A staff browser (not recorded) signed in to the console through the simulator identity provider. */
async function staffConsole(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1200, height: 1400 }, locale: 'en-US' });
  const page = await context.newPage();
  await page.goto(URLS.console);
  await page.getByText('Sign in with Identity Center').click();
  await page.getByText('Sam Support').click();
  await page.waitForURL(`${URLS.console}/**`);
  return { context, page };
}

export async function openRecording(browser: Browser, rec: { id: string; name: string; title: string; persona: string }): Promise<Recording> {
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: path.join(OUT, 'raw'), size: SIZE }, locale: 'en-US', timezoneId: 'Asia/Jerusalem' });
  // A real local server, not page.route: Chromium counts an intercepted page as public, and its Private
  // Network Access checks then refuse to frame the apps on localhost.
  const html = harnessHtml(`${rec.id} ${rec.title}`, rec.persona);
  const harness = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html));
  await new Promise<void>((resolve) => harness.listen(0, 'localhost', resolve));
  const page = await context.newPage();
  await page.goto(`http://localhost:${(harness.address() as AddressInfo).port}/rec`);
  const staff = await staffConsole(browser);
  const setPane = (html: string, note: string) => page.evaluate(([h, n]) => {
    document.getElementById('c360')!.innerHTML = h!;
    document.getElementById('note')!.textContent = n!;
  }, [html, note]);
  return {
    page,
    member: page.frameLocator('#member'),
    async caption(text) {
      await page.evaluate((t) => (document.getElementById('text')!.textContent = t), text);
      await page.waitForTimeout(1200); // long enough to read on the video
    },
    async console360(partyId, note) {
      await staff.page.goto(`${URLS.console}/customers/${partyId}`);
      const card = staff.page.locator('.card', { has: staff.page.getByRole('heading', { name: 'Balances' }) });
      await card.waitFor();
      const rows = await card.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '')));
      const balances = Object.fromEntries(rows.map(([currency, available, holds]) => [currency, { available: minorOf(available!), holds: minorOf(holds!) }])) as Balances;
      const png = await staff.page.locator('main').screenshot();
      await setPane(`<img alt="Customer 360" src="data:image/png;base64,${png.toString('base64')}">`, `· ${note}`);
      await page.waitForTimeout(1500);
      return balances;
    },
    async consoleText(title, lines) {
      const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
      await setPane(`<pre>${esc([title, '', ...lines].join('\n'))}</pre>`, '· staff API');
      await page.waitForTimeout(1500);
    },
    async refreshPanel() {
      await page.frameLocator('#panel').locator('body').evaluate(() => location.reload());
    },
    async finish() {
      const video = page.video();
      await page.waitForTimeout(1500);
      await context.close();
      await staff.context.close();
      await new Promise((resolve) => harness.close(resolve));
      if (!video) throw new Error('No video was recorded');
      const target = path.join(OUT, `${rec.id}-${rec.name}.webm`);
      await rename(await video.path(), target);
      return target;
    },
  };
}

/** Signs the persona in to the member app with its seeded passkey and waits for Home. */
export async function signInMember(rec: Recording): Promise<void> {
  await rec.member.getByText('Sign in with passkey').click();
  await rec.member.getByTestId('home-purse-USD').waitFor({ timeout: 60_000 });
}

/** The purse's available balance on the member app's Home, in minor units. */
export async function homeAvailable(rec: Recording, currency: 'USD' | 'ILS'): Promise<bigint> {
  const text = await rec.member.getByTestId(`home-purse-${currency}`).innerText();
  return minorOf(text);
}

// ---- the panel: the vendor's side and the clock ----

async function panelPost(pathname: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${URLS.panel}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(`Panel ${pathname} answered ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export const panel = {
  /** Moves the one clock the API, the jobs and the simulators share. */
  advance: (ms: number) => panelPost('/clock/advance', { ms }) as Promise<{ now: string }>,
  /** Runs a job now, on that clock, instead of waiting for its timer. */
  runJob: (name: string) => panelPost(`/jobs/${name}/run`, {}),
  hook: (capability: string, hook: string, args: Record<string, string>) => panelPost(`/ports/${capability}/hooks/${hook}`, args) as Promise<{ ok: boolean; result: unknown }>,
  /** The API's clock, read from the panel. */
  now: async () => new Date(((await (await fetch(`${URLS.panel}/health`)).json()) as { clock: string }).clock),
};

// ---- the staff API, for steps with no screen and reads after the clock moved ----

/**
 * Calls the admin API as staff, signing the console's 5-minute staff token with the run's local key
 * (playwright.config.ts). It signs at the API's clock, so it still works after the panel moved that clock
 * days ahead, which the console itself, signing at real time, cannot.
 */
export async function staffApi<T>(method: string, pathname: string, opts: { subject?: string; roles?: string[]; body?: unknown; key?: string } = {}): Promise<T> {
  const jwk = JSON.parse(recordEnv('RECORD_STAFF_KEY')) as JWK;
  const kid = recordEnv('RECORD_STAFF_KID');
  const at = Math.floor((await panel.now()).getTime() / 1000);
  const token = await new SignJWT({ roles: opts.roles ?? ['support'], sid: `record:${opts.subject ?? 'staff-support-1'}` })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer('kesher-admin')
    .setAudience('kesher-api:admin')
    .setSubject(opts.subject ?? 'staff-support-1')
    .setIssuedAt(at)
    .setExpirationTime(at + 300)
    .sign(await importJWK(jwk, 'ES256'));
  const res = await fetch(`${URLS.api}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.key ? { 'idempotency-key': opts.key } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${pathname} answered ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** A value playwright.config.ts put in the environment for this run; missing means the config did not run. */
function recordEnv(name: 'RECORD_STAFF_KEY' | 'RECORD_STAFF_KID'): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run the recordings through playwright.config.ts`);
  return v;
}

/** A persona's party id, found the way support finds a member: by their phone number. */
export async function partyByPhone(phone: string): Promise<string> {
  const r = await staffApi<{ items: { partyId: string }[] }>('GET', `/admin/customers?q=${encodeURIComponent(phone)}`);
  expect(r.items).toHaveLength(1);
  return r.items[0]!.partyId;
}

/** Customer 360 through the staff API: the purses as the ledger holds them. */
export async function customerByApi(partyId: string): Promise<{ balances: Balances; cards: { id: string; last4: string; status: string }[] }> {
  const c = await staffApi<{ purses: { currency: 'USD' | 'ILS'; available: { minor: string }; holds: { minor: string } }[]; cards: { id: string; last4: string; status: string }[] }>('GET', `/admin/customers/${partyId}`);
  return { balances: Object.fromEntries(c.purses.map((p) => [p.currency, { available: BigInt(p.available.minor), holds: BigInt(p.holds.minor) }])) as Balances, cards: c.cards };
}

/** "$1,234.50" for a caption, from minor units. */
export const usd = (minor: bigint): string => `$${(minor / 100n).toLocaleString('en-US')}.${(minor % 100n).toString().padStart(2, '0')}`;
