// Token lifecycle sweep (T-0405, REQ-CRD-007): the API applies the processor's token.created /
// token.suspended / token.deleted webhooks at receipt; this job runs every cycle and applies anything
// that is still pending (a failure at receipt, a card recorded after its first event) so every token
// row is current within 60 s. Deduped by event id end to end: the inbound store keeps one row per
// (provider, event id) and the token row remembers the last event it applied.
import type { InboundEvent, InboundEventStore } from '@kesher/api/webhooks/store';

export const CYCLE_MS = 30_000;
export const SLA_MS = 60_000;
export const PROVIDER = 'card-issuing';

export interface TokenEventsReport {
  ranAt: string;
  attempted: number;
  applied: number;
  failed: { eventId: string; error: string }[];
  /** Age of the oldest still-pending event after the run, in ms; over SLA_MS pages (RUN-05). */
  lagMs: number;
  withinSla: boolean;
}

export class TokenEventsJob {
  private readonly store: InboundEventStore;
  private readonly apply: (event: InboundEvent, now: Date) => Promise<unknown>;
  private readonly clock: () => Date;
  private readonly batch: number;
  constructor(
    store: InboundEventStore,
    apply: (event: InboundEvent, now: Date) => Promise<unknown>,
    clock: () => Date = () => new Date(),
    batch = 200,
  ) {
    this.store = store;
    this.apply = apply;
    this.clock = clock;
    this.batch = batch;
  }

  async run(): Promise<TokenEventsReport> {
    const now = this.clock();
    const pending = await this.store.pending(this.batch, PROVIDER);
    let applied = 0;
    const failed: TokenEventsReport['failed'] = [];
    for (const e of pending) {
      try {
        await this.apply(e, now);
        await this.store.markProcessed(e.provider, e.eventId, now);
        applied += 1;
      } catch (err) {
        const error = (err as Error).message.slice(0, 500);
        await this.store.markProcessed(e.provider, e.eventId, now, error);
        failed.push({ eventId: e.eventId, error });
      }
    }
    const left = await this.store.pending(1, PROVIDER);
    const lagMs = left[0] ? now.getTime() - new Date(left[0].receivedAt).getTime() : 0;
    return { ranAt: now.toISOString(), attempted: pending.length, applied, failed, lagMs, withinSla: lagMs <= SLA_MS };
  }
}
