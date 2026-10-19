// Push provisioning and token lifecycle (T-0405, REQ-CRD-006/007). A member adds the card to Apple
// Wallet or Google Pay from the app: with a fresh step-up, the API hands the OS sheet the processor's
// provisioning payload, never card data. The wallet then creates a token at the processor, and the
// processor's token.created / token.suspended / token.deleted webhooks keep cards.card_token current,
// applied at receipt and swept by the worker within its cycle (apps/worker/src/cards/token-events.ts),
// deduped by event id. The PAN never appears: the payload is opaque material for the processor's SDK.
import { createHash } from 'node:crypto';
import { DomainError } from '@kesher/domain';
import type { CardIssuingPort } from '@kesher/ports';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import type { InboundEvent } from '../webhooks/store.ts';
import { simulatorVerifier, type WebhookVerifier } from '../webhooks/verify.ts';
import type { CardService } from './service.ts';

export const PROVISIONING_FLAG = 'card.pushProvisioning';
export const TOKEN_EVENT_PROVIDER = 'card-issuing';
export type Wallet = 'apple' | 'google';
export type TokenStatus = 'active' | 'suspended' | 'deleted';

/** The processor's payload for the OS provisioning sheet (contract: ProvisioningPayload). */
export interface ProvisioningPayload {
  encryptedPassData: string;
  activationData: string;
  ephemeralPublicKey: string;
}

/**
 * Where provisioning material comes from. CardIssuingPort does not carry push provisioning yet; the
 * processor adapter will supply this alongside the port, behind the same contract suite. Until then
 * the simulator-era source derives opaque material from the processor's short-lived details token.
 */
export interface WalletProvisioningSource {
  payload(input: { processorCardId: string; wallet: Wallet; deviceId: string; clientData: Record<string, string> }): Promise<ProvisioningPayload>;
}

export function detailsTokenProvisioning(port: CardIssuingPort): WalletProvisioningSource {
  return {
    async payload({ processorCardId, wallet, deviceId, clientData }) {
      const t = await port.showDetailsToken(processorCardId);
      const nonce = clientData['nonce'] ?? '';
      const digest = (s: string) => createHash('sha256').update(s).digest('base64url');
      return {
        encryptedPassData: Buffer.from(`${wallet}:${deviceId}:${t.token}`).toString('base64url'),
        activationData: digest(`${t.token}:${nonce}`),
        ephemeralPublicKey: digest(`${wallet}:${nonce}`),
      };
    },
  };
}

/** A processor's token lifecycle event, as the webhook router stores it. */
export interface TokenEvent {
  eventId: string;
  type: 'token.created' | 'token.suspended' | 'token.deleted';
  tokenId: string;
  /** The processor's card reference. */
  cardId: string;
  wallet: Wallet;
  deviceId: string;
}

const STATUS: Record<TokenEvent['type'], TokenStatus> = { 'token.created': 'active', 'token.suspended': 'suspended', 'token.deleted': 'deleted' };

export function parseTokenEvent(payload: unknown): TokenEvent {
  const p = payload as Partial<TokenEvent> | undefined;
  if (!p || typeof p.eventId !== 'string' || typeof p.tokenId !== 'string' || typeof p.cardId !== 'string' || typeof p.deviceId !== 'string') throw new DomainError('VALIDATION_FAILED', 'Token event lacks eventId, tokenId, cardId or deviceId');
  if (!p.type || !(p.type in STATUS)) throw new DomainError('VALIDATION_FAILED', `Unknown token event type ${String(p.type)}`);
  if (p.wallet !== 'apple' && p.wallet !== 'google') throw new DomainError('VALIDATION_FAILED', 'wallet must be apple or google');
  return { eventId: p.eventId, type: p.type, tokenId: p.tokenId, cardId: p.cardId, wallet: p.wallet, deviceId: p.deviceId };
}

