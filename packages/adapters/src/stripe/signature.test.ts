// Stripe-Signature verification: constant-time HMAC, 5-minute tolerance, malformed headers refused.
import { describe, expect, it } from 'vitest';
import { computeStripeSignature, signStripePayload, verifyStripeSignature } from './signature.ts';

const secret = 'whsec_test_only_not_a_real_secret';
const body = '{"id":"evt_1","type":"invoice.paid"}';
const now = 1_767_225_600; // 2026-01-01T00:00:00Z

describe('verifyStripeSignature', () => {
  it('accepts a fresh, correctly signed payload', () => {
    expect(verifyStripeSignature({ header: signStripePayload(secret, body, now), rawBody: body, secret, nowSeconds: now })).toBeUndefined();
  });

  it('accepts a header with several v1 candidates when one matches (secret rotation)', () => {
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${computeStripeSignature(secret, now, body)}`;
    expect(verifyStripeSignature({ header, rawBody: body, secret, nowSeconds: now })).toBeUndefined();
  });

  it('refuses a payload signed with another secret', () => {
    expect(verifyStripeSignature({ header: signStripePayload('whsec_other', body, now), rawBody: body, secret, nowSeconds: now })).toBe('MISMATCH');
  });

  it('refuses a body that was altered after signing', () => {
    expect(verifyStripeSignature({ header: signStripePayload(secret, body, now), rawBody: body + ' ', secret, nowSeconds: now })).toBe('MISMATCH');
  });

  it('refuses a timestamp outside the 5-minute tolerance, in both directions', () => {
    expect(verifyStripeSignature({ header: signStripePayload(secret, body, now - 301), rawBody: body, secret, nowSeconds: now })).toBe('OUTSIDE_TOLERANCE');
    expect(verifyStripeSignature({ header: signStripePayload(secret, body, now + 301), rawBody: body, secret, nowSeconds: now })).toBe('OUTSIDE_TOLERANCE');
    expect(verifyStripeSignature({ header: signStripePayload(secret, body, now - 300), rawBody: body, secret, nowSeconds: now })).toBeUndefined();
  });

  it('honours a custom tolerance', () => {
    expect(verifyStripeSignature({ header: signStripePayload(secret, body, now - 20), rawBody: body, secret, nowSeconds: now, toleranceSeconds: 10 })).toBe('OUTSIDE_TOLERANCE');
  });

  it('refuses missing, malformed and forged headers', () => {
    expect(verifyStripeSignature({ header: undefined, rawBody: body, secret, nowSeconds: now })).toBe('NO_SIGNATURE');
    expect(verifyStripeSignature({ header: 'forged', rawBody: body, secret, nowSeconds: now })).toBe('MALFORMED');
    expect(verifyStripeSignature({ header: `t=${now}`, rawBody: body, secret, nowSeconds: now })).toBe('NO_SIGNATURE');
    expect(verifyStripeSignature({ header: `t=abc,v1=${computeStripeSignature(secret, now, body)}`, rawBody: body, secret, nowSeconds: now })).toBe('MALFORMED');
    expect(verifyStripeSignature({ header: `t=${now},v1=nothex`, rawBody: body, secret, nowSeconds: now })).toBe('NO_SIGNATURE');
  });
});
