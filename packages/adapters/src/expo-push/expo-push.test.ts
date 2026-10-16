import { describe, expect, it } from 'vitest';
import { notifyContract } from '@kesher/ports/contracts';
import { ExpoPushNotifyAdapter, render } from './expo-push.ts';

/** In-memory Expo Push API: tickets by token, receipts on request. */
function fakeExpo() {
  const sent: { to: string; title: string; body: string; priority: string }[] = [];
  let n = 0;
  const receipts = new Map<string, { status: 'ok' | 'error'; details?: { error: string } }>();
  const fetchImpl: typeof globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? 'null')) as never;
    if (url.endsWith('/send')) {
      const [m] = body as { to: string; title: string; body: string; priority: string }[];
      if (m!.to === 'ExponentPushToken[outage]') return new Response('bad gateway', { status: 502 });
      sent.push(m!);
      const id = `ticket_${++n}`;
      if (m!.to === 'ExponentPushToken[gone]') return Response.json({ data: [{ status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }] });
      receipts.set(id, m!.to === 'ExponentPushToken[later-gone]' ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' });
      return Response.json({ data: [{ status: 'ok', id }] });
    }
    if (url.endsWith('/getReceipts')) {
      const { ids } = body as { ids: string[] };
      return Response.json({ data: Object.fromEntries(ids.filter((i) => receipts.has(i)).map((i) => [i, receipts.get(i)])) });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, sent };
}

const templates = { 'money.received': { title: { en: 'Money received', he: 'כסף התקבל' }, body: { en: '{{from}} sent you {{amount}}', he: '{{from}} שלח לך {{amount}}' } } };
const make = () => new ExpoPushNotifyAdapter({ templates, fetch: fakeExpo().fetch });

notifyContract('expo-push', make, { channel: 'push', goodRecipient: 'ExponentPushToken[abc]', badRecipient: 'not-a-token', bouncingRecipient: 'ExponentPushToken[gone]', outageRecipient: 'ExponentPushToken[outage]' });

describe('ExpoPushNotifyAdapter specifics', () => {
  it('renders the localised template, sets high priority for security, and reports receipts', async () => {
    const expo = fakeExpo();
    const a = new ExpoPushNotifyAdapter({ templates, fetch: expo.fetch });
    const d = await a.send({ channel: 'push', to: 'ExponentPushToken[abc]', template: 'money.received', locale: 'he', data: { from: 'דני', amount: '₪50' }, category: 'security' }, 'k1');
    expect(d.status).toBe('queued');
    expect(expo.sent[0]).toMatchObject({ title: 'כסף התקבל', body: 'דני שלח לך ₪50', priority: 'high' });
    expect((await a.getDelivery(d.messageId)).status).toBe('sent');
    const later = await a.send({ channel: 'push', to: 'ExponentPushToken[later-gone]', template: 'money.received', locale: 'en', data: {}, category: 'money' }, 'k2');
    expect((await a.getDelivery(later.messageId))).toMatchObject({ status: 'failed', failureCode: 'INVALID_RECIPIENT' });
    expect(render('{{a}}-{{b}}', 'en', { a: 'x' })).toBe('x-');
  });

  it('refuses other channels and unknown templates', async () => {
    await expect(make().send({ channel: 'sms', to: '+972501234567', template: 'money.received', locale: 'en', data: {}, category: 'money' }, 'k3')).rejects.toMatchObject({ code: 'UNSUPPORTED_CHANNEL' });
    await expect(make().send({ channel: 'push', to: 'ExponentPushToken[abc]', template: 'nope', locale: 'en', data: {}, category: 'money' }, 'k4')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
