// KycPort: identity verification by the issuer's KYC provider (SEQ-05). We never store KYC images;
// only the provider's session reference is kept (constitution art. 9). Future: presentMdoc() behind kyc.mdl.

export type KycTier = 'T1' | 'T2';
export type KycStatus = 'pending' | 'approved' | 'rejected' | 'review';

export interface KycSession {
  sessionId: string;
  /** Short-lived token the mobile SDK uses to start the capture flow. Never logged. */
  clientToken: string;
  tier: KycTier;
  expiresAt: string;
}

export interface KycDecision {
  sessionId: string;
  status: KycStatus;
  tier: KycTier;
  /** Provider reason codes, no PII. */
  reasons: readonly string[];
  decidedAt?: string;
}

export interface KycPort {
  /** Idempotent by key: a second start for the same party+tier returns the same session. */
  start(input: { partyId: string; tier: KycTier; market: 'US' | 'IL' }, idempotencyKey: string): Promise<KycSession>;
  getDecision(sessionId: string): Promise<KycDecision>;
  /** Parses a provider webhook into a decision; duplicate event ids return the same decision. */
  parseWebhook(headers: Record<string, string>, body: unknown): Promise<KycDecision & { eventId: string }>;
}

export type KycErrorCode = 'UNKNOWN_SESSION' | 'BAD_SIGNATURE' | 'PROVIDER_UNAVAILABLE';

export class KycError extends Error {
  constructor(
    readonly code: KycErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KycError';
  }
}
