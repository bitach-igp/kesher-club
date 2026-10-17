// NotifyPort simulator: records every send so tests can assert on it. Fixtures: recipient
// "+15550000001" or "outage@example.com" -> PROVIDER_UNAVAILABLE; "bounce@example.com" ->
// failed INVALID_RECIPIENT; a recipient ending ":unsub" -> failed UNSUBSCRIBED.
import { IdempotencyStore, Sequence } from './base.ts';
import { NotifyError, type Delivery, type Notification, type NotifyPort } from './notify.ts';

export class NotifySimulator implements NotifyPort {
  private readonly deliveries = new Map<string, Delivery>();
  private readonly idem = new IdempotencyStore<Delivery>();
  private readonly ids = new Sequence('msg');
  /** Test hook: every notification actually sent, in order. */
  readonly sent: (Notification & { messageId: string })[] = [];

  async send(n: Notification, key: string): Promise<Delivery> {
    if (n.to === '+15550000001' || n.to === 'outage@example.com') throw new NotifyError('PROVIDER_UNAVAILABLE', 'Simulated channel outage');
    if (!n.to || !n.template) throw new NotifyError('VALIDATION_FAILED', 'Recipient and template required');
    if (n.channel === 'email' && !n.to.includes('@')) throw new NotifyError('VALIDATION_FAILED', 'Email recipient');
    if ((n.channel === 'sms' || n.channel === 'whatsapp') && !/^\+\d{7,15}$/.test(n.to)) throw new NotifyError('VALIDATION_FAILED', 'E.164 recipient');
    if (n.channel === 'push' && !/^ExponentPushToken\[[\w-]+\]$/.test(n.to)) throw new NotifyError('VALIDATION_FAILED', 'Expo push token');
    return this.idem.run(key, async () => {
      const messageId = this.ids.next();
      let d: Delivery = { messageId, channel: n.channel, status: 'sent' };
      if (n.to === 'bounce@example.com') d = { messageId, channel: n.channel, status: 'failed', failureCode: 'INVALID_RECIPIENT' };
      else if (n.to.endsWith(':unsub')) d = { messageId, channel: n.channel, status: 'failed', failureCode: 'UNSUBSCRIBED' };
      else this.sent.push({ ...n, messageId });
      this.deliveries.set(messageId, d);
      return d;
    });
  }

  async getDelivery(messageId: string): Promise<Delivery> {
    const d = this.deliveries.get(messageId);
    if (!d) throw new NotifyError('UNKNOWN_MESSAGE', messageId);
    return { ...d };
  }
}
