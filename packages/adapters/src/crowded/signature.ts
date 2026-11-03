// Crowded webhook signature (T-0649, REQ-INS-025): `X-Webhook-Signature: sha256=<hex>`, the HMAC-SHA256 of the RAW request
// bytes under the endpoint secret. Verified before any JSON parse, in constant time. Crowded sends no timestamp, so there is
// no replay window: deduplicating by event id is the replay defence. Two secret slots let a rotation overlap (the current one and
// the previous one both verify); with none configured, nothing verifies.
//
// The docs also show the receiver hashing JSON.stringify(parsed body). That would make a re-serialised body verify, so we
// verify the raw bytes, which is what the provider signs if it follows its own header description (question 10 in the vendor
// notes). If Crowded answers otherwise, the change is here and nowhere else.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CROWDED_SIGNATURE_HEADER = 'x-webhook-signature';

export type CrowdedSignatureFailure = 'NO_SIGNATURE' | 'MALFORMED' | 'MISMATCH';

const bytes = (b: string | Uint8Array): Uint8Array => (typeof b === 'string' ? Buffer.from(b, 'utf8') : b);

/** `sha256=<hex>` over the raw bytes. */
export function computeCrowdedSignature(secret: string, rawBody: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(bytes(rawBody)).digest('hex')}`;
}

export interface VerifyCrowdedInput {
  header: string | undefined;
  rawBody: string | Uint8Array;
  /** The current secret and, during a rotation, the previous one. Empty strings are ignored. */
  secrets: readonly string[];
}

/** Undefined when the signature is good; otherwise why not. Every configured secret is tried, with no early exit. */
export function verifyCrowdedSignature(input: VerifyCrowdedInput): CrowdedSignatureFailure | undefined {
  if (input.header === undefined || input.header.trim() === '') return 'NO_SIGNATURE';
  const m = /^sha256=([0-9a-f]{64})$/i.exec(input.header.trim());
  if (!m) return 'MALFORMED';
  const given = Buffer.from(m[1]!, 'hex');
  let ok = false;
  for (const secret of input.secrets) {
    if (!secret) continue;
    const expected = createHmac('sha256', secret).update(bytes(input.rawBody)).digest();
    if (timingSafeEqual(expected, given)) ok = true;
  }
  return ok ? undefined : 'MISMATCH';
}

/** A header's value, whatever its case. */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}
