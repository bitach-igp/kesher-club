// Postmark adapter (T-0802): NotifyPort for the `email` channel via Postmark templates (alias per
// template per locale). Error 406 (inactive recipient) → INVALID_RECIPIENT; 300 → VALIDATION_FAILED.
import { IdempotencyStore, NotifyError, type Delivery, type Notification, type NotifyPort } from '@kesher/ports';

export interface PostmarkOptions {
  serverToken: string;
  from: string;
  /** Our template name → Postmark template alias per locale. */
  templates: Record<string, Record<'en' | 'he', string>>;
  messageStream?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PostmarkNotifyAdapter implements NotifyPort {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly idem = new IdempotencyStore<Delivery>();
  private readonly known = new Map<string, Delivery>();

  private readonly opts: PostmarkOptions;
  constructor(opts: PostmarkOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.base = opts.baseUrl ?? 'https://api.postmarkapp.com';
  }

  async send(n: Notification, idempotencyKey: string): Promise<Delivery> {
    if (n.channel !== 'email') throw new NotifyError('UNSUPPORTED_CHANNEL', `Postmark cannot send ${n.channel}`);
    if (!EMAIL.test(n.to)) throw new NotifyError('VALIDATION_FAILED', 'Recipient must be an email address');
    const alias = this.opts.templates[n.template]?.[n.locale];
    if (!alias) throw new NotifyError('VALIDATION_FAILED', `Unknown template ${n.template}`);
    return this.idem.run(idempotencyKey, async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/email/withTemplate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-postmark-server-token': this.opts.serverToken },
          body: JSON.stringify({ From: this.opts.from, To: n.to, TemplateAlias: alias, TemplateModel: n.data, MessageStream: this.opts.messageStream ?? (n.category === 'marketing' ? 'broadcast' : 'outbound'), Tag: n.category, Metadata: { idempotencyKey } }),
        });
      } catch {
        throw new NotifyError('PROVIDER_UNAVAILABLE', 'Postmark unreachable');
      }
      if (res.status === 429 || res.status >= 500) throw new NotifyError('PROVIDER_UNAVAILABLE', `Postmark returned ${res.status}`);
      const body = (await res.json()) as { MessageID?: string; ErrorCode?: number; Message?: string };
      if (res.status === 422 || (body.ErrorCode ?? 0) !== 0) {
        const code = body.ErrorCode ?? 0;
        const messageId = `pm_err_${idempotencyKey}`;
        if (code === 406) {
          const d: Delivery = { messageId, channel: 'email', status: 'failed', failureCode: 'INVALID_RECIPIENT' };
          this.known.set(messageId, d);
          return d;
        }
        if (code === 300 || code === 1101) throw new NotifyError('VALIDATION_FAILED', `Postmark rejected the message (code ${code})`);
        throw new NotifyError('PROVIDER_UNAVAILABLE', `Postmark error ${code}`);
      }
      const d: Delivery = { messageId: body.MessageID ?? `pm_${idempotencyKey}`, channel: 'email', status: 'sent' };
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
      res = await this.fetchImpl(`${this.base}/messages/outbound/${encodeURIComponent(messageId)}/details`, { headers: { accept: 'application/json', 'x-postmark-server-token': this.opts.serverToken } });
    } catch {
      return k;
    }
    if (!res.ok) return k;
    const body = (await res.json()) as { Status?: string; MessageEvents?: { Type: string }[] };
    const bounced = body.MessageEvents?.some((e) => e.Type === 'Bounced');
    const d: Delivery = bounced ? { messageId, channel: 'email', status: 'failed', failureCode: 'INVALID_RECIPIENT' } : k;
    this.known.set(messageId, d);
    return d;
  }
}
