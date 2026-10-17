// Cards (T-0402, REQ-CRD-001/002; T-0404, REQ-CRD-004/005) over CardIssuingPort. A virtual card is issued by one workflow per
// party, `card-issue:{partyId}`, within 60 s of the T2 approval that unlocks it; the worker hosts the
// workflow (apps/worker/src/cards/issue-workflow.ts) and this service is its activities, each
// idempotent by the key it receives. Reads return status, controls and wallet tokens; the PAN, CVV and
// expiry are never here. Card details reach the app only as the processor's short-lived token.
import { DomainError, fromWire, toWire, uuidv7, type Money } from '@kesher/domain';
import { CardIssuingError, type Card, type CardControls, type CardIssuingPort, type CardStatus, type CardType } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import type { KycService } from '../kyc/service.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import { applyPatch, type Actor, type ControlsPatch } from './controls.ts';

export const ISSUE_FLAG = 'card.virtual';
/** last_event_id markers on cards.card_token for the freeze cascade (REQ-CRD-004). */
export const FREEZE_MARKER = 'card.frozen';
export const UNFREEZE_MARKER = 'card.unfrozen';
export const ISSUE_SLA_MS = 60_000;
export const issueWorkflowId = (partyId: string): string => `card-issue:${partyId}`;

/** CardControls on the wire (contracts/openapi.yaml CardControls): money as strings, agent mode as an object. */
export interface WireControls {
  dailyLimit?: { minor: string; currency: string };
  monthlyLimit?: { minor: string; currency: string };
  blockedMccs: string[];
  allowedCountries?: string[];
  atm: boolean;
  online: boolean;
  agentPurchases: { mode: 'off' | 'with_approval' | 'under_amount'; underAmount?: { minor: string; currency: string } };
}

export interface CardView {
  id: string;
  type: CardType;
  status: CardStatus;
  last4: string;
  controls: WireControls;
  lockedByFunder: string[];
  tokens: { wallet: 'apple' | 'google'; status: 'active' | 'suspended' | 'deleted'; deviceId: string }[];
}

/** What the issue workflow carries between its activities and reports back. */
export interface IssuedCard {
  id: string;
  processorCardId: string;
  status: CardStatus;
  last4: string;
  issuedAt: string;
}

export const DEFAULT_VIRTUAL_CONTROLS: CardControls = { blockedMccs: [], atm: false, online: true, agentPurchases: 'off' };

export function controlsToWire(c: CardControls): WireControls {
  return {
    ...(c.dailyLimit ? { dailyLimit: toWire(c.dailyLimit) } : {}),
    ...(c.monthlyLimit ? { monthlyLimit: toWire(c.monthlyLimit) } : {}),
    blockedMccs: [...c.blockedMccs],
    ...(c.allowedCountries ? { allowedCountries: [...c.allowedCountries] } : {}),
    atm: c.atm,
    online: c.online,
    agentPurchases: c.agentPurchases === 'off' || c.agentPurchases === 'with_approval' ? { mode: c.agentPurchases } : { mode: 'under_amount', underAmount: toWire({ minor: c.agentPurchases.underMinor, currency: 'USD' }) },
  };
}

export function controlsFromWire(w: WireControls): CardControls {
  const agent = w.agentPurchases;
  const agentPurchases: CardControls['agentPurchases'] = agent.mode === 'under_amount' ? { underMinor: fromWire(agent.underAmount ?? { minor: '0', currency: 'USD' }).minor } : agent.mode;
  return {
    ...(w.dailyLimit ? { dailyLimit: fromWire(w.dailyLimit) } : {}),
    ...(w.monthlyLimit ? { monthlyLimit: fromWire(w.monthlyLimit) } : {}),
    blockedMccs: [...w.blockedMccs],
    ...(w.allowedCountries ? { allowedCountries: [...w.allowedCountries] } : {}),
    atm: w.atm,
    online: w.online,
    agentPurchases,
  };
}

interface Row {
  id: string;
  party_id: string;
  processor_card_id: string;
  type: CardType;
  status: CardStatus;
  last4: string;
  controls: WireControls;
  locked_by_funder: string[];
  issued_at: string | Date;
}

const iso = (v: string | Date): string => new Date(v).toISOString();

export class CardService {
  constructor(
    private readonly db: Database,
    private readonly port: CardIssuingPort,
    private readonly kyc: KycService,
    private readonly flags: FeatureFlags,
    private readonly processor = 'simulator',
  ) {}

  // ---- activities (each idempotent by its key) ---------------------------------------------------

