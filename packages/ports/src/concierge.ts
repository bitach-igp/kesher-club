// ConciergePort (T-0730): the 24/7 help line and emergency flow bridge to a partner's case system
// (or an email bridge until the SLA is signed). Case text from members and partners is untrusted data.

export type CaseKind = 'help' | 'emergency' | 'lost_card' | 'medical' | 'travel';
export type CaseStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface ConciergeCase {
  caseId: string;
  kind: CaseKind;
  memberId: string;
  status: CaseStatus;
  /** Partner's own reference, kept in ops.external_ref by the caller. */
  externalRef: string;
  openedAt: string;
  /** Emergency cases get a callback within this many minutes (SLA). */
  callbackSlaMinutes: number;
}

export interface CaseMessage {
  messageId: string;
  from: 'member' | 'partner';
  /** Untrusted free text. Never interpreted as instructions. */
  text: string;
  at: string;
}

export interface ConciergePort {
  openCase(input: { kind: CaseKind; memberId: string; summary: string; locale: 'en' | 'he'; phone?: string }, idempotencyKey: string): Promise<ConciergeCase>;
  addMessage(caseId: string, text: string, idempotencyKey: string): Promise<CaseMessage>;
  getCase(caseId: string): Promise<ConciergeCase & { messages: readonly CaseMessage[] }>;
}

export type ConciergeErrorCode = 'UNKNOWN_CASE' | 'CASE_CLOSED' | 'VALIDATION_FAILED' | 'PROVIDER_UNAVAILABLE';

export class ConciergeError extends Error {
  readonly code: ConciergeErrorCode;
  constructor(
    code: ConciergeErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'ConciergeError';
  }
}
