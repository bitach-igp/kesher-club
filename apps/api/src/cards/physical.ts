// Physical cards (T-0407, REQ-CRD-009): order to a US or Israeli address, track the shipment, activate
// in-app with the last four digits under a fresh step-up, and set the PIN at the processor. We record
// the card like any other (cards.card, status inactive until activation) and keep nothing about the
// shipment or the PIN: the address goes to the processor once, tracking and the activation stamp are
// read back from it, and the PIN is set inside the processor's SDK so it never reaches this API.
import { DomainError, uuidv7 } from '@kesher/domain';
import { CardIssuingError, type Card, type CardIssuingPort } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import type { KycService } from '../kyc/service.ts';
import { controlsToWire, DEFAULT_VIRTUAL_CONTROLS, type CardService, type CardView } from './service.ts';

export const PHYSICAL_FLAG = 'card.physical';
/** last_event_id marker on tokens deleted because the card was closed (lost, stolen, damaged). */
export const CLOSE_MARKER = 'card.closed';
export type CloseReason = 'lost' | 'stolen' | 'damaged' | 'other';
export const physicalWorkflowId = (partyId: string, idempotencyKey: string): string => `card-physical:${partyId}:${idempotencyKey}`;

export interface ShipTo {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: 'US' | 'IL';
}

export interface Shipping {
  trackingUrl?: string;
  activatedAt?: string;
  /** The PIN is set at the processor during activation; we record only that it was. */
  pinSet: boolean;
}

export type PhysicalCardView = CardView & { shipping?: Shipping };

