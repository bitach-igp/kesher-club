// Control panel over the simulator host (T-0009). Plain node:http, JSON in and out, plus one HTML
// page. Local and preview only: the host never runs in staging or prod (config refuses `sim` there).
import http from 'node:http';
import { SimulatorHost, type Simulators } from './host.ts';

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface PanelResponse {
  status: number;
  body: Json;
  contentType?: string;
}

const json = (status: number, body: Json): PanelResponse => ({ status, body });

/** Pure request handler so tests can drive it without sockets. */
export async function handle(host: SimulatorHost, method: string, url: string, rawBody = ''): Promise<PanelResponse> {
  const u = new URL(url, 'http://sim.local');
  const parts = u.pathname.split('/').filter(Boolean);
  const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

  if (method === 'GET' && parts.length === 0) return { status: 200, body: panelHtml(host), contentType: 'text/html; charset=utf-8' };
  if (method === 'GET' && parts[0] === 'health') return json(200, { ok: true, clock: host.clock.now().toISOString(), startedAt: host.startedAt });
  if (method === 'GET' && parts[0] === 'ports' && parts.length === 1) return json(200, host.ports());
  if (parts[0] === 'ports' && parts[1]) {
    const capability = parts[1] as keyof Simulators;
    if (!(capability in host.simulators)) return json(404, { error: 'unknown_port', capability });
    if (method === 'GET' && parts.length === 2) {
      const hooks = Object.fromEntries(Object.entries(host.hooks(capability)).map(([n, h]) => [n, { describe: h.describe, args: h.args }]));
      return json(200, { capability, fixtures: host.fixtures(capability), hooks, binding: host.registry.bindingFor(capability, 'IL') ?? null });
    }
    if (method === 'POST' && parts[2] === 'hooks' && parts[3]) {
      const hook = host.hooks(capability)[parts[3]];
      if (!hook) return json(404, { error: 'unknown_hook', hook: parts[3] });
      try {
        const args = hook.args.map((a) => String(body[a] ?? ''));
        const result = await hook.run(...args);
        return json(200, { ok: true, result: serialisable(result) });
      } catch (e) {
        const err = e as Error & { code?: string };
        return json(422, { ok: false, error: err.code ?? err.name, detail: err.message });
      }
    }
  }
  if (method === 'POST' && parts[0] === 'clock' && parts[1] === 'advance') {
    try {
      return json(200, { now: host.advanceClock(Number(body['ms'])) });
    } catch (e) {
      return json(422, { error: (e as Error).message });
    }
  }
  return json(404, { error: 'not_found' });
}

export function createServer(host: SimulatorHost): http.Server {
  return http.createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let out: PanelResponse;
    try {
      out = await handle(host, req.method ?? 'GET', req.url ?? '/', raw);
    } catch (e) {
      out = json(400, { error: 'bad_request', detail: (e as Error).message });
    }
    res.writeHead(out.status, { 'content-type': out.contentType ?? 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(out.contentType ? String(out.body) : JSON.stringify(out.body));
  });
}

/** bigint-safe JSON for hook results (Money.minor is a bigint). */
function serialisable(v: unknown): Json {
  return JSON.parse(JSON.stringify(v ?? null, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as Json;
}

function panelHtml(host: SimulatorHost): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = host
    .ports()
    .map((p) => {
      if (!p.running) return `<tr><td>${esc(p.port)}</td><td colspan="3"><em>${p.capability === 'agent-gateway' ? 'inbound; served by the API' : 'no simulator'}</em></td></tr>`;
      const cap = p.capability as keyof Simulators;
      const fixtures = host.fixtures(cap).map((f) => `<li><code>${esc(f.trigger)}</code> → ${esc(f.effect)}</li>`).join('');
      const hooks = Object.entries(host.hooks(cap))
        .map(([name, h]) => `<form data-cap="${cap}" data-hook="${name}"><strong>${name}</strong> <small>${esc(h.describe)}</small><br>${h.args.map((a) => `<input name="${a}" placeholder="${a}">`).join(' ')}<button>run</button><pre></pre></form>`)
        .join('');
      return `<tr><td>${esc(p.port)}</td><td>${p.flags.map(esc).join('<br>')}</td><td><ul>${fixtures}</ul></td><td>${hooks || '<em>none</em>'}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Kesher simulators</title>
<style>body{font:14px system-ui;margin:24px;color:#14233B;background:#FBF8F3}table{border-collapse:collapse;width:100%}td,th{border:1px solid #E3DCD0;padding:8px;vertical-align:top}code{background:#F3EEE5;padding:1px 4px;border-radius:4px}pre{margin:4px 0 0;white-space:pre-wrap;color:#56627A}input{width:9em}button{margin-left:4px}</style>
<h1>Simulators <small id="clock">${esc(host.clock.now().toISOString())}</small></h1>
<p>Every provider port, bound in <code>sim</code> mode for US and IL. Fixtures are deterministic inputs; hooks drive webhooks and decisions.
<button id="adv" data-ms="60000">+1 min</button> <button id="adv2" data-ms="86400000">+1 day</button></p>
<table><tr><th>Port</th><th>Flags</th><th>Fixtures</th><th>Hooks</th></tr>${rows}</table>
<script>
for (const f of document.querySelectorAll('form')) f.addEventListener('submit', async (e) => { e.preventDefault(); const body = Object.fromEntries(new FormData(f)); const r = await fetch('/ports/' + f.dataset.cap + '/hooks/' + f.dataset.hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); f.querySelector('pre').textContent = JSON.stringify(await r.json(), null, 2); });
for (const b of [document.getElementById('adv'), document.getElementById('adv2')]) b.addEventListener('click', async () => { const r = await fetch('/clock/advance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ms: Number(b.dataset.ms) }) }); document.getElementById('clock').textContent = (await r.json()).now; });
</script>`;
}
