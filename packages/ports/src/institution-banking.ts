// InstitutionBankingPort (T-0647, REQ-INS-022..026): an institution's own US nonprofit account ("American Friends
// of …") held at a provider, behind `institutions.usBanking`. The provider holds the institution's money, never a
// member's balance. The port links the entity through the provider's hosted application, bills US funders on the
// provider's payment page, sends an ACH credit to Kesher's US collection account, reads the account's transactions,
// and verifies the provider's webhooks. Which provider sits behind it is Crowded first (docs/vendors/crowded);
// until its adapter exists the simulator stands in (ports before vendors).
//
// Everything is USD in bigint minor units. A provider's own ids come back as `*Ref` strings for ops.external_ref,
// never a column of their own. The account number is never returned: only its last four digits. Names, emails,
// mobiles, descriptions and event bodies are untrusted text, shown as text and never interpreted.
import type { Money } from '@kesher/domain';

export type ApplicationStatus = 'pending' | 'approved' | 'rejected' | 'needs_info';
export type CollectedPaymentStatus = 'paid' | 'declined' | 'refunded';
export type AchStatus = 'pending' | 'sent' | 'settled' | 'returned' | 'rejected' | 'cancelled';

export interface Funder {
  name: string;
  email: string;
  mobile: string;
}

export interface CollectedPayment {
  paymentRef: string;
  intentRef: string;
  collectionRef: string;
  amount: Money;
  status: CollectedPaymentStatus;
  paidAt: Date;
}

export interface BankTransaction {
  transactionRef: string;
  kind: 'credit' | 'debit';
  /** Always positive; `kind` carries the direction. */
  amount: Money;
  postedAt: Date;
  /** The provider's free text. Untrusted. */
  description: string;
}

/** One webhook event. Hints only: the caller re-reads the object through the port and acts on its current state. */
export interface InboundEvent {
  eventId: string;
  type: string;
  /** The provider's id of the object the event is about, where it names one. */
  objectRef?: string;
  occurredAt: string;
}

export type WebhookResult = { events: InboundEvent[] } | { rejected: 'BAD_SIGNATURE' | 'MALFORMED' };

export interface InstitutionBankingPort {
  /** Creates the provider entity for an institution, once per key. A reused key with another body is IDEMPOTENCY_CONFLICT. */
  createEntity(input: { institutionId: string; legalName: string; ein: string; idempotencyKey: string }): Promise<{ entityRef: string }>;
  /** Opens the provider's hosted application (the bank's own KYB of the US entity) for the applicant at this IP. */
  startApplication(input: { entityRef: string; applicantIp: string }): Promise<{ formUrl: string }>;
  applicationStatus(entityRef: string): Promise<ApplicationStatus>;
  /** The account of an approved entity. Last four digits only. */
  account(entityRef: string): Promise<{ accountRef: string; balance: Money; last4: string }>;
  /** A fee billed to funders. Needs an approved entity. */
  createCollection(input: { entityRef: string; title: string; amount: Money; idempotencyKey: string }): Promise<{ collectionRef: string }>;
  /** A payment page for one funder of a collection, once per key. */
  createPaymentPage(input: { collectionRef: string; funder: Funder; idempotencyKey: string }): Promise<{ intentRef: string; paymentUrl: string }>;
  /** Payments collected since a time, across pages, each exactly once. */
  collectPayments(input: { entityRef: string; since: Date }): AsyncIterable<CollectedPayment>;
  /** What an ACH credit of this amount would cost and when it would arrive (YYYY-MM-DD). */
  quoteAch(input: { entityRef: string; amount: Money }): Promise<{ fee: Money; arrivesOn: string }>;
  /** Sends an ACH credit to a counterparty. `addenda` is at most 80 printable ASCII characters and carries our KC- reference. */
  sendAch(input: { entityRef: string; counterpartyRef: string; amount: Money; addenda: string; idempotencyKey: string }): Promise<{ paymentRef: string; status: AchStatus }>;
  achStatus(paymentRef: string): Promise<AchStatus>;
  /** Cancels a payment that has not been sent. NOT_CANCELLABLE once it has. */
  cancelAch(paymentRef: string): Promise<AchStatus>;
  /** The account's transactions between two times, across pages, each exactly once. */
  transactions(input: { entityRef: string; from: Date; to: Date }): AsyncIterable<BankTransaction>;
  /**
   * Verifies the signature over the raw body and splits the batch. A bad signature or body is a rejection, not an
   * exception. A duplicate event id inside a batch is passed through: ops.inbound_event dedupes by (provider, eventId).
   */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<WebhookResult>;
}

export type InstitutionBankingErrorCode =
  | 'VALIDATION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'NOT_APPROVED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_CANCELLABLE'
  | 'REJECTED';

export class InstitutionBankingError extends Error {
  readonly code: InstitutionBankingErrorCode;
  constructor(
    code: InstitutionBankingErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'InstitutionBankingError';
  }
}

/** The longest ACH addenda: 80 printable ASCII characters. */
export const ADDENDA_MAX = 80;
export const isAddenda = (s: string): boolean => s.length <= ADDENDA_MAX && /^[\x20-\x7E]*$/.test(s);

/** The port speaks USD only; anything else is refused before the provider is called. */
export function requireUsd(amount: Money, what = 'amount'): void {
  if (amount.currency !== 'USD') throw new InstitutionBankingError('VALIDATION_FAILED', `${what} must be USD`);
  if (amount.minor <= 0n) throw new InstitutionBankingError('VALIDATION_FAILED', `${what} must be positive`);
}