const LAST4 = /^\d{4}$/;
const text = (v: unknown, what: string, max: number, required = true): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new DomainError('VALIDATION_FAILED', `shipTo.${what} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) throw new DomainError('VALIDATION_FAILED', `shipTo.${what} must be text up to ${max} characters`);
  return v.trim();
};

/** Validates the address the member typed; the API forwards it to the processor and never stores it. */
export function parseShipTo(input: unknown): ShipTo {
  const b = (input ?? {}) as Record<string, unknown>;
  if (b['country'] !== 'US' && b['country'] !== 'IL') throw new DomainError('VALIDATION_FAILED', 'shipTo.country must be US or IL');
  const line2 = text(b['line2'], 'line2', 120, false);
  const region = text(b['region'], 'region', 60, b['country'] === 'US');
  return {
    name: text(b['name'], 'name', 120)!,
    line1: text(b['line1'], 'line1', 120)!,
    ...(line2 ? { line2 } : {}),
    city: text(b['city'], 'city', 80)!,
    ...(region ? { region } : {}),
    postalCode: text(b['postalCode'], 'postalCode', 16)!,
    country: b['country'],
  };
}

interface Row {
  id: string;
  party_id: string;
  processor_card_id: string;
  type: 'virtual' | 'physical';
  status: 'inactive' | 'active' | 'frozen' | 'closed';
  workflow_id: string;
}

export class PhysicalCardService {
  constructor(
    private readonly db: Database,
    private readonly port: CardIssuingPort,
    private readonly kyc: KycService,
    private readonly cards: CardService,
    private readonly flags: FeatureFlags,
    private readonly processor = 'simulator',
  ) {}

  /**
   * Orders one physical card for the member: flag on, T2 approved, a valid US or IL address, and no
   * physical card already on its way or in use. Idempotent by key: the same key returns the card the
   * first call ordered. The card arrives inactive; activation makes it active.
   */
  async order(partyId: string, shipTo: ShipTo, idempotencyKey: string, now: Date): Promise<PhysicalCardView> {
    if (!(await this.flags.isOn(PHYSICAL_FLAG, { partyId }))) throw new DomainError('FEATURE_OFF', 'Physical cards are not available yet');
    const wf = physicalWorkflowId(partyId, idempotencyKey);
    const same = await this.db.query<Row>(`select * from cards.card where workflow_id = $1`, [wf]);
    if (same.rows[0]) return this.view(same.rows[0].id, partyId);
    await this.kyc.requireApproved(partyId, 'T2');
    const open = await this.db.query<Row>(`select * from cards.card where party_id = $1 and type = 'physical' and status in ('inactive', 'active', 'frozen') limit 1`, [partyId]);
    if (open.rows[0]) throw new DomainError('IDEMPOTENCY_CONFLICT', 'A physical card is already on its way or in use; freeze and replace it instead');
    const cardholder = await this.db.query<{ cardholder_id: string }>(`select cardholder_id from cards.card where party_id = $1 order by issued_at desc limit 1`, [partyId]);
    const approved = await this.db.query<{ session_id: string }>(`select session_id from identity.kyc_session where party_id = $1 and tier = 'T2' and status = 'approved' order by decided_at desc limit 1`, [partyId]);
    const cardholderId = cardholder.rows[0]?.cardholder_id ?? (await this.provider(() => this.port.createCardholder({ partyId, kycSessionId: approved.rows[0]!.session_id }, `${wf}:cardholder`))).cardholderId;
    // The port carries the shipping country today; the processor adapter takes the full address alongside it.
    const card = await this.provider(() => this.port.issueCard({ cardholderId, type: 'physical', controls: DEFAULT_VIRTUAL_CONTROLS, shipTo: { country: shipTo.country } }, `${wf}:card`));
    const r = await this.db.query<Row>(
      `insert into cards.card (id, party_id, processor, processor_card_id, cardholder_id, type, status, last4, currency, controls, locked_by_funder, workflow_id, issued_at, updated_at)
       values ($1, $2, $3, $4, $5, 'physical', $6, $7, $8, $9, '{}', $10, $11, $11)
       on conflict (workflow_id) do update set updated_at = cards.card.updated_at
       returning *`,
      [uuidv7(now), partyId, this.processor, card.cardId, card.cardholderId, card.status, card.last4, card.currency, JSON.stringify(controlsToWire(card.controls)), wf, now],
    );
    return this.view(r.rows[0]!.id, partyId, card);
  }

  /** Activation on delivery: owner only, the last four digits must match, a fresh step-up is the handler's check. */
  async activate(partyId: string, cardId: string, last4: string, idempotencyKey: string, now: Date): Promise<PhysicalCardView> {
    if (!LAST4.test(last4)) throw new DomainError('VALIDATION_FAILED', 'last4 must be four digits');
    const r = await this.db.query<Row>(`select * from cards.card where id = $1 and party_id = $2`, [cardId, partyId]);
    const row = r.rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Card not found');
    if (row.type !== 'physical') throw new DomainError('VALIDATION_FAILED', 'Only a physical card is activated');
    if (row.status === 'active') return this.view(cardId, partyId);
    if (row.status !== 'inactive') throw new DomainError('VALIDATION_FAILED', `A ${row.status} card cannot be activated`);
    const card = await this.provider(() => this.port.activate(row.processor_card_id, { last4 }, idempotencyKey));
    await this.db.query(`update cards.card set status = $2, updated_at = $3 where id = $1`, [cardId, card.status, now]);
    return this.view(cardId, partyId, card);
  }

  /**
   * Lost, stolen or damaged: closes the card at the processor and here, deletes every wallet token,
   * and frees the member to order a replacement. Final; a closed card never reopens. Owner only.
   */
  async close(partyId: string, cardId: string, reason: CloseReason, idempotencyKey: string, now: Date): Promise<PhysicalCardView> {
    const r = await this.db.query<Row>(`select * from cards.card where id = $1 and party_id = $2`, [cardId, partyId]);
    const row = r.rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Card not found');
    if (row.status === 'closed') return this.view(cardId, partyId);
    const card = await this.provider(() => this.port.setStatus(row.processor_card_id, 'closed', idempotencyKey));
    await this.db.transaction(async (tx) => {
      await tx.query(`update cards.card set status = 'closed', updated_at = $2 where id = $1`, [cardId, now]);
      await tx.query(`update cards.card_token set status = 'deleted', last_event_id = $2, updated_at = $3 where card_id = $1 and status <> 'deleted'`, [cardId, `${CLOSE_MARKER}:${reason}`, now]);
    });
    return this.view(cardId, partyId, card);
  }

  /** The card view plus, for a physical card, what the processor knows about the shipment and activation. */
  async view(cardId: string, partyId: string, fromProcessor?: Card): Promise<PhysicalCardView> {
    const base = await this.cards.getCard(partyId, cardId);
    if (!base) throw new DomainError('NOT_FOUND', 'Card not found');
    if (base.type !== 'physical') return base;
    const row = (await this.db.query<Row>(`select * from cards.card where id = $1`, [cardId])).rows[0]!;
    const card = fromProcessor ?? (await this.provider(() => this.port.getCard(row.processor_card_id)));
    return { ...base, shipping: { ...(card.shipping?.trackingUrl ? { trackingUrl: card.shipping.trackingUrl } : {}), ...(card.shipping?.activatedAt ? { activatedAt: card.shipping.activatedAt } : {}), pinSet: Boolean(card.shipping?.activatedAt) } };
  }

  private async provider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CardIssuingError) {
        if (e.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('PROVIDER_UNAVAILABLE', 'The card processor is unavailable right now');
        if (e.code === 'VALIDATION_FAILED' || e.code === 'INVALID_STATE') throw new DomainError('VALIDATION_FAILED', e.message);
        if (e.code === 'UNKNOWN_CARD' || e.code === 'UNKNOWN_CARDHOLDER') throw new DomainError('NOT_FOUND', 'Card not found at the processor');
      }
      throw e;
    }
  }
}
