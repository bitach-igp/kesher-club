// Stripe webhook signatures (https://docs.stripe.com/webhooks#verify-manually).
//   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>[,v1=...]
// Verification is constant-time and refuses timestamps outside the tolerance window (replay guard).
// Secrets and bodies are never logged; errors carry no secret material.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailure = 'MALFORMED' | 'NO_SIGNATURE' | 'MISMATCH' | 'OUTSIDE_TOLERANCE';

export function computeStripeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** Builds a header exactly as Stripe would. Used by fakes and tests, and by nothing in production. */
export function signStripePayload(secret: string, rawBody: string, timestamp: number): string {
  return `t=${timestamp},v1=${computeStripeSignature(secret, timestamp, rawBody)}`;
}

export interface VerifyInput {
  header: string | undefined;
  rawBody: string;
  secret: string;
  /** Unix seconds "now"; injected so tests can drive the tolerance window. */
  nowSeconds: number;
  toleranceSeconds?: number;
}

/** Returns the failure reason, or `undefined` when the signature is valid and fresh. */
export function verifyStripeSignature(input: VerifyInput): SignatureFailure | undefined {
  const { header, rawBody, secret, nowSeconds } = input;
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!header) return 'NO_SIGNATURE';
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = /^\d+$/.test(v) ? Number(v) : undefined;
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) candidates.push(v.toLowerCase());
  }
  if (timestamp === undefined) return 'MALFORMED';
  if (candidates.length === 0) return 'NO_SIGNATURE';
  const expected = Buffer.from(computeStripeSignature(secret, timestamp, rawBody), 'hex');
  const matched = candidates.some((c) => timingSafeEqual(Buffer.from(c, 'hex'), expected));
  if (!matched) return 'MISMATCH';
  if (Math.abs(nowSeconds - timestamp) > tolerance) return 'OUTSIDE_TOLERANCE';
  return undefined;
}

/** Header lookup that ignores case (Node lower-cases, test fixtures may not). */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}
