// InsurancePort (REQ-INSR-001): supplemental cover via Cover Genius XCover. The checkout must show the
// licensed entity, the policy wording link and the commission disclosure before payment; the port
// returns them with every quote so no screen can omit them.
import type { Money } from '@kesher/domain';

export interface InsuranceDisclosures {
  licensedEntity: string;
  policyWordingUrl: string;
  commissionDisclosure: string;
}

export interface InsuranceQuote {
  quoteId: string;
  product: string;
  premium: Money;
  /** Our commission, part of the premium (REQ-MKT-001 posts it to fee_income). */
  commission: Money;
  coverageSummary: readonly string[];
  disclosures: InsuranceDisclosures;
  expiresAt: string;
}

export interface Policy {
  policyId: string;
  quoteId: string;
  status: 'active' | 'cancelled';
  startsAt: string;
  endsAt: string;
  certificateUrl: string;
}

export interface InsurancePort {
  quote(input: { product: string; memberId: string; market: 'US' | 'IL'; startsAt: string; days: number }): Promise<InsuranceQuote>;
  /** Binds a quote into a policy. Idempotent by key. */
  bind(quoteId: string, idempotencyKey: string): Promise<Policy>;
  cancel(policyId: string, idempotencyKey: string): Promise<Policy>;
  getPolicy(policyId: string): Promise<Policy>;
}

export type InsuranceErrorCode = 'UNKNOWN_PRODUCT' | 'UNKNOWN_QUOTE' | 'UNKNOWN_POLICY' | 'QUOTE_EXPIRED' | 'INVALID_STATE' | 'PROVIDER_UNAVAILABLE';

export class InsuranceError extends Error {
  readonly code: InsuranceErrorCode;
  constructor(
    code: InsuranceErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'InsuranceError';
  }
}
