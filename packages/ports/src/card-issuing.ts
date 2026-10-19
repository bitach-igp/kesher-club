// CardIssuingPort (REQ-CRD-001..005, 008, 009): outbound card lifecycle and the inbound JIT
// authorisation path (SEQ-01). PAN/CVV never cross this port (REQ-CRD-002): the PCI component
// is rendered by the processor from a short-lived `showDetailsToken`.
import type { Money } from '@kesher/domain';

export type CardType = 'virtual' | 'physical';
export type CardStatus = 'inactive' | 'active' | 'frozen' | 'closed';

export interface CardControls {
  /** Rolling daily spend cap, in the card's currency. */
  dailyLimit?: Money;
  monthlyLimit?: Money;
  blockedMccs: readonly string[];
  allowedCountries?: readonly string[];
  atm: boolean;
  online: boolean;
  /** Parent setting for agent purchases (REQ-CRD-008). */
  agentPurchases: 'off' | 'with_approval' | { underMinor: bigint };
}

export interface Card {
  cardId: string;
  cardholderId: string;
  type: CardType;
  status: CardStatus;
  last4: string;
  currency: 'USD';
  controls: CardControls;
  /** Physical only. */
  shipping?: { trackingUrl?: string; activatedAt?: string };
}

export interface JitAuthorizationRequest {
  authId: string;
  cardId: string;
  amount: Money;
  merchant: { name: string; mcc: string; country: string };
  channel: 'pos' | 'online' | 'atm';
  /** Device token id when a wallet token paid (REQ-CRD-004 cascades freezes to tokens). */
  tokenId?: string;
  /** Set when an agentic token initiated the purchase (REQ-CRD-008). */
  agentic?: boolean;
  receivedAt: string;
}

export type JitDecision = { approve: true; holdAmount: Money } | { approve: false; reason: 'CARD_FROZEN' | 'INSUFFICIENT_FUNDS' | 'LIMIT_EXCEEDED' | 'MCC_BLOCKED' | 'COUNTRY_BLOCKED' | 'CHANNEL_BLOCKED' | 'AGENT_NOT_ALLOWED' | 'TIMEOUT' | 'UNKNOWN_CARD' };

export interface CardIssuingPort {
  createCardholder(input: { partyId: string; kycSessionId: string }, idempotencyKey: string): Promise<{ cardholderId: string }>;
  /** Virtual cards must be active within 60 s of KYC approval (REQ-CRD-001). */
  issueCard(input: { cardholderId: string; type: CardType; controls: CardControls; shipTo?: { country: 'US' | 'IL' } }, idempotencyKey: string): Promise<Card>;
  setStatus(cardId: string, status: Exclude<CardStatus, 'inactive'>, idempotencyKey: string): Promise<Card>;
  updateControls(cardId: string, controls: CardControls, idempotencyKey: string): Promise<Card>;
  getCard(cardId: string): Promise<Card>;
  /** Short-lived token for the processor's PCI iframe / SDK; never the PAN. */
  showDetailsToken(cardId: string): Promise<{ token: string; expiresAt: string }>;
  /** Physical: activate on delivery with last4 + PIN set at the processor (REQ-CRD-009). */
  activate(cardId: string, input: { last4: string }, idempotencyKey: string): Promise<Card>;
  /** Inbound: verify the processor's signature and parse the JIT request (SEQ-01). */
  parseAuthorization(headers: Record<string, string>, rawBody: string): Promise<JitAuthorizationRequest>;
  /** Encodes our decision in the processor's response format. */
  encodeDecision(decision: JitDecision): { status: number; body: unknown };
}

export type CardIssuingErrorCode = 'UNKNOWN_CARD' | 'UNKNOWN_CARDHOLDER' | 'INVALID_STATE' | 'BAD_SIGNATURE' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class CardIssuingError extends Error {
  readonly code: CardIssuingErrorCode;
  constructor(
    code: CardIssuingErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'CardIssuingError';
  }
}
