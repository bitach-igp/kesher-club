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

// Fixed vectors. The expected signatures below were computed OUTSIDE this code base, with node's crypto and (cross-checked) with
// openssl, from Stripe's documented construction: HMAC-SHA256 hex of `${t}.${rawBody}` keyed by the webhook secret.
// Recompute:
//   node -e "console.log(require('crypto').createHmac('sha256','whsec_vector_secret_A').update('1767225600.'+BODY).digest('hex'))"
//   printf '1767225600.%s' "$BODY" | openssl dgst -sha256 -hmac whsec_vector_secret_A -hex
// They deliberately do not call computeStripeSignature/signStripePayload, so a change to the signed payload fails here.
describe('verifyStripeSignature fixed vectors', () => {
  const vSecret = 'whsec_vector_secret_A';
  const vBody = '{"id":"evt_vec_1","object":"event","type":"invoice.paid"}';
  const t = 1_767_225_600;
  const V1 = '4eb2ac31565ce4ccdfacc3ab69a85da1e806d7a7d9eaa7c04a733aea8fd1ae53'; // HMAC(A, `${t}.${vBody}`)
  const V1_BODY_ONLY = '6c9dbfca06c04567f73198ce3fd7fc6d0aab5049e9c83511f742e09e7adb2167'; // HMAC(A, vBody): no timestamp
  const V1_OTHER_SECRET = '4aa7dd9dc65a6d9e798986e405a81efbea6c8e4abfbca47bdba7c619856bda08'; // HMAC('whsec_vector_secret_B', `${t}.${vBody}`)
  const BAD = 'f'.repeat(64);
  const ok = (header: string, nowSeconds = t, rawBody = vBody, s = vSecret) => verifyStripeSignature({ header, rawBody, secret: s, nowSeconds });

  it('accepts the vector inside tolerance, with the clock on either side', () => {
    expect(ok(`t=${t},v1=${V1}`)).toBeUndefined();
    expect(ok(`t=${t},v1=${V1}`, t + 300)).toBeUndefined();
    expect(ok(`t=${t},v1=${V1}`, t - 300)).toBeUndefined();
  });

  it('refuses the vector at 301 s, in both directions', () => {
    expect(ok(`t=${t},v1=${V1}`, t + 301)).toBe('OUTSIDE_TOLERANCE');
    expect(ok(`t=${t},v1=${V1}`, t - 301)).toBe('OUTSIDE_TOLERANCE');
  });

  it('refuses when the header timestamp is changed but the v1 is kept', () => {
    expect(ok(`t=${t + 1},v1=${V1}`, t + 1)).toBe('MISMATCH');
    expect(ok(`t=${t - 1},v1=${V1}`, t - 1)).toBe('MISMATCH');
  });

  it('refuses a v1 computed over the body alone, without the timestamp', () => {
    expect(ok(`t=${t},v1=${V1_BODY_ONLY}`)).toBe('MISMATCH');
  });

  it('refuses when one byte of the body changes', () => {
    expect(ok(`t=${t},v1=${V1}`, t, vBody.replace('evt_vec_1', 'evt_vec_2'))).toBe('MISMATCH');
    expect(ok(`t=${t},v1=${V1}`, t, `${vBody}\n`)).toBe('MISMATCH');
  });

  it('refuses when the secret differs, and refuses a signature made with another secret', () => {
    expect(ok(`t=${t},v1=${V1}`, t, vBody, 'whsec_vector_secret_B')).toBe('MISMATCH');
    expect(ok(`t=${t},v1=${V1_OTHER_SECRET}`)).toBe('MISMATCH');
  });

  it('refuses a one-nibble corruption of the vector', () => {
    const flipped = `${V1.slice(0, 63)}${V1.endsWith('3') ? '4' : '3'}`;
    expect(ok(`t=${t},v1=${flipped}`)).toBe('MISMATCH');
  });

  it('a short but valid-hex v1 is refused as no signature and does not throw', () => {
    expect(ok(`t=${t},v1=abcd`)).toBe('NO_SIGNATURE');
    expect(ok(`t=${t},v1=${V1.slice(0, 32)}`)).toBe('NO_SIGNATURE');
    expect(ok(`t=${t},v1=${V1}ab`)).toBe('NO_SIGNATURE');
  });

  it('accepts an uppercase-hex v1 (the verifier lower-cases candidates on purpose)', () => {
    expect(ok(`t=${t},v1=${V1.toUpperCase()}`)).toBeUndefined();
  });

  describe('several v1 values (secret rotation): any one valid value verifies, wherever it sits', () => {
    it('valid first, invalid second', () => {
      expect(ok(`t=${t},v1=${V1},v1=${BAD}`)).toBeUndefined();
    });
    it('invalid first, valid last', () => {
      expect(ok(`t=${t},v1=${BAD},v1=${V1}`)).toBeUndefined();
    });
    it('both invalid', () => {
      expect(ok(`t=${t},v1=${BAD},v1=${V1_OTHER_SECRET}`)).toBe('MISMATCH');
    });
    it('a valid one in the middle of three', () => {
      expect(ok(`t=${t},v1=${BAD},v1=${V1},v1=${V1_OTHER_SECRET}`)).toBeUndefined();
    });
    it('t may follow the v1 values', () => {
      expect(ok(`v1=${BAD},v1=${V1},t=${t}`)).toBeUndefined();
    });
    it('a valid v1 among others is still subject to the tolerance', () => {
      expect(ok(`t=${t},v1=${BAD},v1=${V1}`, t + 301)).toBe('OUTSIDE_TOLERANCE');
    });
  });
});

