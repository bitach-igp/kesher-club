// EventsPort (REQ-NOT-002): outbound Standard Webhooks to institutions. Headers webhook-id,
// webhook-timestamp, webhook-signature (HMAC-SHA256 "v1,<base64>"), per-endpoint secret with a 24 h
// rotation overlap, retries at 5 s, 5 m, 30 m, 2 h, 8 h, 24 h (then 72 h give-up), and a replay UI.

export type OutboundEventType =
  | 'member.onboarded'
  | 'membership.status_changed'
  | 'allowance.run.completed'
  | 'collection.paid'
  | 'payout.status_changed'
  | 'roster.import.completed';

export interface Endpoint {
  endpointId: string;
  institutionId: string;
  url: string;
  /** Standard Webhooks secret, "whsec_" + base64. Returned once at creation / rotation; stored encrypted. */
  secret: string;
  /** Previous secret, valid until this time (24 h overlap). */
  previousSecretValidUntil?: string;
  eventTypes: readonly OutboundEventType[];
  active: boolean;
}

export interface OutboundEvent {
  type: OutboundEventType;
  institutionId: string;
  /** Thin payload: ids only; receivers fetch details (Tab 3 §5). */
  payload: Record<string, string>;
}

export type AttemptStatus = 'pending' | 'succeeded' | 'failed' | 'exhausted';

export interface DeliveryAttempt {
  attemptId: string;
  messageId: string;
  endpointId: string;
  attemptNumber: number;
  status: AttemptStatus;
  responseStatus?: number;
  at: string;
  nextRetryAt?: string;
}

export interface EventsPort {
  createEndpoint(input: { institutionId: string; url: string; eventTypes: readonly OutboundEventType[] }, idempotencyKey: string): Promise<Endpoint>;
  rotateSecret(endpointId: string, idempotencyKey: string): Promise<Endpoint>;
  /** Enqueues to every active endpoint subscribed to the type. Idempotent by key: one message id per key. */
  send(event: OutboundEvent, idempotencyKey: string): Promise<{ messageId: string; attempts: readonly DeliveryAttempt[] }>;
  /** Re-sends an existing message to one endpoint (replay UI). */
  replay(messageId: string, endpointId: string, idempotencyKey: string): Promise<DeliveryAttempt>;
  listAttempts(messageId: string): Promise<readonly DeliveryAttempt[]>;
}

export type EventsErrorCode = 'UNKNOWN_ENDPOINT' | 'UNKNOWN_MESSAGE' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class EventsError extends Error {
  constructor(
    readonly code: EventsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventsError';
  }
}

/** Retry schedule from REQ-NOT-002, in milliseconds after the previous attempt. */
export const RETRY_SCHEDULE_MS: readonly number[] = [5_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000];
