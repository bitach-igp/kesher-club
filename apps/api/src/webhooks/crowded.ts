// Crowded webhook receiver (T-0649, REQ-INS-025): POST /webhooks/crowded (also /v1/webhooks/crowded), behind
// institutions.usBanking. Crowded sends events in batches, signed over the raw bytes, at least once and in any order.
//
//   flags off               -> 404 FEATURE_OFF, nothing read or stored (the route is open when institutions.usBanking OR wallet.enabled is on)
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
import type { Database } from '../db.ts';
import { openCase } from '../ops/cases.ts';
import { OWNER_FAILED_CASE, ownerCaseKey, SUBACCOUNT_OWNER_REF, SUBACCOUNT_REF } from '../wallet/sub-accounts.ts';
import { HttpError, ok, route, type Handler, type HttpRequest } from '../http.ts';
import type { InboundEvent, InboundEventStore } from './store.ts';
import type { WebhookVerifier } from './verify.ts';

export const CROWDED_PROVIDER = 'crowded';
export const CROWDED_FLAG = 'institutions.usBanking';
/** A member-chapter payment event is a wallet load (T-0703); the route is open for it when this flag is on. */
export const CROWDED_WALLET_FLAG = 'wallet.enabled';
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
  /**
   * A `collect.payment.*` event of the platform member chapter (T-0703): a hosted load's payment. `paymentRef` is
   * `crowded:<chapter>:<payment>`; `intentRef` is the same for the intent when the event names one. The handler re-reads the load
   * through the funding port and moves the transfer; it never takes a status from the event.
   */
  funding?(chapterId: string, paymentRef: string, intentRef?: string): Promise<void>;
}

export interface CrowdedWebhookDeps {
  store: InboundEventStore;
  flags: FeatureFlags;
  /** The endpoint secret and, during a rotation, the previous one. Read on every delivery; none configured means 401. */
  secrets: () => readonly string[];
  /** Resolved when an event is processed, so an API without the capability still boots. */
  port: () => InstitutionBankingPort;
  handlers?: CrowdedHandlers;
  /** The platform member chapter at Crowded, where hosted loads are collected (injected by T-0709). None: every payment event is an institution one. */
  memberChapterId?: string;
  /**
   * Is this chapter a member's sub-account of ours (T-0757)? Answered from ops.external_ref (`subAccountChapters`). Absent: only
   * `memberChapterId` is a member chapter. The answer is cached for `CHAPTER_CACHE_MS`, so a burst of events costs one query per chapter.
   */
  isMemberChapter?(chapterId: string): Promise<boolean>;
  /**
   * True when the sub-account's owner failed (T-0752 note): its payments are not credited blindly. The funding handler is skipped; the
   * lookup has opened (or found) the one case for staff, and the sweep through `getLoad` still sees the load once the owner is fixed.
   */
  ownerFailed?(chapterId: string): Promise<boolean>;
}

/** How long a chapter's answer is kept: long enough for one replay pass over a batch, short enough that a new sub-account is seen at once. */
export const CHAPTER_CACHE_MS = 10_000;

/**
 * The `ops.external_ref` side of the sub-account dispatch (T-0757). A chapter is a member's when a `funding_subaccount` ref of the
 * funding provider reads `s:<chapter>` or `s:<chapter>:<account>`; the match is on the chapter boundary, so `s:ab1` is not chapter `ab`,
 * and a chapter with no ref (the nonprofit's own included) is not a member chapter. No pattern matching: the chapter id is compared as text.
 */
