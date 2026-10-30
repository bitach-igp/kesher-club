import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import { PORTS, type BillingPort, type FxPort } from '@kesher/ports';
import { SimulatorHost } from './host.ts';
import { handle } from './server.ts';

describe('SimulatorHost', () => {
  it('runs a simulator for every port except the inbound agent gateway and binds both markets', () => {
    const host = new SimulatorHost();
    const ports = host.ports();
    expect(ports.length).toBe(PORTS.length);
    expect(ports.filter((p) => !p.running).map((p) => p.capability)).toEqual(['agent-gateway']);
    for (const p of ports.filter((p) => p.running)) {
      for (const market of ['US', 'IL'] as const) {
        expect(host.registry.bindingFor(p.capability, market)?.mode).toBe('sim');
        expect(host.registry.resolve(p.capability, market)).toBe(host.simulators[p.capability as keyof typeof host.simulators]);
      }
    }
  });

  it('the Billing simulator is reachable through the registry and its dunning hook emits a signed webhook', async () => {
    const host = new SimulatorHost();
    const billing = host.registry.resolve<BillingPort>('billing', 'US');
    const c = await billing.createCustomer({ partyId: 'p', email: 'funder@example.com' }, 'c1');
    const s = await billing.createSubscription({ customerId: c.customerId, planCode: 'club', price: money(4900n, 'USD'), termMonths: 10 }, 's1');
    const res = await handle(host, 'POST', '/ports/billing/hooks/failInvoice', JSON.stringify({ subscriptionId: s.subscriptionId, attempt: '2' }));
    expect(res.status).toBe(200);
    const hook = (res.body as { result: { headers: Record<string, string>; rawBody: string } }).result;
    const event = await billing.parseWebhook(hook.headers, hook.rawBody);
    expect(event).toMatchObject({ type: 'invoice.payment_failed', attempt: 2 });
    expect((await billing.get(s.subscriptionId)).status).toBe('past_due');
  });

  it('a job run from the panel answers JSON even when the job is not due and returns its marker symbol (T-0923)', async () => {
    const host = new SimulatorHost();
    const idle = Symbol('idle');
    const res = await handle(host, 'POST', '/jobs/nightly/run', '', { jobs: { names: ['nightly'], run: async () => idle } });
    expect(res).toMatchObject({ status: 200, body: { ok: true, job: 'nightly', result: 'idle' } });
  });

  it('advancing the clock ticks the host\'s jobs once, after the clock moved, so a rate valid for 15 minutes catches up (T-0923)', async () => {
    const host = new SimulatorHost();
    const before = host.clock.now().getTime();
    const seen: number[] = [];
    const jobs = { names: [], run: async () => undefined, onClockAdvanced: async () => void seen.push(host.clock.now().getTime()) };
    expect((await handle(host, 'POST', '/clock/advance', JSON.stringify({ ms: 86_400_000 }), { jobs })).status).toBe(200);
    expect(seen).toEqual([before + 86_400_000]);
    expect((await handle(host, 'POST', '/clock/advance', JSON.stringify({ ms: -1 }), { jobs })).status).toBe(422);
    expect(seen).toHaveLength(1);
  });

  it('one shared clock: advancing it expires FX quotes everywhere', async () => {
    const host = new SimulatorHost();
    const fx = host.registry.resolve<FxPort>('fx', 'IL');
    const q = await fx.quote({ from: money(100n, 'USD'), to: 'ILS', markupBps: 75n });
    const adv = await handle(host, 'POST', '/clock/advance', JSON.stringify({ ms: 31_000 }));
    expect(adv.status).toBe(200);
    await expect(fx.convert(q.quoteId, 'k')).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect((await handle(host, 'POST', '/clock/advance', JSON.stringify({ ms: -1 }))).status).toBe(422);
  });

  it('serves the catalogue, per-port fixtures and hooks, and 404s for unknown ports or hooks', async () => {
    const host = new SimulatorHost();
    expect((await handle(host, 'GET', '/ports')).status).toBe(200);
    const kyc = await handle(host, 'GET', '/ports/kyc');
    expect(kyc.body).toMatchObject({ capability: 'kyc', binding: { mode: 'sim' } });
    expect((kyc.body as { hooks: Record<string, unknown> }).hooks).toHaveProperty('decide');
    expect((await handle(host, 'GET', '/ports/nope')).status).toBe(404);
    expect((await handle(host, 'POST', '/ports/kyc/hooks/nope')).status).toBe(404);
    const bad = await handle(host, 'POST', '/ports/kyc/hooks/decide', JSON.stringify({ sessionId: 'missing' }));
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ error: 'UNKNOWN_SESSION' });
  });

  it('renders the control panel with every port and the health endpoint', async () => {
    const host = new SimulatorHost();
    const page = await handle(host, 'GET', '/');
    expect(page.contentType).toContain('text/html');
    for (const p of PORTS) expect(String(page.body)).toContain(p.port);
    expect((await handle(host, 'GET', '/health')).body).toMatchObject({ ok: true });
  });

  it('hook results are bigint-safe JSON', async () => {
    const host = new SimulatorHost();
    const ch = await host.simulators['card-issuing'].createCardholder({ partyId: 'p', kycSessionId: 'k' }, 'c');
    const card = await host.simulators['card-issuing'].issueCard({ cardholderId: ch.cardholderId, type: 'virtual', controls: { blockedMccs: [], atm: false, online: true, agentPurchases: 'off' } }, 'i');
    const res = await handle(host, 'POST', '/ports/card-issuing/hooks/authorize', JSON.stringify({ cardId: card.cardId, amountMinor: '1250', mcc: '5814' }));
    expect(res.status).toBe(200);
    const { rawBody } = (res.body as { result: { rawBody: string } }).result;
    expect(JSON.parse(rawBody)).toMatchObject({ cardId: card.cardId, amount: { minor: '1250', currency: 'USD' } });
  });
});