  /** Flag on and T2 approved, or no card. Returns the existing card when the workflow already ran. */
  async eligibility(partyId: string): Promise<{ kycSessionId: string; existing?: IssuedCard }> {
    if (!(await this.flags.isOn(ISSUE_FLAG, { partyId }))) throw new DomainError('FEATURE_OFF', 'Virtual cards are not enabled yet');
    const status = await this.kyc.status(partyId);
    if (status.approvedTier !== 'T2') throw new DomainError('FORBIDDEN', 'A virtual card needs T2 identity verification');
    const approvedSession = await this.db.query<{ session_id: string }>(`select session_id from identity.kyc_session where party_id = $1 and tier = 'T2' and status = 'approved' order by decided_at desc limit 1`, [partyId]);
    const existing = await this.db.query<Row>(`select * from cards.card where workflow_id = $1`, [issueWorkflowId(partyId)]);
    return { kycSessionId: approvedSession.rows[0]!.session_id, ...(existing.rows[0] ? { existing: issued(existing.rows[0]) } : {}) };
  }

  async createCardholder(partyId: string, kycSessionId: string, key: string): Promise<{ cardholderId: string }> {
    return this.provider(() => this.port.createCardholder({ partyId, kycSessionId }, key));
  }

  async issueCard(cardholderId: string, key: string, type: CardType = 'virtual', controls: CardControls = DEFAULT_VIRTUAL_CONTROLS, shipTo?: { country: 'US' | 'IL' }): Promise<Card> {
    return this.provider(() => this.port.issueCard({ cardholderId, type, controls, ...(shipTo ? { shipTo } : {}) }, key));
  }

  /** Writes our record once per workflow; a rerun returns the row the first run wrote. */
  async recordCard(partyId: string, card: Card, workflowId: string, now: Date): Promise<IssuedCard> {
    const r = await this.db.query<Row>(
      `insert into cards.card (id, party_id, processor, processor_card_id, cardholder_id, type, status, last4, currency, controls, locked_by_funder, workflow_id, issued_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}', $11, $12, $12)
       on conflict (workflow_id) do update set updated_at = cards.card.updated_at
       returning *`,
      [uuidv7(now), partyId, this.processor, card.cardId, card.cardholderId, card.type, card.status, card.last4, card.currency, JSON.stringify(controlsToWire(card.controls)), workflowId, now],
    );
    return issued(r.rows[0]!);
  }

  // ---- the workflow body, for the API-side trigger (the worker runs the same steps) -----------------

  async issueVirtual(partyId: string, now: Date): Promise<IssuedCard> {
    const wf = issueWorkflowId(partyId);
    const e = await this.eligibility(partyId);
    if (e.existing) return e.existing;
    const { cardholderId } = await this.createCardholder(partyId, e.kycSessionId, `${wf}:cardholder`);
    const card = await this.issueCard(cardholderId, `${wf}:card`);
    return this.recordCard(partyId, card, wf, now);
  }

  /** The KYC webhook's second step: a T2 approval issues the card while the flag is on. Flag off is not an error. */
  async onKycDecision(event: InboundEvent, now: Date): Promise<IssuedCard | undefined> {
    const d = event.payload as { sessionId?: string; status?: string; tier?: string };
    if (d?.status !== 'approved' || d.tier !== 'T2' || typeof d.sessionId !== 'string') return undefined;
    if (!(await this.flags.isOn(ISSUE_FLAG))) return undefined;
    const party = await this.db.query<{ party_id: string }>(`select party_id from identity.kyc_session where session_id = $1`, [d.sessionId]);
    if (!party.rows[0]) return undefined;
    return this.issueVirtual(party.rows[0].party_id, now);
  }

  // ---- reads ---------------------------------------------------------------------------------

  async getCard(partyId: string, cardId: string): Promise<CardView | undefined> {
    const r = await this.db.query<Row>(`select * from cards.card where id = $1 and party_id = $2`, [cardId, partyId]);
    return r.rows[0] ? this.view(r.rows[0]) : undefined;
  }

  async forParty(partyId: string): Promise<CardView[]> {
    const r = await this.db.query<Row>(`select * from cards.card where party_id = $1 order by issued_at desc`, [partyId]);
    return Promise.all(r.rows.map((x) => this.view(x)));
  }

