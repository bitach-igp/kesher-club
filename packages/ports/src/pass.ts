// PassPort (flag wallet.pass): the club pass in Apple Wallet / Google Wallet (membership, perks,
// emergency numbers). Not a payment card; no PAN anywhere near it.

export type PassPlatform = 'apple' | 'google';

export interface ClubPass {
  passId: string;
  platform: PassPlatform;
  memberId: string;
  /** Signed .pkpass download or Google Wallet save link. Short-lived. */
  url: string;
  version: number;
  fields: Record<string, string>;
}

export interface PassPort {
  create(input: { platform: PassPlatform; memberId: string; fields: Record<string, string> }, idempotencyKey: string): Promise<ClubPass>;
  /** Bumps the version and pushes an update to installed passes. */
  update(passId: string, fields: Record<string, string>, idempotencyKey: string): Promise<ClubPass>;
  get(passId: string): Promise<ClubPass>;
}

export type PassErrorCode = 'UNKNOWN_PASS' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class PassError extends Error {
  constructor(
    readonly code: PassErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PassError';
  }
}
