// Twilio adapter (T-0802): NotifyPort for `sms` and `whatsapp` (WhatsApp Cloud via Twilio's
// channel, flag notify.whatsapp) through the Messages API with basic auth. Error codes:
// 21211/21614 → INVALID_RECIPIENT, 21610 → UNSUBSCRIBED, 429/5xx → PROVIDER_UNAVAILABLE.
import { IdempotencyStore, NotifyError, type Delivery, type Notification, type NotifyPort } from '@kesher/ports';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** Sending numbers / senders per channel, E.164 (sms) or `whatsapp:+…` (whatsapp). */
  from: { sms: string; whatsapp?: string };
  /** Our template name → body per locale with {{var}} placeholders (WhatsApp: a content SID is also accepted). */
  templates: Record<string, Record<'en' | 'he', string>>;
  fetch?: typeof fetch;
  baseUrl?: string;
}

const E164 = /^\+[1-9]\d{6,14}$/;
export const renderBody = (template: string, data: Record<string, string>): string => template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => data[k] ?? '');

export class TwilioNotifyAdapter implements NotifyPort {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly idem = new IdempotencyStore<Delivery>();
  private readonly known = new Map<string, Delivery>();

  private readonly opts: TwilioOptions;
  constructor(opts: TwilioOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.base = opts.baseUrl ?? 'https://api.twilio.com';
  }

  async send(n: Notification, idempotencyKey: string): Promise<Delivery> {
    if (n.channel !== 'sms' && n.channel !== 'whatsapp') throw new NotifyError('UNSUPPORTED_CHANNEL', `Twilio adapter cannot send ${n.channel}`);
    if (!E164.test(n.to)) throw new NotifyError('VALIDATION_FAILED', 'Recipient must be E.164');
    const body = this.opts.templates[n.template]?.[n.locale];
    if (!body) throw new NotifyError('VALIDATION_FAILED', `Unknown template ${n.template}`);
    const from = n.channel === 'whatsapp' ? this.opts.from.whatsapp : this.opts.from.sms;
    if (!from) throw new NotifyError('UNSUPPORTED_CHANNEL', 'No WhatsApp sender configured');
    return this.idem.run(idempotencyKey, async () => {
      const form = new URLSearchParams({ To: n.channel === 'whatsapp' ? `whatsapp:${n.to}` : n.to, From: from, Body: renderBody(body, n.data) });
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`, {
          method: 'POST',
          headers: { authorization: `Basic ${Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'idempotency-key': idempotencyKey },
          body: form.toString(),
        });
      } catch {
        throw new NotifyError('PROVIDER_UNAVAILABLE', 'Twilio unreachable');
      }
      if (res.status === 429 || res.status >= 500) throw new NotifyError('PROVIDER_UNAVAILABLE', `Twilio returned ${res.status}`);
      const payload = (await res.json()) as { sid?: string; status?: string; code?: number; message?: string };
      if (!res.ok) {
        const code = payload.code ?? 0;
        if (code === 21211 || code === 21614 || code === 21408) {
          const d: Delivery = { messageId: `tw_err_${idempotencyKey}`, channel: n.channel, status: 'failed', failureCode: 'INVALID_RECIPIENT' };
          this.known.set(d.messageId, d);
          return d;
        }
        if (code === 21610) {
          const d: Delivery = { messageId: `tw_err_${idempotencyKey}`, channel: n.channel, status: 'failed', failureCode: 'UNSUBSCRIBED' };
          this.known.set(d.messageId, d);
          return d;
        }
        if (res.status === 401 || res.status === 403) throw new NotifyError('PROVIDER_UNAVAILABLE', 'Twilio credentials rejected');
        throw new NotifyError('VALIDATION_FAILED', `Twilio rejected the message (code ${code})`);
      }
      const d: Delivery = { messageId: payload.sid ?? `tw_${idempotencyKey}`, channel: n.channel, status: payload.status === 'queued' || payload.status === 'accepted' ? 'queued' : 'sent' };
      this.known.set(d.messageId, d);
      return d;
    });
  }

  async getDelivery(messageId: string): Promise<Delivery> {
    const k = this.known.get(messageId);
    if (!k) throw new NotifyError('UNKNOWN_MESSAGE', 'Unknown message id');
    if (k.status === 'failed') return k;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages/${encodeURIComponent(messageId)}.json`, { headers: { authorization: `Basic ${Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64')}`, accept: 'application/json' } });
    } catch {
      return k;
    }
    if (!res.ok) return k;
    const m = (await res.json()) as { status?: string; error_code?: number | null };
    const d: Delivery = m.status === 'delivered' || m.status === 'sent' ? { messageId, channel: k.channel, status: 'sent' } : m.status === 'failed' || m.status === 'undelivered' ? { messageId, channel: k.channel, status: 'failed', failureCode: m.error_code === 30003 || m.error_code === 30005 ? 'INVALID_RECIPIENT' : 'PROVIDER_UNAVAILABLE' } : k;
    this.known.set(messageId, d);
    return d;
  }
}
