// Expo push adapter (T-0802): NotifyPort for the `push` channel over the Expo Push API.
// Templates are rendered here (title/body per locale); DeviceNotRegistered maps to
// INVALID_RECIPIENT so the caller drops the token. Receipts back `getDelivery`.
import { IdempotencyStore, NotifyError, type Delivery, type Notification, type NotifyPort } from '@kesher/ports';

export interface PushTemplate {
  title: Record<'en' | 'he', string>;
  body: Record<'en' | 'he', string>;
}

export interface ExpoPushOptions {
  accessToken?: string;
  templates: Record<string, PushTemplate>;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export const EXPO_TOKEN = /^Expo(nent)?PushToken\[[\w-]+\]$/;

export function render(template: string, locale: 'en' | 'he', data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => data[k] ?? '');
}

export class ExpoPushNotifyAdapter implements NotifyPort {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly idem = new IdempotencyStore<Delivery>();
  private readonly receipts = new Map<string, Delivery>();

  private readonly opts: ExpoPushOptions;
  constructor(opts: ExpoPushOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.base = opts.baseUrl ?? 'https://exp.host/--/api/v2/push';
  }

  async send(n: Notification, idempotencyKey: string): Promise<Delivery> {
    if (n.channel !== 'push') throw new NotifyError('UNSUPPORTED_CHANNEL', `Expo push cannot send ${n.channel}`);
    if (!EXPO_TOKEN.test(n.to)) throw new NotifyError('VALIDATION_FAILED', 'Recipient must be an Expo push token');
    const t = this.opts.templates[n.template];
    if (!t) throw new NotifyError('VALIDATION_FAILED', `Unknown template ${n.template}`);
    return this.idem.run(idempotencyKey, async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.opts.accessToken ? { authorization: `Bearer ${this.opts.accessToken}` } : {}) },
          body: JSON.stringify([{ to: n.to, title: render(t.title[n.locale], n.locale, n.data), body: render(t.body[n.locale], n.locale, n.data), priority: n.category === 'security' || n.category === 'emergency' ? 'high' : 'default', channelId: n.category, data: { template: n.template } }]),
        });
      } catch {
        throw new NotifyError('PROVIDER_UNAVAILABLE', 'Expo push unreachable');
      }
      if (res.status === 429 || res.status >= 500) throw new NotifyError('PROVIDER_UNAVAILABLE', `Expo push returned ${res.status}`);
      const body = (await res.json()) as { data?: { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } }[]; errors?: { code: string }[] };
      const ticket = body.data?.[0];
      if (!ticket) throw new NotifyError('PROVIDER_UNAVAILABLE', 'Expo push returned no ticket');
      const messageId = ticket.id ?? `expo_err_${idempotencyKey}`;
      const d: Delivery =
        ticket.status === 'ok'
          ? { messageId, channel: 'push', status: 'queued' }
          : { messageId, channel: 'push', status: 'failed', failureCode: ticket.details?.error === 'DeviceNotRegistered' ? 'INVALID_RECIPIENT' : ticket.details?.error === 'MessageRateExceeded' ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE' };
      this.receipts.set(messageId, d);
      return d;
    });
  }

  async getDelivery(messageId: string): Promise<Delivery> {
    const known = this.receipts.get(messageId);
    if (!known) throw new NotifyError('UNKNOWN_MESSAGE', 'Unknown message id');
    if (known.status !== 'queued') return known;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/getReceipts`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ ids: [messageId] }) });
    } catch {
      return known;
    }
    if (!res.ok) return known;
    const body = (await res.json()) as { data?: Record<string, { status: 'ok' | 'error'; details?: { error?: string } }> };
    const r = body.data?.[messageId];
    if (!r) return known;
    const d: Delivery = r.status === 'ok' ? { messageId, channel: 'push', status: 'sent' } : { messageId, channel: 'push', status: 'failed', failureCode: r.details?.error === 'DeviceNotRegistered' ? 'INVALID_RECIPIENT' : 'PROVIDER_UNAVAILABLE' };
    this.receipts.set(messageId, d);
    return d;
  }
}
