// WalletProvisioningPort (REQ-CRD-006/007): in-app push provisioning to Apple Wallet / Google Pay
// (SEQ-03) and the token lifecycle. No vendor sandbox exists for the Apple side, so the simulator is
// the only automated path; the Apple Lab certification is a release gate.

export type WalletKind = 'apple' | 'google';
export type TokenStatus = 'active' | 'suspended' | 'deleted';

export interface ProvisioningPayload {
  /** Opaque, base64; forwarded to PKAddPaymentPassViewController / TapAndPay as is. Never logged. */
  encryptedPassData: string;
  activationData: string;
  ephemeralPublicKey: string;
}

export interface CardToken {
  tokenId: string;
  cardId: string;
  wallet: WalletKind;
  status: TokenStatus;
  deviceId: string;
  updatedAt: string;
}

export interface WalletProvisioningPort {
  /** Apple: certificates + nonce + nonceSignature from the iOS sheet; Google: the push token request. */
  pushProvision(input: { cardId: string; wallet: WalletKind; deviceId: string; clientData: Record<string, string> }, idempotencyKey: string): Promise<ProvisioningPayload>;
  /** Tokens on a card (drives "hide the button if already in this wallet", REQ-CRD-006). */
  listTokens(cardId: string): Promise<readonly CardToken[]>;
  /** Freeze cascade (REQ-CRD-004): suspend or resume every token on the card. */
  setTokensStatus(cardId: string, status: 'active' | 'suspended', idempotencyKey: string): Promise<readonly CardToken[]>;
  /** Parses token lifecycle webhooks (created, suspended, deleted). Duplicate ids return the same event. */
  parseTokenEvent(headers: Record<string, string>, rawBody: string): Promise<{ eventId: string; token: CardToken }>;
}

export type WalletProvisioningErrorCode = 'UNKNOWN_CARD' | 'BAD_SIGNATURE' | 'UNSUPPORTED_WALLET' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class WalletProvisioningError extends Error {
  readonly code: WalletProvisioningErrorCode;
  constructor(
    code: WalletProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'WalletProvisioningError';
  }
}
