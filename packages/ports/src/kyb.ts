// KybPort (T-0622, REQ-INS-011, ADR-017): what an institution's registry, tax-exempt standing and sanctions
// screening say. In Israel that is the Registrar of Amutot / Companies and ניהול תקין; in the US, the
// Secretary of State, the IRS (Pub 78 / master file / auto-revocation) and OFAC. It has three read-only calls;
// the same question gets the same answer, so no idempotency keys are needed. Results carry the provider's
// reference as evidence and never a document, an image or a date of birth: only the names we sent come back.

export type KybMarket = 'US' | 'IL';

export interface EntityLookup {
  found: boolean;
  /** `active`: registered and in good standing; anything else blocks a KYB approval. */
  status: 'active' | 'inactive' | 'struck_off' | 'unknown';
  /** The name the register holds, for the own-name checks (identifier match, payout account). */
  registeredName?: string;
  /** The register's name matches the name given, after normalising case, spacing and punctuation. */
  nameMatches: boolean;
  entityType?: 'amuta' | 'public_benefit_company' | 'company' | 'nonprofit_corporation' | 'other';
  /** Where the evidence is kept at the provider. */
  reference: string;
}

export interface ExemptStatus {
  /**
   * The outcome:
   * - `shown`: ניהול תקין for the current or prior year, or the IRS lists the organisation as exempt.
   * - `not_found`: no record.
   * - `revoked`: auto-revoked, or the approval withdrawn.
   */
  status: 'shown' | 'not_found' | 'revoked';
  /** US: absent from IRS data in a way a church-integrated school would be; compliance decides (M4). */
  possibleChurch?: boolean;
  /** IL: the latest year of ניהול תקין on record. */
  properManagementYear?: number;
  reference: string;
}

export interface ScreeningMatch {
  kind: 'sanctions' | 'pep';
  /** For example `OFAC SDN`, `UN`, `NBCTF`, `PEP`. */
  list: string;
  /** 0 to 1: how close the listed name is; the provider's threshold already applied. */
  score: number;
  reference: string;
}

export interface ScreeningResult {
  name: string;
  matches: readonly ScreeningMatch[];
}

export interface KybPort {
  /** The register's entry for an amuta / חל"צ number (IL) or an EIN (US). */
  lookupEntity(input: { market: KybMarket; identifier: string; name: string }): Promise<EntityLookup>;
  exemptStatus(input: { market: KybMarket; identifier: string }): Promise<ExemptStatus>;
  /** One result per name, in the order given. */
  screen(input: { names: readonly string[] }): Promise<readonly ScreeningResult[]>;
}

export type KybErrorCode = 'INVALID_IDENTIFIER' | 'PROVIDER_UNAVAILABLE';

export class KybError extends Error {
  readonly code: KybErrorCode;
  constructor(code: KybErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'KybError';
  }
}

/** The shape of an identifier for its market: an amuta (58…) or company (51…) number, or an EIN. */
export function validKybIdentifier(market: KybMarket, identifier: string): boolean {
  return market === 'IL' ? /^5[18]\d{7}$/.test(identifier) : /^\d{2}-?\d{7}$/.test(identifier);
}