export class ProvisioningService {
  private readonly db: Database;
  private readonly cards: CardService;
  private readonly source: WalletProvisioningSource;
  private readonly flags: FeatureFlags;
  constructor(
    db: Database,
    cards: CardService,
    source: WalletProvisioningSource,
    flags: FeatureFlags,
  ) {
    this.db = db;
    this.cards = cards;
    this.source = source;
    this.flags = flags;
  }

  /**
   * The payload for the OS sheet. Owner only, flag on, card active, and not for a device that already
   * holds a live token for this card in this wallet (ALREADY_PROVISIONED). The step-up check is the
   * handler's (REQ-AUTH-006). Nothing is stored: the token arrives by webhook once the wallet made it.
   */
  async start(partyId: string, cardId: string, wallet: Wallet, deviceId: string, clientData: Record<string, string>): Promise<ProvisioningPayload> {
    if (!(await this.flags.isOn(PROVISIONING_FLAG, { partyId }))) throw new DomainError('FEATURE_OFF', 'Adding the card to a wallet is not enabled yet');
    if (wallet !== 'apple' && wallet !== 'google') throw new DomainError('VALIDATION_FAILED', 'wallet must be apple or google');
    if (!deviceId.trim() || deviceId.length > 200) throw new DomainError('VALIDATION_FAILED', 'deviceId is required');
    const who = await this.cards.actorFor(partyId, cardId);
    if (!who || who.by !== 'member') throw new DomainError('NOT_FOUND', 'Card not found');
    if (who.card.status !== 'active') throw new DomainError('VALIDATION_FAILED', `A ${who.card.status} card cannot be added to a wallet`);
    const held = await this.db.query(`select 1 from cards.card_token where card_id = $1 and wallet = $2 and device_id = $3 and status = 'active' limit 1`, [cardId, wallet, deviceId]);
    if (held.rows.length) throw new DomainError('IDEMPOTENCY_CONFLICT', 'ALREADY_PROVISIONED: this device already holds a token for this card', { reason: 'ALREADY_PROVISIONED' });
    return this.source.payload({ processorCardId: who.card.processor_card_id, wallet, deviceId, clientData });
  }

  /**
   * Applies one lifecycle event to cards.card_token. Idempotent by event id: a row already stamped
   * with this event changes nothing; an event for a card we do not know fails so replay retries it.
   */
  async applyTokenEvent(event: InboundEvent, now: Date): Promise<{ tokenId: string; status: TokenStatus; applied: boolean }> {
    const e = parseTokenEvent(event.payload);
    const card = await this.db.query<{ id: string }>(`select id from cards.card where processor_card_id = $1`, [e.cardId]);
    if (!card.rows[0]) throw new DomainError('NOT_FOUND', `Token event for an unknown card`);
    const status = STATUS[e.type];
    const r = await this.db.query<{ status: TokenStatus }>(
      `insert into cards.card_token (token_id, card_id, wallet, device_id, status, last_event_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (token_id) do update set status = excluded.status, device_id = excluded.device_id, last_event_id = excluded.last_event_id, updated_at = excluded.updated_at
         where cards.card_token.last_event_id is distinct from excluded.last_event_id
       returning status`,
      [e.tokenId, card.rows[0].id, e.wallet, e.deviceId, status, e.eventId, now],
    );
    return { tokenId: e.tokenId, status, applied: r.rows.length > 0 };
  }

  /** The webhook verifier for the processor's token events: the simulator's convention in sim mode; otherwise the adapter supplies one. */
  static verifier(mode: string | undefined, adapterVerifier?: WebhookVerifier): WebhookVerifier {
    if (adapterVerifier) return adapterVerifier;
    if (mode === 'sim') return simulatorVerifier;
    // Fail closed: no verifier means no verified event, never an unverified write.
    return { verify: (_h, rawBody) => ({ ok: false, eventId: '', payload: rawBody, reason: 'no verifier bound for the card processor' }) };
  }
}
