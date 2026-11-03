// Crowded webhook receiver (T-0649, REQ-INS-025): POST /webhooks/crowded (also /v1/webhooks/crowded), behind
// institutions.usBanking. Crowded sends events in batches, signed over the raw bytes, at least once and in any order.
//
//   flag off                -> 404 FEATURE_OFF, nothing read or stored
//   signature not valid     -> 401, one row in ops.inbound_rejected (a hash, never the body); claims no event id
//   signature valid         -> every event in the batch is stored in ops.inbound_event as (crowded, eventId); a repeat is a
//                              no-op; the answer is 200 straight away. Nothing is re-read here: the worker's webhook-replay
//                              job calls `process` for the rows still unprocessed (RUN-05).
//
// `process` treats an event as a HINT. It takes from the body only which object the event is about, then asks the provider
// for that object's current state through the port and hands only that state to the card that owns the object (T-0650 the
// application, T-0652 collected payments, T-0653 ACH). An older event arriving after a newer one therefore changes nothing:
// both re-read the same current state. Event bodies are untrusted text: stored as JSON, never interpreted.
import { createHash } from 'node:crypto';
import { crowdedHeaderValue, crowdedRef, CROWDED_SIGNATURE_HEADER, verifyCrowdedSignature } from '@kesher/adapters';
import { DomainError } from '@kesher/domain';
import type { AchStatus, ApplicationStatus, InstitutionBankingPort } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import { HttpError, ok, route, type Handler, type HttpRequest } from '../http.ts';
import type { InboundEvent, InboundEventStore } from './store.ts';
import type { WebhookVerifier } from './verify.ts';

export const CROWDED_PROVIDER = 'crowded';
export const CROWDED_FLAG = 'institutions.usBanking';
/** More events than this in one delivery is refused whole (nothing stored). */
export const MAX_BATCH = 500;

/** What the cards that own each object do with the provider's CURRENT state. Absent means the event is stored and nothing more. */
export interface CrowdedHandlers {
  /** An application event: the entity's application, as the provider says it is now. */
  application?(entityRef: string, status: ApplicationStatus): Promise<void>;
  /** An ACH event: the payment's status, as the provider says it is now. */
  ach?(paymentRef: string, status: AchStatus): Promise<void>;
  /** A collection, payment, intent or refund event: this entity's collected payments changed, so read them with `collectPayments`. */
  collected?(entityRef: string): Promise<void>;
}

export interface CrowdedWebhookDeps {
  store: InboundEventStore;
  flags: FeatureFlags;
  /** The endpoint secret and, during a rotation, the previous one. Read on every delivery; none configured means 401. */
  secrets: () => readonly string[];
  /** Resolved when an event is processed, so an API without the capability still boots. */
  port: () => InstitutionBankingPort;
  handlers?: CrowdedHandlers;
}

/** The generic `/hooks/crowded` route must never accept a Crowded delivery: this verifier refuses everything. */
export const refuseAllVerifier: WebhookVerifier = { verify: () => ({ ok: false, eventId: '', payload: null, reason: 'Crowded deliveries go to /webhooks/crowded' }) };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);

export class CrowdedWebhook {
  private readonly d: CrowdedWebhookDeps;
  constructor(deps: CrowdedWebhookDeps) {
    this.d = deps;
  }

  handler(): Handler {
    return route(async (req: HttpRequest) => {
      if (!(await this.d.flags.isOn(CROWDED_FLAG))) throw new DomainError('FEATURE_OFF', 'US banking is not available');
      // The raw bytes are what is signed. A re-serialised body is not them, so there is no fallback to req.body.
      if (typeof req.rawBody !== 'string') throw new DomainError('VALIDATION_FAILED', 'The raw body is required');
      const failure = verifyCrowdedSignature({ header: crowdedHeaderValue(req.headers, CROWDED_SIGNATURE_HEADER), rawBody: req.rawBody, secrets: this.d.secrets() });
      if (failure) {
        const sha256 = createHash('sha256').update(req.rawBody).digest('hex');
        await this.d.store.record({ provider: CROWDED_PROVIDER, eventId: `rejected-${sha256.slice(0, 32)}`, signatureOk: false, payload: { reason: failure, bytes: Buffer.byteLength(req.rawBody), sha256 }, receivedAt: req.now });
        throw new HttpError(401, 'invalid_signature', 'Webhook signature could not be verified');
      }
      const events = parseBatch(req.rawBody);
      let stored = 0;
      for (const e of events) {
        const { duplicate } = await this.d.store.record({ provider: CROWDED_PROVIDER, eventId: e.eventId, signatureOk: true, payload: e.event, receivedAt: req.now });
        if (!duplicate) stored += 1;
      }
      return ok({ received: events.length, stored, duplicates: events.length - stored });
    });
  }

  /** Re-reads the object the event is about and hands the provider's current state to its card. Throws are recorded and retried by replay. */
  async process(event: InboundEvent): Promise<void> {
    const e = isRecord(event.payload) ? event.payload : {};
    const type = typeof e['eventType'] === 'string' ? e['eventType'] : '';
    const ctx = isRecord(e['context']) ? e['context'] : {};
    const data = isRecord(e['data']) ? e['data'] : {};
    const chapter = idOf(ctx['chapterId']) ?? idOf(data['chapterId']);
    if (!chapter) return; // nothing to re-read: stored, and that is all
    const h = this.d.handlers ?? {};
    if (type.startsWith('finance.application.')) {
      if (h.application) await h.application(chapter, await this.d.port().applicationStatus(chapter));
    } else if (type.startsWith('finance.ach_payment.')) {
      const payment = idOf(data['id']) ?? idOf(data['paymentId']);
      if (payment && h.ach) {
        const paymentRef = crowdedRef(chapter, payment);
        await h.ach(paymentRef, await this.d.port().achStatus(paymentRef));
      }
    } else if (/^collect\.(payment|collection|intent|refund)\./.test(type)) {
      if (h.collected) await h.collected(chapter);
    }
    // Anything else (platform.*, finance.transaction.created, wires, event types we do not know yet) is stored and ignored.
  }
}

/** The events of a signed delivery, or a 400 for the whole thing: a batch is accepted whole or not at all. */
function parseBatch(rawBody: string): { eventId: string; event: Record<string, unknown> }[] {
  let b: unknown;
  try {
    b = JSON.parse(rawBody);
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'The body is not JSON');
  }
  if (!isRecord(b) || !Array.isArray(b['events']) || b['events'].length === 0 || b['events'].length > MAX_BATCH) {
    throw new DomainError('VALIDATION_FAILED', `A delivery carries 1 to ${MAX_BATCH} events`);
  }
  return b['events'].map((e: unknown) => {
    if (!isRecord(e) || typeof e['eventId'] !== 'string' || e['eventId'] === '' || e['eventId'].length > 200 || typeof e['eventType'] !== 'string' || e['eventType'].length > 200) {
      throw new DomainError('VALIDATION_FAILED', 'Every event needs an eventId and an eventType');
    }
    return { eventId: e['eventId'], event: e };
  });
}