export function subAccountChapters(db: Database, provider: string): { isMemberChapter(chapterId: string): Promise<boolean>; ownerFailed(chapterId: string, now: Date): Promise<boolean> } {
  const match = `r.entity_type = $1 and r.provider = $2 and (r.external_id = 's:' || $3::text or left(r.external_id, length($3::text) + 3) = 's:' || $3::text || ':')`;
  return {
    async isMemberChapter(chapterId) {
      const r = await db.query(`select 1 from ops.external_ref r where ${match} limit 1`, [SUBACCOUNT_REF, provider, chapterId]);
      return r.rows.length > 0;
    },
    async ownerFailed(chapterId, now) {
      const r = await db.query<{ party: string }>(
        `select r.entity_id::text as party from ops.external_ref r where ${match}
           and exists (select 1 from ops.external_ref o where o.entity_type = $4 and o.entity_id = r.entity_id and o.provider = $2 and o.external_id = 'o:' || r.entity_id::text || ':failed') limit 1`,
        [SUBACCOUNT_REF, provider, chapterId, SUBACCOUNT_OWNER_REF],
      );
      const party = r.rows[0]?.party;
      if (party === undefined) return false;
      // The same case T-0752 opened when the owner failed (same dedupe key): nothing new if it is there, one for staff if it is not.
      await openCase(db, { kind: OWNER_FAILED_CASE, dedupeKey: ownerCaseKey(party), severity: 'medium', payload: { partyId: party }, now });
      return true;
    },
  };
}

/** The generic `/hooks/crowded` route must never accept a Crowded delivery: this verifier refuses everything. */
export const refuseAllVerifier: WebhookVerifier = { verify: () => ({ ok: false, eventId: '', payload: null, reason: 'Crowded deliveries go to /webhooks/crowded' }) };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);

/**
 * What an event type is about. `payment` and `collected` (a collection, intent or refund) are the collected-payment families; `collect`
 * is any other `collect.*` type (a near-miss such as `collect.paymentx.created` included): it is never an institution event, but a
 * member chapter's still keeps it out of the institution path. `other` is everything we do not handle.
 */
export type CrowdedEventKind = 'application' | 'ach' | 'payment' | 'collected' | 'collect' | 'other';

export function classifyCrowdedEvent(type: string): CrowdedEventKind {
  if (type.startsWith('finance.application.')) return 'application';
  if (type.startsWith('finance.ach_payment.')) return 'ach';
  if (!type.startsWith('collect.')) return 'other';
  if (type.startsWith('collect.payment.')) return 'payment';
  return /^collect\.(collection|intent|refund)\./.test(type) ? 'collected' : 'collect';
}

export class CrowdedWebhook {
  private readonly d: CrowdedWebhookDeps;
  private readonly members = new Map<string, { member: boolean; at: number }>();
  constructor(deps: CrowdedWebhookDeps) {
    this.d = deps;
  }

