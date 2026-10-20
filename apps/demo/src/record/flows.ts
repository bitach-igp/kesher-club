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
  /** The recording stack's readiness port (playwright.config.ts PORTS.ready). */
  stack: 'http://127.0.0.1:4099',
} as const;

const SIZE = { width: 1600, height: 900 };
/** How far the API's clock may run ahead of real time before the console's own sign-in stops working. */
const CLOCK_SKEW_MS = 60_000;

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

/**
 * A staff browser (not recorded) signed in to the console through the simulator identity provider. The
 * console runs under `next dev`, which compiles each route on its first request; the very first sign-in of
 * a run can bounce between /auth/sign-in and the proxy while that happens, so each attempt is bounded and
 * the sign-in starts over, up to three times.
 */
async function staffConsole(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1200, height: 1400 }, locale: 'en-US' });
  const page = await context.newPage();
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(URLS.console, { timeout: 90_000 });
      await page.getByText('Sign in with Identity Center').click({ timeout: 60_000 });
      await page.getByText('Sam Support').click({ timeout: 60_000 });
      await page.waitForURL((u) => u.origin === URLS.console && !u.pathname.startsWith('/auth'), { timeout: 60_000 });
      return { context, page };
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
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
      // After a clock move the console's own staff sign-in, signed at real time, no longer reaches the API;
      // the booked result is then read through the staff API at the API's clock, and the pane says so.
      if ((await panel.now()).getTime() - Date.now() > CLOCK_SKEW_MS) {
        const { balances } = await customerByApi(partyId);
        const line = (c: 'USD' | 'ILS') => `${c}  available ${money(balances[c].available, c)}  holds ${money(balances[c].holds, c)}`;
        await setPane(`<pre>${['Customer 360 through the staff API (the clock was moved)', '', line('USD'), line('ILS')].join('\n')}</pre>`, `· ${note}`);
        await page.waitForTimeout(1500);
        return balances;
      }
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

/**
 * Back to Home the way the member would, with the back button, never past the app's own first page: the
 * frame shares its session history with the harness page, so one back too many leaves the harness itself.
 */
export async function backToHome(rec: Recording): Promise<void> {
  const frame = rec.page.frameLocator('#member').locator('body');
  const home = rec.member.getByTestId('home-purse-USD');
  for (let i = 0; i < 4 && !(await home.isVisible()); i++) {
    const at = await frame.evaluate(() => location.pathname);
    if (at === '/' || at === '/home') break;
    await frame.evaluate(() => history.back());
    await rec.page.waitForTimeout(800);
  }
  try {
    await home.waitFor({ timeout: 30_000 });
  } catch {
    throw new Error(`Home did not show; the member app reads: ${(await frame.innerText()).slice(0, 400)}`);
  }
}

/**
 * The member opens the app again, as days later: the pane reloads from its first address. Used after the
 * clock moves, when the token the app holds was issued at the old clock and the app, judging expiry by
 * the browser's real clock, would not know to refresh it. Signs in again if the app asks.
 */
export async function reopenMember(rec: Recording): Promise<void> {
  await rec.page.evaluate(() => {
    const f = document.getElementById('member') as HTMLIFrameElement;
    f.src = f.getAttribute('src')!;
  });
  const signIn = rec.member.getByText('Sign in with passkey');
  const home = rec.member.getByTestId('home-purse-USD');
  await expect(signIn.or(home)).toBeVisible({ timeout: 60_000 });
  if (await signIn.isVisible()) await signInMember(rec);
}

/**
 * The member pane signs in as another persona, as a second phone would: the pane reloads with the persona
 * picked, and the session (in memory) starts empty.
 */
export async function switchMember(rec: Recording, persona: string): Promise<void> {
  await rec.page.evaluate((src) => ((document.getElementById('member') as HTMLIFrameElement).src = src), `${URLS.member}/?persona=${persona}`);
  await rec.member.getByText('Sign in with passkey').waitFor({ timeout: 60_000 });
  await signInMember(rec);
}

/**
 * Opens a screen of the member app by its address, inside the app (no reload, so the session stays), for a
 * screen that nothing links to yet. Captions say so.
 */
export async function openPath(rec: Recording, pathname: string): Promise<void> {
  await rec.page.frameLocator('#member').locator('body').evaluate((_b, to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, pathname);
}

/** M13 → M14 → M15 from Home: the recipient's member id, the purse, the amount, up to the confirm sheet. */
export async function sendFromHome(rec: Recording, to: string, currency: 'USD' | 'ILS', amount: string): Promise<void> {
  await rec.member.getByTestId('home-quick-send').click();
  await rec.member.getByTestId('recipient-input').fill(to);
  await rec.member.getByTestId('recipient-continue').click();
  await rec.member.getByTestId(`amount-purse-${currency}`).click();
  await rec.member.getByTestId('amount-input').fill(amount);
  await rec.member.getByTestId('amount-continue').click();
  await rec.member.getByTestId('screen-pay-confirm').waitFor();
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

/**
 * A tap at a till, from the vendor's side: the panel's card-issuing hook builds the processor's signed JIT
 * request for the member's card, and it is delivered to the API as the processor would deliver it.
 */
export async function cardSpend(partyId: string, amountMinor: bigint): Promise<{ result: string; reason?: string }> {
  const card = (await (await fetch(`${URLS.stack}/?cardOf=${partyId}`)).json()) as { processorCardId?: string };
  if (!card.processorCardId) throw new Error(`No active card for ${partyId}`);
  const signed = (await panel.hook('card-issuing', 'authorize', { cardId: card.processorCardId, amountMinor: amountMinor.toString(), mcc: '5814' })).result as { headers: Record<string, string>; rawBody: string };
  const res = await fetch(`${URLS.api}/jit/card-authorizations`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed.headers }, body: signed.rawBody });
  const decision = (await res.json()) as { result: string; reason?: string };
  if (!res.ok) throw new Error(`JIT answered ${res.status}: ${JSON.stringify(decision)}`);
  return decision;
}

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
export const usd = (minor: bigint): string => money(minor, 'USD');

/** "₪1,234.50" or "$1,234.50" (negative with U+2212), from minor units. */
export function money(minor: bigint, currency: 'USD' | 'ILS'): string {
  const abs = minor < 0n ? -minor : minor;
  return `${minor < 0n ? '−' : ''}${currency === 'USD' ? '$' : '₪'}${(abs / 100n).toLocaleString('en-US')}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/**
 * What an assistant's `propose_p2p` tool call does, run by the recording stack (stack.ts): a connected
 * assistant's grant for the member, then a pending intent through the intents service. The MCP gateway is
 * not mounted in the running API yet, so no assistant can reach it over HTTP; captions say so.
 */
export async function assistantPropose(input: { partyId: string; toPartyId: string; amount: { minor: string; currency: 'USD' | 'ILS' }; note?: string }): Promise<{ intentId: string; assistant: string }> {
  const res = await fetch(`${URLS.stack}/propose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const json = (await res.json()) as { intentId?: string; assistant?: string; error?: string };
  if (!res.ok || !json.intentId) throw new Error(`The stack's propose answered ${res.status}: ${JSON.stringify(json)}`);
  return { intentId: json.intentId, assistant: json.assistant! };
}
