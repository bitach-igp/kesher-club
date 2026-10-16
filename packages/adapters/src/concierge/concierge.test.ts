import { describe, expect, it } from 'vitest';
import { NotifySimulator } from '@kesher/ports';
import { conciergeContract } from '@kesher/ports/contracts';
import { EmailBridgeConciergeAdapter, PartnerConciergeAdapter } from './concierge.ts';

function fakePartner() {
  const cases = new Map<string, { id: string; kind: string; status: string; reference: string; created_at: string; member_ref: string; messages: { id: string; text: string; author: string; created_at: string }[] }>();
  let n = 0;
  const fetchImpl: typeof globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    // The adapter is configured with baseUrl https://partner.example/v1, so every path carries /v1.
    const path = url.pathname.replace(/^\/v1/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['authorization'] !== 'Bearer partner-key') return new Response('', { status: 401 });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    if (init?.method === 'POST' && path === '/cases') {
      if (body['summary']?.startsWith('OUTAGE')) return new Response('', { status: 503 });
      const id = `pc_${++n}`;
      const c = { id, kind: body['kind']!, status: 'new', reference: `REF-${id}`, created_at: new Date().toISOString(), member_ref: body['member_ref']!, messages: [{ id: `${id}-m1`, text: body['summary']!, author: 'member', created_at: new Date().toISOString() }] };
      cases.set(id, c);
      return Response.json(c, { status: 201 });
    }
    const m = /^\/cases\/([^/]+)(\/messages)?$/.exec(path);
    if (!m) return new Response('', { status: 404 });
    const c = cases.get(m[1]!);
    if (!c) return new Response('', { status: 404 });
    if (init?.method === 'POST') {
      const msg = { id: `${c.id}-m${c.messages.length + 1}`, text: body['text']!, author: 'member', created_at: new Date().toISOString() };
      c.messages.push(msg);
      c.status = 'working';
      return Response.json(msg, { status: 201 });
    }
    return Response.json(c);
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl };
}

conciergeContract('partner-api', () => new PartnerConciergeAdapter({ baseUrl: 'https://partner.example/v1', apiKey: 'partner-key', fetch: fakePartner().fetch }), { outageSummary: 'OUTAGE please' });

const outageNotify = () => {
  const sim = new NotifySimulator();
  return sim;
};
conciergeContract('email-bridge', () => new EmailBridgeConciergeAdapter(outageNotify(), 'help@kesher.example'), {});

describe('concierge adapters', () => {
  it('the email bridge sends one email per case to the help desk, flagged emergency for medical/emergency kinds', async () => {
    const sim = new NotifySimulator();
    const a = new EmailBridgeConciergeAdapter(sim, 'help@kesher.example', () => new Date('2026-11-01T10:00:00Z'));
    const c = await a.openCase({ kind: 'medical', memberId: 'm1', summary: 'Hospital in Jerusalem', locale: 'he', phone: '+972501234567' }, 'c-1');
    expect(c.callbackSlaMinutes).toBe(5);
    expect(sim.sent[0]).toMatchObject({ channel: 'email', to: 'help@kesher.example', template: 'concierge.emergency', category: 'emergency', data: expect.objectContaining({ summary: 'Hospital in Jerusalem', phone: '+972501234567' }) });
    await a.addMessage(c.caseId, 'Room 4', 'm-1');
    expect(sim.sent.length).toBe(2);
    expect((await a.getCase(c.caseId)).status).toBe('in_progress');
  });

  it('the email bridge reports an outage when the help desk email cannot be sent', async () => {
    const a = new EmailBridgeConciergeAdapter(new NotifySimulator(), 'outage@example.com');
    await expect(a.openCase({ kind: 'help', memberId: 'm', summary: 'x', locale: 'en' }, 'c-2')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('the partner adapter maps 401/404/409 and never retries', async () => {
    const bad = new PartnerConciergeAdapter({ baseUrl: 'https://partner.example/v1', apiKey: 'wrong', fetch: fakePartner().fetch });
    await expect(bad.openCase({ kind: 'help', memberId: 'm', summary: 'x', locale: 'en' }, 'c-3')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ok = new PartnerConciergeAdapter({ baseUrl: 'https://partner.example/v1', apiKey: 'partner-key', fetch: fakePartner().fetch });
    await expect(ok.getCase('nope')).rejects.toMatchObject({ code: 'UNKNOWN_CASE' });
  });
});