  handler(): Handler {
    return route(async (req: HttpRequest) => {
      if (!(await this.d.flags.isOn(CROWDED_FLAG)) && !(await this.d.flags.isOn(CROWDED_WALLET_FLAG))) throw new DomainError('FEATURE_OFF', 'US banking is not available');
      // The bytes as received are what is signed (the server keeps them; a caller with only the string gets its UTF-8). A
      // re-serialised body is not them, so there is no fallback to req.body. Nothing is parsed until the signature holds.
      const bytes = req.rawBytes ?? (typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8') : undefined);
      if (!bytes) throw new DomainError('VALIDATION_FAILED', 'The raw body is required');
      const failure = verifyCrowdedSignature({ header: crowdedHeaderValue(req.headers, CROWDED_SIGNATURE_HEADER), rawBody: bytes, secrets: this.d.secrets() });
      if (failure) {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await this.d.store.record({ provider: CROWDED_PROVIDER, eventId: `rejected-${sha256.slice(0, 32)}`, signatureOk: false, payload: { reason: failure, bytes: bytes.byteLength, sha256 }, receivedAt: req.now, reason: failure });
        throw new HttpError(401, 'invalid_signature', 'Webhook signature could not be verified');
      }
      const events = parseBatch(Buffer.from(bytes).toString('utf8'));
      let stored = 0;
      for (const e of events) {
        const { duplicate } = await this.d.store.record({ provider: CROWDED_PROVIDER, eventId: e.eventId, signatureOk: true, payload: e.event, receivedAt: req.now });
        if (!duplicate) stored += 1;
      }
      return ok({ received: events.length, stored, duplicates: events.length - stored });
    });
  }

  /** The platform member chapter, or a chapter the lookup knows as a member's sub-account (cached per chapter for a short window). */
  private async isMemberChapter(chapter: string): Promise<boolean> {
    if (this.d.memberChapterId !== undefined && chapter === this.d.memberChapterId) return true;
    const lookup = this.d.isMemberChapter;
    if (!lookup) return false;
    const at = Date.now();
    const hit = this.members.get(chapter);
    if (hit && at - hit.at < CHAPTER_CACHE_MS && at >= hit.at) return hit.member;
    const member = await lookup.call(this.d, chapter);
    if (this.members.size >= 1000) this.members.clear();
    this.members.set(chapter, { member, at });
    return member;
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
    const kind = classifyCrowdedEvent(type);
    // A hosted load's payment: a member chapter's `collect.payment.*` events (the platform member chapter, or a member's own sub-account
    // chapter, T-0757) belong to the wallet, never to the institution path. The refs are built from the event's own chapter, so one
    // member's event can only name that member's loads.
    if ((kind === 'payment' || kind === 'collected' || kind === 'collect') && (await this.isMemberChapter(chapter))) {
      if (kind !== 'payment') return; // collections, intents and refunds of the member chapter: stored and ignored
      // Flag off: this throws, the row stays unprocessed and the replay job applies it once the wallet is on.
      if (!(await this.d.flags.isOn(CROWDED_WALLET_FLAG))) throw new DomainError('FEATURE_OFF', 'The wallet is not enabled yet');
      if (this.d.ownerFailed && (await this.d.ownerFailed(chapter))) return; // never credited blindly (T-0752 note): staff have the case
      const payment = idOf(data['paymentId']) ?? idOf(data['id']);
      const intent = idOf(data['intentId']);
      if (payment && h.funding) await h.funding(chapter, crowdedRef('crowded', chapter, payment), intent ? crowdedRef('crowded', chapter, intent) : undefined);
      return;
    }
    // Everything else is the institution path. With only the wallet flag on, such an event is kept unprocessed until US banking is.
    if (kind !== 'collect' && kind !== 'other' && !(await this.d.flags.isOn(CROWDED_FLAG))) throw new DomainError('FEATURE_OFF', 'US banking is not available');
    if (kind === 'application') {
      if (h.application) await h.application(chapter, await this.d.port().applicationStatus(chapter));
    } else if (kind === 'ach') {
      const payment = idOf(data['id']) ?? idOf(data['paymentId']);
      if (payment && h.ach) {
        const paymentRef = crowdedRef(chapter, payment);
        await h.ach(paymentRef, await this.d.port().achStatus(paymentRef));
      }
    } else if (kind === 'payment' || kind === 'collected') {
      if (h.collected) await h.collected(chapter);
    }
    // Anything else (platform.*, finance.transaction.created, wires, event types we do not know yet) is stored and ignored.
  }
}

/** One event larger than this is refused with its batch: a stored event is data, not a file. */
export const MAX_EVENT_BYTES = 64 * 1024;

/** The events of a signed delivery, or a 400 for the whole thing: a batch is accepted whole or not at all. */
function parseBatch(rawBody: string): { eventId: string; event: Record<string, unknown> }[] {
  let b: unknown;
  try {
    // A byte-order mark is the sender's choice and the signature already holds: it is not part of the JSON.
    b = JSON.parse(rawBody.charCodeAt(0) === 0xfeff ? rawBody.slice(1) : rawBody);
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
    // Postgres refuses a NUL in text and in jsonb, on every retry: a batch holding one would block the events behind it for ever.
    const text = JSON.stringify(e);
    if (text.includes('\\u0000')) throw new DomainError('VALIDATION_FAILED', 'An event holds a NUL character');
    if (Buffer.byteLength(text) > MAX_EVENT_BYTES) throw new DomainError('VALIDATION_FAILED', 'An event is too large');
    return { eventId: e['eventId'], event: e };
  });
}
