// providerWebhook (T-0204): verify → store (dedupe by event id) → process → 200. A forged
// signature is stored (forensics) and answered 401 without processing. Processing is a function
// per provider that must be idempotent; its journals use `${provider}:${eventId}` as the key, so
// a replayed webhook, processed twice, yields exactly one journal (REQ-LED-003).
import { DomainError } from '@kesher/domain';
import { HttpError, ok, route, type Handler, type HttpRequest, type ProblemBody } from '../http.ts';
import type { InboundEvent, InboundEventStore } from './store.ts';
import type { WebhookVerifier } from './verify.ts';

export type Processor = (event: InboundEvent) => Promise<void>;

export interface ProviderBinding {
  verifier: WebhookVerifier;
  /** Processors run after the event is stored; failures are recorded and retried by replay. */
  process: Processor;
}

export class WebhookRouter {
  private readonly providers = new Map<string, ProviderBinding>();
  constructor(private readonly store: InboundEventStore) {}

  bind(provider: string, binding: ProviderBinding): void {
    this.providers.set(provider, binding);
  }

  /** The HTTP handler for POST /hooks/{provider}. */
  handler(): Handler<unknown, { eventId: string; duplicate: boolean } | ProblemBody> {
    return route(async (req: HttpRequest) => {
      const provider = req.params['provider'] ?? '';
      const binding = this.providers.get(provider);
      if (!binding) throw new DomainError('NOT_FOUND', 'Unknown provider');
      const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null));
      const v = await binding.verifier.verify(req.headers, rawBody, req.now);
      if (!v.eventId) throw new DomainError('VALIDATION_FAILED', v.reason ?? 'Event id missing');
      const { duplicate, event } = await this.store.record({ provider, eventId: v.eventId, signatureOk: v.ok, payload: v.payload, receivedAt: req.now });
      if (!event.signatureOk) throw new HttpError(401, 'invalid_signature', 'Webhook signature could not be verified');
      if (!duplicate || !event.processedAt) await this.process(binding, event, req.now);
      return ok({ eventId: v.eventId, duplicate });
    });
  }

  /** Replay tool: reprocess verified events that never completed. Safe at any time. */
  async replay(options: { provider?: string; limit?: number; now: Date }): Promise<{ attempted: number; succeeded: number }> {
    const pending = await this.store.pending(options.limit ?? 100, options.provider);
    let succeeded = 0;
    for (const e of pending) {
      const binding = this.providers.get(e.provider);
      if (!binding) continue;
      if (await this.process(binding, e, options.now)) succeeded += 1;
    }
    return { attempted: pending.length, succeeded };
  }

  private async process(binding: ProviderBinding, event: InboundEvent, now: Date): Promise<boolean> {
    try {
      await binding.process(event);
      await this.store.markProcessed(event.provider, event.eventId, now);
      return true;
    } catch (e) {
      await this.store.markProcessed(event.provider, event.eventId, now, (e as Error).message.slice(0, 500));
      return false;
    }
  }
}
