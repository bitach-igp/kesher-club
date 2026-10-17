import { describe, expect, it } from 'vitest';
import { notifyContract } from '@kesher/ports/contracts';
import { TwilioNotifyAdapter } from './twilio.ts';

function fakeTwilio() {
  const sent: Record<string, string>[] = [];
  let n = 0;
  const fetchImpl: typeof globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['authorization'] !== `Basic ${Buffer.from('ACxxx:tok').toString('base64')}`) return Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 });
    if (url.endsWith('/Messages.json')) {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      const to = (form['To'] ?? '').replace(/^whatsapp:/, '');
      if (to === '+15550000001') return new Response('', { status: 503 });
      if (to === '+15550000002') return Response.json({ code: 21211, message: 'Invalid To' }, { status: 400 });
      if (to === '+15550000003') return Response.json({ code: 21610, message: 'Unsubscribed' }, { status: 400 });
      sent.push(form);
      return Response.json({ sid: `SM${++n}`, status: 'queued' }, { status: 201 });
    }
    if (/\/Messages\/SM\d+\.json$/.test(url)) {
      const sid = url.split('/').at(-1)!.replace('.json', '');
      return Response.json({ sid, status: sid === 'SM2' ? 'undelivered' : 'delivered', error_code: sid === 'SM2' ? 30003 : null });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, sent };
}

const templates = {
  'auth.otp': { en: 'Your Kesher code is {{code}}', he: 'הקוד שלך: {{code}}' },
  'money.received': { en: '{{from}} sent you {{amount}}', he: '{{from}} שלח/ה לך {{amount}}' },
};
const make = () => new TwilioNotifyAdapter({ accountSid: 'ACxxx', authToken: 'tok', from: { sms: '+12025550100', whatsapp: 'whatsapp:+12025550100' }, templates, fetch: fakeTwilio().fetch });

notifyContract('twilio', make, { channel: 'sms', goodRecipient: '+972501234567', badRecipient: '0501234567', bouncingRecipient: '+15550000002', outageRecipient: '+15550000001' });
notifyContract('twilio', make, { channel: 'whatsapp', goodRecipient: '+972501234567', badRecipient: 'whatsapp:bad', outageRecipient: '+15550000001' });

describe('TwilioNotifyAdapter specifics', () => {
  it('renders the body per locale, prefixes WhatsApp recipients, and maps opt-outs and delivery failures', async () => {
    const tw = fakeTwilio();
    const a = new TwilioNotifyAdapter({ accountSid: 'ACxxx', authToken: 'tok', from: { sms: '+12025550100', whatsapp: 'whatsapp:+12025550100' }, templates, fetch: tw.fetch });
    const sms = await a.send({ channel: 'sms', to: '+972501234567', template: 'auth.otp', locale: 'he', data: { code: '246810' }, category: 'security' }, 'k1');
    expect(tw.sent[0]).toMatchObject({ To: '+972501234567', From: '+12025550100', Body: 'הקוד שלך: 246810' });
    expect((await a.getDelivery(sms.messageId)).status).toBe('sent');
    const wa = await a.send({ channel: 'whatsapp', to: '+972501234567', template: 'auth.otp', locale: 'en', data: { code: '1' }, category: 'security' }, 'k2');
    expect(tw.sent[1]).toMatchObject({ To: 'whatsapp:+972501234567', From: 'whatsapp:+12025550100' });
    expect(await a.getDelivery(wa.messageId)).toMatchObject({ status: 'failed', failureCode: 'INVALID_RECIPIENT' });
    expect(await a.send({ channel: 'sms', to: '+15550000003', template: 'auth.otp', locale: 'en', data: {}, category: 'marketing' }, 'k3')).toMatchObject({ status: 'failed', failureCode: 'UNSUBSCRIBED' });
  });

  it('refuses email, unknown templates, and WhatsApp without a sender; bad credentials are PROVIDER_UNAVAILABLE', async () => {
    await expect(make().send({ channel: 'email', to: 'x@example.com', template: 'auth.otp', locale: 'en', data: {}, category: 'money' }, 'k4')).rejects.toMatchObject({ code: 'UNSUPPORTED_CHANNEL' });
    await expect(make().send({ channel: 'sms', to: '+972501234567', template: 'nope', locale: 'en', data: {}, category: 'money' }, 'k5')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const noWa = new TwilioNotifyAdapter({ accountSid: 'ACxxx', authToken: 'tok', from: { sms: '+12025550100' }, templates, fetch: fakeTwilio().fetch });
    await expect(noWa.send({ channel: 'whatsapp', to: '+972501234567', template: 'auth.otp', locale: 'en', data: {}, category: 'money' }, 'k6')).rejects.toMatchObject({ code: 'UNSUPPORTED_CHANNEL' });
    const bad = new TwilioNotifyAdapter({ accountSid: 'ACxxx', authToken: 'wrong', from: { sms: '+12025550100' }, templates, fetch: fakeTwilio().fetch });
    await expect(bad.send({ channel: 'sms', to: '+972501234567', template: 'auth.otp', locale: 'en', data: {}, category: 'money' }, 'k7')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