  /** The processor's short-lived token for its PCI component. Returned to the owner, never stored or logged. */
  async detailsToken(partyId: string, cardId: string): Promise<{ token: string; expiresAt: string }> {
    const r = await this.db.query<Row>(`select * from cards.card where id = $1 and party_id = $2`, [cardId, partyId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Card not found');
    if (r.rows[0].status === 'closed') throw new DomainError('VALIDATION_FAILED', 'Card is closed');
    return this.provider(() => this.port.showDetailsToken(r.rows[0]!.processor_card_id));
  }

  // ---- controls and status (T-0404) ----------------------------------------------------------

  /** The member who owns the card, or the funder of that member's membership (REQ-CRD-005). */
  async actorFor(partyId: string, cardId: string): Promise<{ card: Row; by: Actor } | undefined> {
    const r = await this.db.query<Row>(`select * from cards.card where id = $1`, [cardId]);
    const card = r.rows[0];
    if (!card) return undefined;
    if (card.party_id === partyId) return { card, by: 'member' };
    const funder = await this.db.query(`select 1 from billing.membership where member_party_id = $1 and funder_party_id = $2 and status <> 'cancelled' limit 1`, [card.party_id, partyId]);
    return funder.rows.length ? { card, by: 'funder' } : undefined;
  }

  /** Applies a patch for the member or the funder, tells the processor, records the result. Idempotent by key. */
  async updateControls(partyId: string, cardId: string, patch: ControlsPatch, idempotencyKey: string, now: Date): Promise<CardView> {
    const who = await this.actorFor(partyId, cardId);
    if (!who) throw new DomainError('NOT_FOUND', 'Card not found');
    if (who.card.status === 'closed') throw new DomainError('VALIDATION_FAILED', 'Card is closed');
    const applied = applyPatch(controlsFromWire(who.card.controls), who.card.locked_by_funder, patch, who.by);
    const card = await this.provider(() => this.port.updateControls(who.card.processor_card_id, applied.controls, idempotencyKey));
    const r = await this.db.query<Row>(`update cards.card set controls = $2, locked_by_funder = $3, updated_at = $4 where id = $1 returning *`, [cardId, JSON.stringify(controlsToWire(card.controls)), applied.lockedByFunder, now]);
    return this.view(r.rows[0]!);
  }

  /**
   * Freeze or unfreeze (REQ-CRD-004). A freeze reaches the processor, our record, and every active
   * wallet token, which is suspended under the marker `card.frozen`; an unfreeze revives only the
   * tokens that marker suspended, never one the processor or the wallet suspended on its own.
   */
  async setStatus(partyId: string, cardId: string, status: 'frozen' | 'active', idempotencyKey: string, now: Date): Promise<CardView> {
    const who = await this.actorFor(partyId, cardId);
    if (!who) throw new DomainError('NOT_FOUND', 'Card not found');
    if (who.card.status === 'closed' || who.card.status === 'inactive') throw new DomainError('VALIDATION_FAILED', `A ${who.card.status} card cannot be ${status === 'frozen' ? 'frozen' : 'unfrozen'}`);
    if (who.card.status === status) return this.view(who.card);
    const card = await this.provider(() => this.port.setStatus(who.card.processor_card_id, status, idempotencyKey));
    return this.db.transaction(async (tx) => {
      const r = await tx.query<Row>(`update cards.card set status = $2, updated_at = $3 where id = $1 returning *`, [cardId, card.status, now]);
      if (status === 'frozen') await tx.query(`update cards.card_token set status = 'suspended', last_event_id = $2, updated_at = $3 where card_id = $1 and status = 'active'`, [cardId, FREEZE_MARKER, now]);
      else await tx.query(`update cards.card_token set status = 'active', last_event_id = $2, updated_at = $3 where card_id = $1 and status = 'suspended' and last_event_id = $4`, [cardId, UNFREEZE_MARKER, now, FREEZE_MARKER]);
      return this.view(r.rows[0]!, tx);
    });
  }

  private async view(r: Row, db: Pick<Database, 'query'> = this.db): Promise<CardView> {
    const tokens = await db.query<{ wallet: 'apple' | 'google'; status: 'active' | 'suspended' | 'deleted'; device_id: string }>(`select wallet, status, device_id from cards.card_token where card_id = $1 order by token_id`, [r.id]);
    return { id: r.id, type: r.type, status: r.status, last4: r.last4, controls: r.controls, lockedByFunder: r.locked_by_funder, tokens: tokens.rows.map((t) => ({ wallet: t.wallet, status: t.status, deviceId: t.device_id })) };
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

const issued = (r: Row): IssuedCard => ({ id: r.id, processorCardId: r.processor_card_id, status: r.status, last4: r.last4, issuedAt: iso(r.issued_at) });

export type { Money };