// An empty secret is a key anyone can sign with, so the verifier must refuse it whatever the header says, rather than rely on
// its caller to have checked (apps/api config requires non-empty secrets, and the adapter constructors refuse an empty one).
// The signatures below were computed outside this code base, as above, with the empty key:
//   node -e "console.log(require('crypto').createHmac('sha256','').update('1767225600.'+BODY).digest('hex'))"
//   printf '1767225600.%s' "$BODY" | openssl dgst -sha256 -hmac '' -hex
describe('verifyStripeSignature with an empty secret', () => {
  const eBody = '{"id":"evt_empty_1","object":"event","type":"invoice.paid"}';
  const t = 1_767_225_600;
  const EMPTY_KEY_SIG = 'c99b0a3e46038af202e26ace7c4a494c287d66e1f480791c51600584b9186bef'; // HMAC('', `${t}.${eBody}`)
  const verify = (header: string | undefined, secret: string) => verifyStripeSignature({ header, rawBody: eBody, secret, nowSeconds: t });

  it('refuses a delivery signed with the empty key', () => {
    expect(verify(`t=${t},v1=${EMPTY_KEY_SIG}`, '')).toBe('MISMATCH');
  });

  it('refuses it whatever the header looks like', () => {
    expect(verify(`t=${t},v1=${EMPTY_KEY_SIG},v1=${'0'.repeat(64)}`, '')).toBe('MISMATCH');
    expect(verify(`t=${t},v1=${'0'.repeat(64)}`, '')).toBe('MISMATCH');
    expect(verify(`v1=${EMPTY_KEY_SIG},t=${t}`, '')).toBe('MISMATCH');
    expect(verify(`t=${t},v1=${EMPTY_KEY_SIG.toUpperCase()}`, '')).toBe('MISMATCH');
    expect(verify(`t=${t}`, '')).toBe('MISMATCH');
    expect(verify('forged', '')).toBe('MISMATCH');
    expect(verify(undefined, '')).toBe('MISMATCH');
  });

  it('refuses it even when the timestamp is far outside the tolerance', () => {
    expect(verifyStripeSignature({ header: `t=${t},v1=${EMPTY_KEY_SIG}`, rawBody: eBody, secret: '', nowSeconds: t + 10_000 })).toBe('MISMATCH');
  });

  it('still accepts a non-empty secret, and the empty-key signature does not verify under one', () => {
    const real = 'whsec_vector_secret_A';
    const REAL_SIG = '4eb2ac31565ce4ccdfacc3ab69a85da1e806d7a7d9eaa7c04a733aea8fd1ae53'; // HMAC(real, `${t}.{"id":"evt_vec_1",...}`)
    const vBody = '{"id":"evt_vec_1","object":"event","type":"invoice.paid"}';
    expect(verifyStripeSignature({ header: `t=${t},v1=${REAL_SIG}`, rawBody: vBody, secret: real, nowSeconds: t })).toBeUndefined();
    expect(verify(`t=${t},v1=${EMPTY_KEY_SIG}`, real)).toBe('MISMATCH');
  });
});
