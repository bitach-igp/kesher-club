// Webhook verification (T-0204, THR-02). Each provider registers a verifier: signature +
// timestamp check and the event id extraction. The vendor-specific check lives in the port adapters (Stripe's
// `verifyStripeSignature` with its 5-minute tolerance, Crowded's `verifyCrowdedSignature`); this file holds the
// verifier contract and the simulators' verifier. The generic HMAC, Standard Webhooks and Stripe verifiers were
// bound nowhere, had real defects (no replay window, one `v1`, a corrupted `whsec_` key) and were deleted (T-0781).

export interface Verified {
  ok: boolean;
  eventId: string;
  /** Parsed payload, only trusted when ok. */
  payload: unknown;
  reason?: string;
}

export interface WebhookVerifier {
  verify(headers: Record<string, string>, rawBody: string, now: Date): Promise<Verified> | Verified;
}

/** The simulators' `x-sim-signature: sim` convention; only bindable in sim mode. */
export const simulatorVerifier: WebhookVerifier = {
  verify(headers, rawBody) {
    const h = lower(headers);
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { ok: false, eventId: '', payload: undefined, reason: 'malformed json' };
    }
    const eventId = (payload as { eventId?: string; id?: string })?.eventId ?? (payload as { id?: string })?.id ?? '';
    if (!eventId) return { ok: false, eventId, payload, reason: 'missing event id' };
    return h['x-sim-signature'] === 'sim' ? { ok: true, eventId, payload } : { ok: false, eventId, payload, reason: 'bad signature' };
  },
};

const lower = (h: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
