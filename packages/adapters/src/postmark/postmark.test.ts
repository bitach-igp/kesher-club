import { describe, expect, it } from 'vitest';
import { notifyContract } from '@kesher/ports/contracts';
import { PostmarkNotifyAdapter } from './postmark.ts';

function fakePostmark() {
  const sent: Record<string, unknown>[] = [];
  let n = 0;
  const fetchImpl: typeof globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['x-postmark-server-token'] !== 'server-token') return Response.json({ ErrorCode: 10, Message: 'Bad token' }, { status: 401 });
    if (url.endsWith('/email/withTemplate')) {
      const m = JSON.parse(String(init?.body)) as { To: string; TemplateAlias: string };
      if (m.To === 'outage@example.com') return new Response('', { status: 503 });
      if (m.To === 'bounce@example.com') return Response.json({ ErrorCode: 406, Message: 'Inactive recipient' }, { status: 422 });
      if (m.TemplateAlias === 'broken') return Response.json({ ErrorCode: 1101, Message: 'Template missing' }, { status: 422 });
      sent.push(m);
      return Response.json({ MessageID: `pm_${++n}`, ErrorCode: 0, Message: 'OK' });
    }
    if (/\/messages\/outbound\/.+\/details$/.test(url)) {
      const id = decodeURIComponent(url.split('/').at(-2)!);
      return Response.json({ Status: 'Sent', MessageEvents: id === 'pm_2' ? [{ Type: 'Bounced' }] : [{ Type: 'Delivered' }] });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, sent };
}

const templates = { 'money.received': { en: 'money-received-en', he: 'money-received-he' }, broken: { en: 'broken', he: 'broken' } };
const make = () => new PostmarkNotifyAdapter({ serverToken: 'server-token', from: 'club@kesher.example', templates, fetch: fakePostmark().fetch });

notifyContract('postmark', make, { channel: 'email', goodRecipient: 'noa@example.com', badRecipient: 'not-an-email', bouncingRecipient: 'bounce@example.com', outageRecipient: 'outage@example.com' });

describe('PostmarkNotifyAdapter specifics', () => {
  it('uses the per-locale template alias, the broadcast stream for marketing, and reports later bounces', async () => {
    const pm = fakePostmark();
    const a = new PostmarkNotifyAdapter({ serverToken: 'server-token', from: 'club@kesher.example', templates, fetch: pm.fetch });
    const d1 = await a.send({ channel: 'email', to: 'noa@example.com', template: 'money.received', locale: 'he', data: { amount: '₪50' }, category: 'marketing' }, 'k1');
    expect(pm.sent[0]).toMatchObject({ TemplateAlias: 'money-received-he', MessageStream: 'broadcast', TemplateModel: { amount: '₪50' } });
    expect((await a.getDelivery(d1.messageId)).status).toBe('sent');
    const d2 = await a.send({ channel: 'email', to: 'dani@example.com', template: 'money.received', locale: 'en', data: {}, category: 'money' }, 'k2');
    expect(await a.getDelivery(d2.messageId)).toMatchObject({ status: 'failed', failureCode: 'INVALID_RECIPIENT' });
  });

  it('maps template errors to VALIDATION_FAILED and a bad token to PROVIDER_UNAVAILABLE', async () => {
    await expect(make().send({ channel: 'email', to: 'x@example.com', template: 'broken', locale: 'en', data: {}, category: 'money' }, 'k3')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const bad = new PostmarkNotifyAdapter({ serverToken: 'wrong', from: 'x@kesher.example', templates, fetch: fakePostmark().fetch });
    await expect(bad.send({ channel: 'email', to: 'x@example.com', template: 'money.received', locale: 'en', data: {}, category: 'money' }, 'k4')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
