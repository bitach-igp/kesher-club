// Closed error-code set (Tab 3 §5). Every code maps to an HTTP status and an i18n copy key.

export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  STEP_UP_REQUIRED: 401,
  RECOVERY_HOLD: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  INSUFFICIENT_FUNDS: 422,
  LIMIT_EXCEEDED: 422,
  QUOTE_EXPIRED: 409,
  CARD_FROZEN: 422,
  FEATURE_OFF: 404,
  PROVIDER_UNAVAILABLE: 503,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  AGENT_NOT_ALLOWED: 403,
  UNBALANCED: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = 'DomainError';
  }

  /** RFC 9457 problem+json body. */
  toProblem(traceId: string) {
    return {
      type: `https://api.kesher.example/errors/${this.code.toLowerCase().replace(/_/g, '-')}`,
      title: this.code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
      status: ERROR_CODES[this.code],
      code: this.code,
      detail: this.message,
      traceId,
      ...this.extra,
    };
  }
}
