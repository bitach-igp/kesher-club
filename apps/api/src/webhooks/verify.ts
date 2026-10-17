// Webhook verification (T-0204, THR-02). Each provider registers a verifier: signature +
// timestamp check and the event id extraction. Port adapters supply the vendor-specific parse;
// this file holds the generic HMAC-SHA256 verifier most vendors use, with a replay window.
import { createHmac, timingSafeEqual } from 'node:crypto';

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

export interface HmacVerifierOptions {
  /** Current secret and, during rotation, the previous one. */
  secrets: readonly string[];
  /** Header carrying the signature, e.g. `stripe-signature`, `webhook-signature`, `x-sim-signature`. */
  signatureHeader: string;
  /** Builds the signed string from (headers, body); default: the raw body. */
  signedPayload?: (headers: Record<string, string>, rawBody: string) => string;
  /** Extracts the hex/base64 signature(s) from the header value. */
  parseSignature?: (headerValue: string) => string[];
  encoding?: 'hex' | 'base64';
  /** Header with a unix-seconds timestamp; when set, messages older than `toleranceSec` are rejected. */
  timestampHeader?: string;
  toleranceSec?: number;
  eventId: (payload: unknown, headers: Record<string, string>) => string | undefined;
}

export function hmacVerifier(opts: HmacVerifierOptions): WebhookVerifier {
  const encoding = opts.encoding ?? 'hex';
  const parse = opts.parseSignature ?? ((v) => [v.trim()]);
  const signed = opts.signedPayload ?? ((_h, body) => body);
  return {
    verify(headers, rawBody, now) {
      const h = lower(headers);
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return { ok: false, eventId: '', payload: undefined, reason: 'malformed json' };
      }
      const eventId = opts.eventId(payload, h) ?? '';
      if (!eventId) return { ok: false, eventId, payload, reason: 'missing event id' };
      if (opts.timestampHeader) {
        const ts = Number(h[opts.timestampHeader] ?? NaN);
        if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > (opts.toleranceSec ?? 300)) return { ok: false, eventId, payload, reason: 'timestamp outside tolerance' };
      }
      const given = h[opts.signatureHeader];
      if (!given) return { ok: false, eventId, payload, reason: 'missing signature' };
      const candidates = parse(given).map((s) => Buffer.from(s, encoding));
      const data = signed(h, rawBody);
      for (const secret of opts.secrets) {
        const expected = createHmac('sha256', secret).update(data).digest();
        if (candidates.some((c) => c.length === expected.length && timingSafeEqual(c, expected))) return { ok: true, eventId, payload };
      }
      return { ok: false, eventId, payload, reason: 'bad signature' };
    },
  };
}

/** Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64> …`, secret `whsec_<base64>`. */
export function standardWebhooksVerifier(secrets: readonly string[]): WebhookVerifier {
  return hmacVerifier({
    secrets: secrets.map((s) => (s.startsWith('whsec_') ? Buffer.from(s.slice(6), 'base64').toString('latin1') : s)),
    signatureHeader: 'webhook-signature',
    timestampHeader: 'webhook-timestamp',
    encoding: 'base64',
    parseSignature: (v) => v.split(/\s+/).filter((p) => p.startsWith('v1,')).map((p) => p.slice(3)),
    signedPayload: (h, body) => `${h['webhook-id']}.${h['webhook-timestamp']}.${body}`,
    eventId: (_p, h) => h['webhook-id'],
  });
}

/** Stripe: `stripe-signature: t=<ts>,v1=<hex>`, signed `${t}.${body}`. */
export function stripeVerifier(secrets: readonly string[]): WebhookVerifier {
  const fields = (v: string) => Object.fromEntries(v.split(',').map((kv) => kv.split('=') as [string, string]));
  return hmacVerifier({
    secrets,
    signatureHeader: 'stripe-signature',
    parseSignature: (v) => [fields(v)['v1'] ?? ''],
    signedPayload: (h, body) => `${fields(h['stripe-signature'] ?? '')['t']}.${body}`,
    eventId: (p) => (p as { id?: string })?.id,
  });
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
