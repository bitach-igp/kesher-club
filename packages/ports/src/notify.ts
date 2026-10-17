// NotifyPort (REQ-NOT-001): one port, four channels (Expo push, Postmark email, Twilio SMS,
// WhatsApp Cloud API). Preferences and quiet hours are applied by the NotifyService (T-0801) before
// a message reaches an adapter; the adapter only delivers.

export type Channel = 'push' | 'email' | 'sms' | 'whatsapp';
/** Security and emergency messages bypass quiet hours and opt-outs (REQ-NOT-001). */
export type Category = 'security' | 'emergency' | 'money' | 'service' | 'marketing';

export interface Notification {
  channel: Channel;
  /** Expo push token, email address, or E.164 number. Never logged in full. */
  to: string;
  template: string;
  locale: 'en' | 'he';
  /** Template data; values from merchants or other users are untrusted text. */
  data: Record<string, string>;
  category: Category;
}

export interface Delivery {
  messageId: string;
  channel: Channel;
  status: 'queued' | 'sent' | 'failed';
  failureCode?: 'INVALID_RECIPIENT' | 'UNSUBSCRIBED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE';
}

export interface NotifyPort {
  /** Idempotent by key: a replayed send returns the first delivery, never a second message. */
  send(notification: Notification, idempotencyKey: string): Promise<Delivery>;
  getDelivery(messageId: string): Promise<Delivery>;
}

export type NotifyErrorCode = 'UNKNOWN_MESSAGE' | 'UNSUPPORTED_CHANNEL' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class NotifyError extends Error {
  constructor(
    readonly code: NotifyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotifyError';
  }
}
